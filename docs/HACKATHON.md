# NEAR Hackathon submission materials

## Project description

NEAR PayMandate helps companies delegate invoice payment with an owner-approved spending policy. The workspace extracts payment details from text invoices, flags suspicious instructions and keeps the source document available for review. An owner signs a mandate for an exact recipient, amount, document hash and expiry. A Rust smart contract designed for NEAR Testnet reserves funds and checks the terms. A scoped function-call key lets an agent request execution, and a private NEAR callback confirms settlement. Local tests execute the release WASM and check changed amounts, replay and transfer failure. Live Testnet settlement is pending.

Primary track: AI Security & Defense (`security`). Secondary track: Real-World Money (`realworld`).

## X post draft

An invoice can tell an AI agent to pay the wrong wallet. We built NEAR PayMandate at NEAR HACKATHON. Owners approve exact payment terms. A @NEARProtocol contract enforces them. Watch the local invoice-review demo. #NEARHackathon

Attach the [local invoice-review video](../artifacts/NEAR-PayMandate-demo.mp4) and add the public repository link. If you record a signed Testnet walkthrough, update the post to describe the transactions shown in that video.

## Before submission

- Publish the reviewed source and MIT license in a public repository and keep it public through judging.
- Publish the demo video on X with the event name, `@NEARProtocol`, `#NEARHackathon` and the public repository URL. For a local-only project, the organizers require a video.
- Complete the [official application form](https://nearhackathon.com/#apply) using the team lead name, contact email, team size, tracks, mainnet prize account, public repository URL and public demo post URL. Provide the project description above and review the organizer's contact consent. Submit once.
- Recheck the [live hackathon rules](https://nearhackathon.com/HACKATHON.md) before submitting. The listed deadline is November 14, 2026 at 23:59 UTC.

## Payment evidence

The local video shows invoice ingestion, the warning and the review queue. For the complete signed payment demonstration, run the Ubuntu Sandbox workflow, then follow [TESTNET.md](TESTNET.md) and [DEMO.md](DEMO.md). Add real transaction links only after final settlement is verified.

Sources: [official track examples](https://github.com/nearai/near-hackathon-prompt-examples), [security track](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/06-security.md), [real-world money track](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/08-realworld.md).
