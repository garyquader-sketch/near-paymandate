import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { productionServer } from './production-server.mjs';

const token = () => randomBytes(32).toString('hex');
const fixture = new URL('../../../examples/invoices/valid.txt', import.meta.url);

test('isolated production API survives parallel uploads and service restart', { timeout: 60_000 }, async context => {
  const dir = await mkdtemp(join(tmpdir(), 'paymandate-runtime-'));
  const secret = token();
  let server;
  try {
    server = await productionServer(dir, secret);
    const { url, request } = server;
    const browserHeaders = { 'X-PayMandate-Request': 'workspace' };
    const bearer = { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' };
    const post = body => request('/api/workspace', { method: 'POST', headers: bearer, body: JSON.stringify(body) });
    const anon = await request('/api/workspace');
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('cache-control'), /no-store/);
    const invalidSite = await request('/api/workspace', { headers: { ...bearer, Origin: 'https://external.example' } });
    assert.equal(invalidSite.status, 403);
    const preflight = await request('/api/workspace', { method: 'OPTIONS', headers: {
      Origin: 'https://external.example', 'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-paymandate-request',
    } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    const sessions = await request('/api/workspace/session', {
      method: 'POST', headers: { ...browserHeaders, Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }),
    });
    assert.equal(sessions.status, 200);
    const cookie = sessions.headers.get('set-cookie').split(';', 1)[0];
    assert.equal((await request('/api/workspace', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await request('/api/workspace', { headers: { ...browserHeaders, Cookie: cookie } })).status, 200);
    assert.equal((await (await request('/api/workspace/session', { headers: { Cookie: cookie } })).json()).unlocked, false);
    assert.equal((await (await request('/api/workspace/session', { headers: { ...browserHeaders, Cookie: cookie } })).json()).unlocked, true);
    assert.equal((await request('/api/workspace/session', { method: 'DELETE', headers: { Cookie: cookie } })).status, 403);

    assert.equal((await post({ action: 'upload', filename: 'too-big.txt', data: Buffer.alloc(32_769, 65).toString('base64') })).status, 400);
    assert.equal((await post({ action: 'upload', filename: 'encoding.txt', data: Buffer.from([0xc3, 0x28]).toString('base64') })).status, 422);
    const text = await readFile(fixture, 'utf8');
    const payloads = Array.from({ length: 12 }, (_, index) => {
      const bytes = Buffer.from(text.replace('NS-1042', 'LOAD-' + index));
      return {
        bytes, hash: createHash('sha256').update(bytes).digest('hex'),
        body: { action: 'upload', filename: 'load.txt', data: bytes.toString('base64') },
      };
    });
    const times = [];
    const responses = await Promise.all(Array.from({ length: 48 }, (_, index) => {
      const payload = payloads[index % payloads.length];
      return (async () => {
        const started = performance.now();
        const response = await post(payload.body);
        assert.equal(response.status, 200);
        const invoice = await response.json();
        times.push(performance.now() - started);
        assert.equal(invoice.hash, payload.hash);
        return invoice;
      })();
    }));
    assert.equal(new Set(responses.map(invoice => invoice.id)).size, 12);
    const sorted = times.sort((a, b) => a - b);
    context.diagnostic('48 parallel uploads; 12 unique records; p95 ' + sorted[Math.ceil(.95 * sorted.length) - 1].toFixed(1) + ' ms');
    assert.equal((await (await request('/api/workspace', { headers: bearer })).json()).invoices.length, 12);
    assert.equal((await post({ action: 'execute', mandate: 'example', scenario: 'valid' })).status, 409);

    const { port } = server;
    await server.stop();
    server = await productionServer(dir, secret, port);
    assert.equal((await server.request('/api/workspace', { headers: { ...browserHeaders, Cookie: cookie } })).status, 401);
    const stored = await (await server.request('/api/workspace', { headers: bearer })).json();
    assert.equal(stored.invoices.length, 12);
    assert.equal(stored.attempts.length, 0);
  } finally {
    await server?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('packaged WASM has the contract ABI and only NEAR host imports', async () => {
  const wasm = await readFile(new URL('../../../artifacts/paymandate.wasm', import.meta.url));
  const module = new WebAssembly.Module(wasm);
  const exports = WebAssembly.Module.exports(module);
  const methods = exports.filter(item => item.kind === 'function').map(item => item.name);
  for (const name of ['new', 'fund', 'approve_mandate', 'cancel_mandate', 'execute_mandate', 'settle', 'get_config', 'get_mandate', 'list_mandates']) {
    assert.ok(methods.includes(name), name);
  }
  const imports = WebAssembly.Module.imports(module);
  assert.ok(imports.length > 0);
  assert.ok(imports.every(item => item.module === 'env' && item.kind === 'function'));
});
