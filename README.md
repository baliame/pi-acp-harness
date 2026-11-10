# Pi ACP harness

Run [Pi](https://github.com/earendil-works/pi) as a persistent headless agent through the Agent Client Protocol (ACP).
Connect an ACP frontend over stdio, HTTP or WebSocket. Pi's SDK owns the model loop, tools, extensions and conversation context; this adapter exposes them through ACP.

The companion [pi-tailless](https://github.com/baliame/pi-tailless) project provides Pi's terminal UI as a separate ACP client. Other compatible ACP clients can use the harness independently.

## Features

- ACP v1 and a pinned v2 draft, negotiated per connection.
- Process-owned sessions that retain context and running work across frontend disconnects.
- Pi SDK tools, backend extensions, model/thinking configuration and stdio MCP servers.
- Permissions and form elicitation through the connected client.
- Optional shared sessions: several clients can attach, receive output and answer one shared interaction.
- Optional FIFO prompt delivery and a separate queue capability for inspection and removal.

This is an experimental source project. Session recovery after a harness restart, public hosting and provisioning are outside its current scope.

## Build

Requires Node.js 22.19 or newer; local verification used Node 24.11.1 on Windows.

```sh
git clone git@github.com:baliame/pi-acp-harness.git
cd pi-acp-harness
npm ci --ignore-scripts
npm run build
```

In Windows PowerShell, use `npm.cmd` if execution policy prevents `npm`. Dependencies are pinned and installed locally. No npm package release or global installation is required.

## Try it without a model account

From this repository, start a demo against an existing absolute workspace directory:

```sh
node examples/serve.ts /absolute/workspace 31400
```

On Windows, use a path such as `C:/work/project`. The demo uses Pi's deterministic faux provider and needs no model credentials. It prints `http://127.0.0.1:31400/acp` to stderr. Try `hello`, `slow message`, `tool example` or `form example` from your frontend.

Configure a stdio-based ACP frontend to launch this connector:

```sh
node /absolute/pi-acp-harness/dist/cli.js attach --url http://127.0.0.1:31400/acp
```

The connector joins the existing server. By contrast, `node examples/stdio.ts` starts a separate client-owned demo process with its own session registry.

## Use your Pi configuration

```sh
node dist/cli.js stdio
node dist/cli.js serve --port 31400
```

These entrypoints use the launching environment's normal Pi configuration and providers. Unlike the demo, prompts can call model APIs and run configured tools. The ordinary HTTP listener binds to loopback, checks Host and rejects browser Origin headers. Use an existing tunnel or launcher for remote access.

By default, each session has one attached client. Disconnect retains its running work; reconnect and resume the same session ID to recover presentation history. Direct stdio processes do not share the persistent server's sessions. A server restart ends this in-memory retention.

## Shared sessions

The implementation has three layers:

| Layer | Responsibility |
| --- | --- |
| L1 | Core ACP and Pi SDK adapter; enabled by default. |
| L2 | Independently selected experimental attach and prompt-delivery proposals. |
| L3 | Namespaced application capabilities, including shared-queue list/pop. |

Start a credential-free host with both L2 modules and the L3 queue capability:

```sh
node examples/shared-server.ts --cwd /absolute/workspace --port 31410 --token-file .artifacts/shared/token
```

The example creates a private token if absent and writes connection details to `.artifacts/shared/token.connection.json`. Both HTTP and native WebSocket connections use the same registry. For a browser client, add `--origin` with its exact Origin; the private details file includes a browser WebSocket URL. Keep the token and connection file private.

Use either stdio connector:

```sh
node dist/cli.js attach --url http://127.0.0.1:31410/acp --token-file .artifacts/shared/token
node dist/cli.js attach --url ws://127.0.0.1:31410/acp --token-file .artifacts/shared/token
```

For configured Pi, select the modules explicitly:

```sh
node dist/cli.js serve --port 31410 --token-file /private/token --experimental multi-client-attach --experimental prompt-delivery --shared-queue
```

Here the token file must already exist. The shared listener is loopback-only, requires the common token, checks Host and admits only explicitly allowed browser Origins. It is intended for one trusted local operator.

Each session still has one Pi model loop. Different sessions can run concurrently. V2 queued requests remain pending until their message starts a separate FIFO turn; the local v1 adaptation completes each prompt after its own turn. Any participant can remove the expected next waiting entry through the queue capability. Removal never executes it, interrupts the current turn or restores text to an editor. The waiting limit is 100.

Disconnect drops that client's uninserted input and retains already running work. Cancel stops the active turn and leaves waiting input scheduled. Close clears waiting input and releases all members. Permissions/forms resolve once and cancel losing request copies.

Both L2 proposals are drafts, with explicit local adaptations. Unmodified clients can create sessions without implementing draft attach; they do not automatically gain shared queue controls. See the [layered contract](docs/layered-acp-contract.md) and [proposal pins](docs/experimental-provenance.json).

## Compose your own adapter

Use `createHarness`, `serve`, `serveShared` and `stdio` from `@pi-acp/harness` within this checkout or an independently built local package. Add ordinary Pi factories through `extensions` or `addExtension`. Advertise namespaced APIs with `registerCapability` and handle exact custom methods with `onRequest`/`onNotification`.

L2 exports live at `@pi-acp/harness/experimental/multi-client-attach` and `/experimental/prompt-delivery`; the L3 service is `/capabilities/shared-queue`. The core entry does not import their implementations. [The shared-server example](examples/shared-server.ts) shows composition; [the task example](examples/tasks.ts) shows a separate capability. Registrations are fixed when a transport starts.

## Development and compatibility

```sh
npm run check
npm run build
node --test --test-concurrency=1 test/*.test.ts
```

The local harness suite has 24 passing cases. The two-project integration was exercised with SDK clients, acpx 0.22.0, the official ACP sample and tailless over HTTP/WebSocket, using only deterministic providers. An unmodified Panda GUI run against the shared host remains a separate manual check. Other operating systems and terminals are unverified.

Pi SDK/AI are pinned to 1.5.0 and the official ACP SDK to 2.4.0. Review SDK changes and rerun checks when updating dependencies. Client filesystem/terminal delegation, provider login, arbitrary Pi terminal components, steering and restart recovery are not advertised. See the [core contract](docs/poc-contract.md), [source provenance](docs/source-provenance.json) and [coding rules](docs/pi-coding-rules.md).

## License

MIT. Pi copyright notices and third-party attribution are retained in [LICENSE](LICENSE) and [licenses](licenses).
