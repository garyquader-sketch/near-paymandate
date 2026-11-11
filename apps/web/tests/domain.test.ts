import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { accountId, fromYocto, possibleDuplicate, toYocto } from '../src/lib/domain.ts';
import { analyzeInvoice, parseDemo } from '../src/lib/invoice.ts';

const fixture = (file: string) => readFile(new URL('../../../examples/invoices/' + file, import.meta.url));

test('yoctoNEAR conversions preserve the final decimal place', () => {
  const source = '12345.000000000000000000000001';
  assert.equal(fromYocto(toYocto(source)), source);
  assert.equal(toYocto('0.000000000000000000000001'), '1');
});

test('rejects zero, precision overflow, exponents, negatives and invalid accounts', () => {
  for (const amount of ['0', '0.0', '1e4', '-2', '1.0000000000000000000000001']) {
    assert.throws(() => toYocto(amount));
  }
  for (const invalid of ['Vendor.testnet', 'a..testnet', 'vendor.testnet.', 'a']) {
    assert.equal(accountId.safeParse(invalid).success, false);
  }
});

test('demo extraction preserves fields and hashes original bytes including BOM and CRLF', async () => {
  const original = await fixture('valid.txt');
  const bytes = Buffer.from('\uFEFF' + original.toString().replace(/\r?\n/g, '\r\n'));
  const result = await analyzeInvoice(bytes, 'invoice.txt', '');
  assert.equal(result.hash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.mode, 'demo');
  assert.equal(result.fields?.recipient, 'vendor.example.testnet');
  assert.equal(result.fields?.amount, '0.01');
  assert.deepEqual(result.warnings, []);
});

test('injected free text raises a warning and leaves the labeled recipient intact', async () => {
  const result = await analyzeInvoice(await fixture('injection.txt'), 'invoice.txt', '');
  assert.equal(result.fields?.recipient, 'vendor.example.testnet');
  assert.equal(result.warnings.length, 1);
});

test('ambiguous labels fail and incomplete invoices remain available for manual review', async () => {
  const text = (await fixture('valid.txt')).toString();
  assert.throws(() => parseDemo(text + '\nRecipient: unverified.testnet'), /Duplicate field/);
  const partial = await analyzeInvoice(Buffer.from('Supplier: Northline'), 'partial.txt', '');
  assert.equal(partial.fields, null);
  assert.match(partial.error!, /manual/);
});

test('invalid encodings and oversized documents are rejected', async () => {
  await assert.rejects(analyzeInvoice(Buffer.from([0xc3, 0x28]), 'bad.txt', ''));
  await assert.rejects(analyzeInvoice(Buffer.alloc(32_769, 65), 'huge.txt', ''));
});

test('Cloud extraction sends the untrusted document without tools and flags changed terms', async context => {
  const bytes = await fixture('valid.txt');
  const original = parseDemo(bytes.toString());
  context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://cloud-api.near.ai/v1/chat/completions');
    assert.equal(options.method, 'POST');
    const payload = JSON.parse(String(options.body));
    assert.equal(payload.messages[0].role, 'system');
    assert.equal(payload.messages[1].content, bytes.toString());
    assert.equal(payload.tools, undefined);
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      ...original, recipient: 'unexpected.testnet', suspicious: true,
    }) } }] });
  });
  const invoice = await analyzeInvoice(bytes, 'invoice.txt', 'unit-test-value');
  assert.equal(invoice.mode, 'cloud');
  assert.equal(invoice.fields?.recipient, 'unexpected.testnet');
  assert.match(invoice.warnings.join(' '), /differs from the labeled source: recipient/);
});

test('invalid Cloud output stays in Cloud mode and requires review', async context => {
  context.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  const invoice = await analyzeInvoice(await fixture('valid.txt'), 'invoice.txt', 'unit-test-value');
  assert.equal(invoice.mode, 'cloud');
  assert.equal(invoice.fields, null);
  assert.match(invoice.error!, /manually/);
});
test('economic duplicate hint normalizes supplier and number while preserving distinct document hashes', async () => {
  const original = (await fixture('valid.txt')).toString();
  const first = await analyzeInvoice(Buffer.from(original), 'a.txt', '');
  const second = await analyzeInvoice(Buffer.from(original.replace('Northline Studio', 'NORTHLINE   STUDIO').replace('0.01', '0.02')), 'b.txt', '');
  assert.notEqual(first.hash, second.hash);
  assert.equal(possibleDuplicate(first, second), true);
  assert.equal(possibleDuplicate(first, first), false);
});