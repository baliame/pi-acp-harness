# Local verification

Windows, Node 24.11.1, 2026-11-09. Independent `npm run check` and `npm run build` passed. `node --test test/session.test.ts test/transport.test.ts`: 8 passed, no failures/skips. These use real Pi SDK sessions and faux-provider responses, not a replacement session engine. They cover both ACP versions, tools, errors, forms, permissions, ownership/replay, cancellation, close/resource cleanup, resumed context and actual stdio MCP execution.

Independent acpx 0.22.0 connected over the built attach connector, negotiated v1, approved the harmless echo tool, received its real result and finished end_turn. The separate tailless frontend then connected over v2, configured the session, approved tools, used the task capability/callback and resumed retained context. A built public-package stdio example also initialized/new/prompted/returned idle with protocol-only stdout.

The package dry run contained 48 files with public built entrypoints, examples, contracts and licenses, excluding private source/tests/node_modules. No provider calls, publishing, global installation or custom commits were made. Lifecycle scripts stayed disabled.

Real Windows terminal checks exercised task capability presence/absence, streaming detach, resume, a second prompt with retained context, explicit permission and cancellation. Test servers were stopped afterward. Other platforms/clients, real providers, public deployment and restart recovery are unverified. Retention and journals are in memory for the server process lifetime. The coordinating Pi-ACP project retains the complete approval, command observations and eight verification records.

