# Demo recording script

## Local invoice-review video

[Watch the short English-captioned MP4](../artifacts/NEAR-PayMandate-demo.mp4). It records a real run of the local app using the bundled flagged invoice. It shows the original instruction, the extracted vendor, the review queue, and the Testnet setup state.

## Signed Testnet walkthrough

Prepare the four Testnet accounts and deploy the contract using [TESTNET.md](TESTNET.md). Fund the tracked balance and keep a legitimate mandate available for the first two requests. Create a second mandate from the flagged invoice, with a reviewed real vendor and distinct invoice hash.

| Time | Screen | Narration and evidence |
| --- | --- | --- |
| 0:00–0:25 | Invoices | “Invoice instructions can reach a payment agent. The invoice produces a proposal that the owner reviews.” Show the parsed amount, vendor, and document hash. |
| 0:25–0:55 | Wallet and Mandates | “The owner signs the exact amount, recipient and expiry. NEAR reserves the amount.” Show the approval and the on-chain mandate. |
| 0:55–1:15 | Security Demo, recipient tampering | Use the approved mandate. Show the finalized rejection and unchanged mandate. |
| 1:15–1:45 | Security Demo, valid payment | Send the exact approved terms. Open the explorer and show the transfer receipt plus the on-chain PAID status. |
| 1:45–2:05 | Security Demo, duplicate execution | Choose the paid mandate. Show the second request's rejection. |
| 2:05–2:35 | Security Demo, prompt injection | Show the flagged source and run the substituted-recipient request on its separately approved mandate. Show the rejection and the unchanged approved recipient. |
| 2:35–2:50 | Activity | Show links to the final transaction evidence and the difference between analysis activity and Testnet results. |

If finalization takes longer than the recording slot, wait for receipts before recording that result. Keep the real transaction hashes visible in the explorer. Capture the Cloud badge only if live Cloud extraction ran successfully. Describe the prompt-injection test as a deterministic substituted-recipient request triggered from a flagged invoice.
