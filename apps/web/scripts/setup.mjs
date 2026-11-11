import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { KeyPair } from 'near-api-js';

const env = new URL('../.env.local', import.meta.url);
const includeKey = process.argv.includes('--agent-key');
if (process.argv.slice(2).some(arg => arg !== '--agent-key')) throw new Error('Usage: node scripts/setup.mjs [--agent-key]');
let text;
try { text = await readFile(env, 'utf8'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (text === undefined) {
  text = await readFile(new URL('../../../.env.example', import.meta.url), 'utf8');
  text = text.replace(/^PAYMANDATE_WORKSPACE_TOKEN=$/m, 'PAYMANDATE_WORKSPACE_TOKEN=' + randomBytes(32).toString('hex'));
  await writeFile(env, text, { flag: 'wx', mode: 0o600 });
  console.log('Created apps/web/.env.local. Use PAYMANDATE_WORKSPACE_TOKEN to unlock the app.');
}
if (includeKey) {
  const existing = /^NEAR_TESTNET_AGENT_KEY=(.*)$/m.exec(text)?.[1].trim();
  const key = existing ? KeyPair.fromString(existing) : KeyPair.fromRandom('ed25519');
  if (!existing) {
    const line = 'NEAR_TESTNET_AGENT_KEY=' + key.toString();
    text = /^NEAR_TESTNET_AGENT_KEY=.*$/m.test(text)
      ? text.replace(/^NEAR_TESTNET_AGENT_KEY=.*$/m, line)
      : text + '\n' + line + '\n';
    await writeFile(env, text, { mode: 0o600 });
  }
  console.log('Agent public key: ' + key.getPublicKey().toString());
  console.log('Grant this key access to execute_mandate on the Testnet contract with a finite allowance.');
}
