# SDK harness

Follow [Pi's coding rules](docs/pi-coding-rules.md) where relevant. Keep code brief and readable. Use top-level imports, strict erasable TypeScript and exact direct dependency versions. Validate wire/configuration input; trust already typed internal values. Compose Pi's SDK and the official ACP SDK instead of copying their runtimes.

Run `npm.cmd run check` after code changes and focused `node --test` files after editing them. Install with `--ignore-scripts`; no lifecycle scripts, provider calls, paid tokens, global installation or commits.

The coordinated PoC approval is retained by the parent Pi-ACP project at revision `c4694282e3d031f0732476db5847b30842e287ad3f5cef0429c8753a681f722e`. Use AIDLC for future planning/changes. This approval covers the local PoC; it does not authorize deployment or publishing. Global AIDLC resources belong to AI-Development-Pipeline, not this repository.
