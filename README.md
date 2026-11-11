# NEAR PayMandate

## Judge quickstart

1. Follow [Getting Started](#getting-started) to open the local workspace with Node.js 24.
2. Unlock the operator workspace. In **Invoices**, upload `examples/invoices/injection.txt` from the repository root. Review the warning, the original text, the extracted `vendor.example.testnet` and the SHA-256 digest.
3. Open **Dashboard**. The invoice appears in the review queue. In **Security Demo**, the expected rejection and payment cases are visible. The payment buttons become available after Testnet setup.
4. From `apps/web`, run `npm test` and `npm run test:wasm` to check extraction, authorization and the release contract's payment and callback behavior.

The quickstart uses the deterministic local analyzer and a disposable invoice example. The WASM suite supplies simulated NEAR receipts. See the [verification report](docs/VERIFICATION.md) for the exact coverage and the [Testnet runbook](docs/TESTNET.md) for the signed payment scenario.

## What is NEAR PayMandate?

An invoice approval workspace for delegated payments on NEAR Testnet. An operator uploads an invoice, reviews the proposed payment terms, and asks the owner to sign a mandate in their wallet. A separate agent account can request execution against the approved terms.

## Problem and Solution

An invoice can contain incorrect payment details or text that tries to direct an AI agent. An extraction result is a proposal. Each payment requires an owner-approved recipient, an exact amount, a SHA-256 document digest, and an expiration. The contract verifies all of them before it transfers any funds.

## Why NEAR?

NEAR function-call keys restrict the agent to one method on one contract. The contract reserves funds for approved mandates and observes the result of the native NEAR transfer through a private receipt callback. Finalized on-chain state is the source of payment status.

## Key Features

- UTF-8 text invoice upload, document hashing, field extraction, and operator review.
- Wallet-signed funding, approval, cancellation, and release of expired reservations.
- Testnet agent execution scoped to `execute_mandate`.
- Public auditor view of contract state and a private local activity journal.
- Four security demo scenarios with separate expected and observed results.

## Architecture

The Next.js application stores invoices and execution attempts in SQLite. NEAR AI Cloud extracts invoice fields when configured. The owner wallet calls the Rust contract directly. The agent submits to Testnet through the backend. See [architecture](docs/ARCHITECTURE.md) and the [adapted design prompt](docs/DESIGN-PROMPT.md).

## Security Model

Owner approvals attach one yoctoNEAR. The agent key has a finite allowance and zero attached deposit on executions. The contract locks the mandate before scheduling payment and keeps it locked if settlement cannot be determined. See the [threat model](docs/SECURITY.md).

## Technology Stack

Node.js 24, Next.js 16, React 19, TypeScript, Tailwind 4, Zod, Node SQLite, near-api-js 7, NEAR Connect, Rust, near-sdk 5.30.1, and NEAR Sandbox.

## Getting Started

Run from the project root. Install Node.js 24 with npm first.

```sh
cd apps/web
npm ci
node scripts/setup.mjs
npm run build
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Open `apps/web/.env.local` on your machine, copy the value of `PAYMANDATE_WORKSPACE_TOKEN`, and unlock the workspace. Use the Invoices tab to upload `examples/invoices/valid.txt` or `examples/invoices/injection.txt`. The example recipient must be replaced with your actual Testnet vendor during review.

The app starts in auditor view. With no configured contract, on-chain balances are unavailable and payment controls are disabled. The workspace still uploads, hashes, parses and persists invoices. `Demo analysis mode` is displayed when the cloud key is absent.

## Local Development

From `apps/web` run:

```sh
npm test
npm run test:coverage
npm run build
npm run typecheck
npm run test:runtime
npm run test:wasm
npm audit --audit-level=critical
```

Use `npm start` to run the production build locally. For browser checks after building, run `npx playwright-core install chromium` and `npm run test:browser`. You can set `PAYMANDATE_BROWSER` to a Chromium or Microsoft Edge executable already on your machine. Set PAYMANDATE_BROWSER_ENGINE to firefox or webkit after installing that Playwright browser to repeat the same suite on a different engine. For automated accessibility checks, point PAYMANDATE_AXE to an installed axe-core axe.min.js file. Browser and runtime tests start disposable localhost instances with Testnet and Cloud disabled.


The release WASM is in `artifacts/paymandate.wasm`. To rebuild it from the project root, install stable Rust with Cargo and run:

```sh
rustup target add wasm32-unknown-unknown
node scripts/build-contract.mjs
cargo test --locked --manifest-path contracts/paymandate/Cargo.toml --lib
```

For GNU Windows unit testing, Cargo's native dependencies need a working MinGW C compiler, assembler, DLL tooling, and NASM. Linux x64 also supports the Sandbox suite.

## Contract Deployment

Use the [Testnet setup and deployment runbook](docs/TESTNET.md). It covers test accounts, faucet funds, the deployment/initialization batch, and a method-scoped key. Deployment and payment calls require your own signatures.

## NEAR Testnet Demo

See the [two-to-three minute recording script](docs/DEMO.md). The [verification report](docs/VERIFICATION.md) lists observed checks and deployment status. The screenshots in `artifacts/` show a local invoice workspace with the deterministic parser and no configured Testnet contract.

## Reproducible Security Tests

`npm run test:wasm` executes the release artifact with an in-memory test host, including its exported entry points, JSON encoding, persisted state, transfer arguments, and callback behavior. The test host simulates NEAR receipt outcomes.

The manually triggered **NEAR Sandbox verification** workflow in [GitHub Actions](.github/workflows/sandbox.yml) builds the contract on Ubuntu and runs the Rust, web, compiled WASM, and real local Sandbox checks. It uses temporary Sandbox accounts and requires no Testnet keys.

Run the Rust suite above. On a supported Linux x64 or Apple Silicon host, install the web dependencies, build the WASM as above, and then run:

```sh
cd apps/web
npm run test:sandbox
```

The test starts a disposable official Sandbox node on loopback and uses only Sandbox accounts. It checks deployment, authorization, funding, immutable payment terms, concurrent attempts, duplicate rejection, balance changes and transfer failure recovery.

## Environment Variables

| Variable | Use |
| --- | --- |
| `PAYMANDATE_WORKSPACE_TOKEN` | Random operator token, at least 24 characters. The setup script generates it. |
| `NEAR_TESTNET_CONTRACT` | Named `.testnet` contract account. |
| `NEAR_TESTNET_AGENT_KEY` | Private key for the execute-only Testnet key. Server only. |
| `NEAR_AI_API_KEY` | Optional private NEAR AI Cloud key. Server only. |
| `NEAR_AI_MODEL` | Optional model override. The default follows the Cloud quickstart. |
| `PAYMANDATE_DATA_DIR` | Optional SQLite directory. Defaults to `apps/web/.data`. |

## Limitations

One owner, one agent account, one contract, and native Testnet NEAR. UTF-8 text invoices only. The UI lists the newest 100 mandates and 200 local invoices or attempts. Unknown outcomes stay unresolved until verifiable receipts are available. A transfer with an unresolved callback remains locked on-chain. The UI service is intended for one local server process with a shared operator token. Lock workspace revokes the browser session on the server. Restarting the service also requires a new sign-in. See [verification](docs/VERIFICATION.md) for the status of external integrations.

## Hackathon Tracks

AI Security & Defense (`security`) is the primary track. Real-World Money (`realworld`) is the secondary track for the invoice approval and settlement workflow. See [submission materials](docs/HACKATHON.md).

## License

[MIT](LICENSE). The project uses the dependencies listed in the npm and Cargo manifests and lockfiles.
