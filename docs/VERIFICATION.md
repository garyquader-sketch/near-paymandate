# Verification report

Run on November 11, 2026, in the Windows x64 workspace with Node.js 24.22.1, npm 11.6.2 and Rust 1.99.1.

| Check | Observed result |
| --- | --- |
| Clean npm install | Passed from a clean copy with `npm ci` and the included lockfile. |
| Web production build and TypeScript | Passed on the clean copy and rebuilt successfully after the cookie-access hardening. |
| Web and backend unit tests | 21 passed. Includes 10,000 reproducible amounts, 128 combinations of receipt evidence, session expiry and rotation, bounded request parsing, Cloud mocks and journal migration. |
| Production browser smoke test | Passed in Edge, Chrome and Playwright WebKit. All five screens checked at 320, 390, 768, 1024 and 1440 px. The axe-core WCAG 2.0/2.1 A/AA scan found no violations in four tested views per browser. Firefox did not complete its headless automation handshake on this host. |
| Production HTTP integration | Passed from the clean build. 48 parallel uploads produced 12 unique rows. The rows survived process restart, and the previous session was revoked. Local p95 ranged from 226.6 to 494.1 ms in these short runs. Cookie-only requests and cross-origin preflight were denied access. |
| Coverage | 93.19% of lines, 88.96% of branches and 91.84% of functions in the five exercised TypeScript library modules. Does not include the UI, real RPC execution paths or Rust. |
| Rust contract unit tests | 21 passed, including 64 mixed mandate lifecycles with a balance conservation invariant. Owner and agent authorization, stored terms, expiry, reservation release, duplicates, processing lock, transfer results and private callback checks. The near-sdk VM context supplied simulated receipts. The test reads the actual contract processing and paid events and checks their attempt IDs. |
| Release WASM | Release Clippy passed with warnings treated as errors. The rebuilt module matches the packaged SHA-256. Its exports and NEAR host imports passed ABI checks. Artifact is `artifacts/paymandate.wasm`. |
| Compiled WASM execution | 2 passed on Windows. The release module enforced owner and agent authority, scheduled the exact amount and recipient, checked callback authority, rejected replay, and kept the reservation for a retry after transfer failure. The test host supplies simulated receipt outcomes and does not meter gas. |
| Linux verification workflow | Added a manual Ubuntu job for the complete Sandbox suite, including checking finalized receipts with the application settlement parser. The job is included in the archive and its remote execution is pending. |
| NEAR Sandbox integration | Attempted. Official Sandbox returned `Unsupported platform: Windows_NT-x64` before deploying or running assertions. The suite is included for a supported Linux x64 or Apple Silicon host. |
| NEAR Testnet | Read-only RPC returned chain ID `testnet`, finalized block 277141747 and a public transaction response. The settlement parser accepted the response shape and did not treat the unrelated transaction as a PayMandate payment. Deployment, wallet connection, signed calls, real settlement and public transaction evidence remain pending. No contract address or transaction hashes are available. |
| NEAR AI Cloud | Request and validation paths tested with mocked responses. No live key was used. Browser testing used the explicitly labeled deterministic parser. |
| Workspace setup | Verified local token generation and idempotent key generation. The setup command prints only the public key. |

WASM SHA-256:

```text
c92f6c8e38b0a96376af895565350a7e8bd170815a2fa7d453cc7291d6e07f7c
```

## Browser finding

A loopback probe found that the tested WebKit build sent the operator cookie on a cross-site navigation despite the server issuing SameSite=Strict. The application now requires its own request header in addition to a valid cookie. The browser suite reproduced the navigation and confirmed that the production endpoint returned an authorization denial and no invoice data in WebKit, Chrome and Edge. The HTTP suite separately verified that the API sends no cross-origin allow header for the required request header.

## Review dispositions

- The hackathon release was installed and built from a clean source copy. TypeScript, 21 web tests, 2 compiled WASM tests and 2 production runtime checks passed in that copy.
- The English-captioned [local demo MP4](../artifacts/NEAR-PayMandate-demo.mp4) records a fresh workspace processing the bundled flagged invoice. The recording demonstrates the local analyzer and review flow. Testnet and Cloud were disabled for this recording.

- Testnet prerequisites are explicit in the interface. The payment action requires a configured contract, a verified scoped agent key, and an eligible on-chain mandate.
- The design follows the public prompts listed in [DESIGN-PROMPT.md](DESIGN-PROMPT.md). Desktop and mobile screenshots were recaptured from the production build.
- The running localhost instance passed direct API checks for auditor isolation, denied execution without authorization, invalid/oversized invoices, SHA-256, duplicate uploads and the prompt-injection fixture.
- Sessions are memory-backed and scoped to the local server process. Browser sign-in expires after four hours and is revoked by logout or service restart. The opaque cookie is HttpOnly and SameSite=Strict. HTTPS deployments get Secure cookies, but public hosting is outside the current release scope.
- Confirmed transaction identity and successful matching receipt events are required before reporting a settled payment. Unknown results remain blocked and require reconciliation. Signed external transactions, live wallet connector behavior, Sandbox execution and an independent audit remain unverified.

## Dependency review

- `npm audit --audit-level=critical` returned **0 vulnerabilities**. The Sandbox dependency pins an older tar parser upstream. The npm lock overrides it to `tar@7.5.22`, and the audit was repeated on the current lock.
- OSV scanned 273 locked Rust dependencies. It returned [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html) for `crypto-bigint` and [RUSTSEC-2024-0449](https://rustsec.org/advisories/RUSTSEC-2024-0449.html) for unmaintained `unsafe-libyaml`. Cargo's dependency tree put both in the host testing graph. Both were absent from the WASM normal dependency graph. The test suite uses no live signing credentials or user YAML.
- Disabled the optional `wee_alloc` default feature after advisory review. The final Cargo lock and WASM graph exclude it.

## Acceptance status

The source, WASM, local workspace, test suites, threat model and English submission drafts are included. The project still needs the official Sandbox pass, owner-wallet and live Testnet confirmation, on-chain evidence, and a recorded demonstration before technical submission readiness. Live Cloud validation is optional when the labeled deterministic mode is used. Publication and submission require the user's approval.
