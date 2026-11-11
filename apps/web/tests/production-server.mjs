import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));

async function availablePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function productionServer(data, token, previousPort) {
  const port = previousPort ?? await availablePort();
  const url = 'http://127.0.0.1:' + port;
  const request = (route, init) => fetch(url + route, { signal: AbortSignal.timeout(20_000), ...init });
  const child = spawn(process.execPath, [
    'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port),
  ], {
    cwd: web, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PAYMANDATE_WORKSPACE_TOKEN: token, PAYMANDATE_DATA_DIR: data,
      NEAR_TESTNET_CONTRACT: '', NEAR_TESTNET_AGENT_KEY: '', NEAR_AI_API_KEY: '', NEXT_TELEMETRY_DISABLED: '1' },
  });
  const output = [];
  let launchError;
  child.on('error', error => { launchError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => output.push(String(chunk)));

  async function stop() {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }

  for (let i = 0; i < 50 && child.exitCode === null && !launchError; i++) {
    const response = await request('/api/chain').catch(() => undefined);
    if (response?.ok) return { url, port, request, stop };
    await delay(200);
  }
  await stop();
  throw new Error('Production server did not start. ' + (launchError?.message ?? output.join('')));
}
