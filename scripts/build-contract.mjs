import { mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const target = resolve(project, process.env.CARGO_TARGET_DIR || 'contracts/paymandate/target');
const build = spawnSync('cargo', [
  'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown',
  '--manifest-path', 'contracts/paymandate/Cargo.toml',
], {
  cwd: project, stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: '--cfg near' },
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const outputDir = resolve(project, 'artifacts');
const output = resolve(outputDir, 'paymandate.wasm');
mkdirSync(outputDir, { recursive: true });
copyFileSync(resolve(target, 'wasm32-unknown-unknown/release/paymandate.wasm'), output);
const wasm = readFileSync(output);
if (!WebAssembly.validate(wasm)) throw new Error('Contract is not valid WebAssembly.');
console.log('SHA-256 ' + createHash('sha256').update(wasm).digest('hex'));
console.log(output);
