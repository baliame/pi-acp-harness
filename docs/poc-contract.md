# Separate frontend and harness PoC

This proposed contract adds a real SDK-backed harness and separate delivery repositories to the existing [frontend contract](acp-client-profile.md). ACP wire shapes remain pinned to `7441d106a853682cce61d2dd7db54123e4b9a477`. The harness uses ACP SDK 2.4.0, without advertising its newer optional system-prompt feature. This document becomes implemented behavior only after review and verification.

## Repository boundary

Create `pi-tailless` and `pi-acp-harness` as separate local Git repositories inside `C:/Users/Baliame/Pi-ACP`. Each must build and run from its own checkout without importing source, node_modules or generated output from the other repository or parent. Share ACP contracts as documentation and fixtures, not a private runtime coupling.

`pi-tailless` retains Pi's pinned upstream ancestry, source layout and upstream remote. Put the current frontend at `apps/tailless`, with independent package metadata, lockfile and checks. Its build/package output includes the frontend and its UI dependencies, without the Pi harness/model runtime. Retained upstream harness source is reference/merge material, not frontend output. Document package upgrade and upstream fetch/merge steps, including possible conflicts. Keep source attribution for adapted UI files.

`pi-acp-harness` depends on upstream Pi packages 1.5.0 and ACP SDK 2.4.0. It exports a programmatic host and a CLI; it does not patch or vendor Pi's runtime. Ordinary Pi SDK options and extension factories configure sessions. Both projects follow the pinned Pi coding rules. No custom commits or external publication are part of this PoC.

## Transport and process ownership

- `stdio`: client-launched ACP agent. Connection shutdown eventually exits this owned process.
- `serve`: explicitly started persistent ACP host, listening only on loopback using the official SDK's experimental HTTP transport.
- `attach`: stdio-to-HTTP message connector for an already-running host. It preserves ACP requests, responses, notifications and ordering. It never creates a harness process or rewrites session requests.

The frontend keeps its configured-command stdio interface. Configure it to run `attach` for the persistence demo. Attachment EOF closes the HTTP connection and exits only the connector. Clean up on termination and report failures on stderr. No diagnostics belong on protocol stdout.

The host rejects browser Origin requests and unexpected Host headers. It provides no multi-user authorization or public listener. The demo runs on one machine; deployment, SSH validation, process supervision and control-plane behavior are deferred.

## Sessions and driving

Negotiate ACP v1/v2 independently on every connection. Use only selected-version payloads and advertise only implemented methods. The server maintains actual Pi SDK sessions; session IDs identify those retained conversations, not transport connections.

Implement v1 new, list, load, prompt and cancel; advertise listing/loading. Implement v2 new, list, resume, close, prompt, cancel and updates. V2 close stops foreground work and releases the attachment without deleting retained history. A host shutdown disposes all sessions; recovery after restart is not provided. Unknown sessions return the selected protocol's resource-not-found error.

One connection can own multiple sessions; one session has at most one owner. Reject a second connection's attempt to attach an owned session with an explicit Invalid Request error and `data.reason = "session_busy"`. Ending a connection releases its ownership. Resume on the current owner synchronizes the same session. A supplied cwd must identify the existing session's workspace; report a mismatch rather than silently moving its tools.

Accept one foreground prompt per session. Reject another while foreground work is active with Invalid Request and `data.reason = "session_busy"`. Text and resource links use baseline ACP representations; preserve a resource link's URI and supplied description as context rather than silently discarding it. Do not advertise optional image/audio/embedded-context input in this PoC.

V1 prompt resolves when the SDK run settles, including extension-driven follow-up work. V2 prompt returns its inserted user message ID before completion; updates report aggregate running, requires_action and idle states. SDK errors and cancellations produce the protocol's error/stop representation. A disconnected v1 request cannot acquire a response on a later connection; the resumed client receives replay and subsequent live output instead.

Retain completed and in-flight work on detach. With no client attached, continue work that needs no interaction and journal presentation updates. Resume replays at a consistent cutoff, then delivers live updates without omission or duplication. V1 load replays conversation history before responding. V2 resume obeys the requested replay cursor and sends a current-state snapshot after replay and before its response. It does not imply idle. Do not replay live-only notices. Keep the same entity IDs across reattachment and protocol-version changes.

Explicit cancellation aborts Pi work and pending interactions. The stop/state notification must follow the selected version's lifecycle. Disconnection never silently grants permission, cancels the run, or resends a prompt.

Expose model/thinking configuration only where backed by the configured SDK runtime, and report unsupported choices as errors. Standard commands are advertised only where the host can drive them through Pi. This PoC need not project every Pi CLI command, TUI component or provider-login flow onto ACP.

Client-supplied stdio MCP servers are passed to Pi's exported MCP extension, not merely acknowledged. Their configuration is replaced on resume according to ACP. Advertise stdio support in v2; omit HTTP/SSE support until implemented. Exercise an actual local MCP connection in verification. Pi tools execute in the harness workspace; client filesystem writes and executable client terminals are not requested.

## Permissions and extension interaction

Before a Pi tool executes, request permission from the session's current owner with the selected version's subject/tool-call representation. Execute only after an explicit allowing response; denial blocks the call. Scope allow-once to that call. Do not offer an allow-always option unless its policy is implemented.

If the owner disconnects during an interaction, cancel the transport request and retain the blocked action. After resume, issue a fresh request to the new owner. Old request IDs and late responses cannot authorize it. When supported, v2 reports requires_action while blocked and running when work resumes. Cancelling the session or shutting down the host cancels retained interactions without executing their actions.

Translate Pi select, confirm and input dialogs into form elicitations only when that mode is advertised. Respect decline/cancel and validate form input at the wire boundary. Unsupported dialogs return the normal Pi cancelled result or a clear error. No default response may grant permission. Backend component factories do not travel over ACP.

The SDK host exposes startup registration for namespaced capability declarations and request/notification handlers, alongside ordinary Pi extension factories. A configured startup module can register its API and supply Pi hooks/tools. Use top-level imports and explicit composition; do not add another dynamic extension loader. Freeze declarations before accepting connections; changing them requires restarting the host and reconnecting clients. Standard command/config updates remain live.

Advertise custom APIs in version-appropriate capability metadata. Dispatch exact underscore-prefixed method names. There is no capability-target field, generic invoke method or package-negotiation protocol. Unknown methods return Method not found. Both directions use the current connection's advertised capabilities. An API consumer checks its documented version before calling.

The sample `com.example/tasks` capability advertises `{ "version": 1 }`. `_com.example/tasks/list` accepts `{ "sessionId": string }` for a session attached to the calling connection and returns `{ "tasks": [{ "id": string, "title": string, "status": string }] }`. Its data is a small extension example, not a task-management product. Both native `/tasks` and the independent frontend task widget consume it. With the backend example omitted, both show unavailable state and make no unsupported call.

The sample `_com.example/tasks/callback` request accepts the same session scope. If the frontend advertises compatible `com.example/ui`, it calls `_com.example/ui/ping` with `{ "text": "ping" }` and returns that method's JSON result; otherwise it returns an unsupported-capability error. The frontend example's ping responds with `{ "echoed": <original params> }`. This proves bidirectional API dispatch without coupling extension packages.

## Verification and claims

Use a configured Pi faux-provider example that drives real SDK sessions and harmless extension/local tools. Keep fake responses outside production adapters. Do not call remote model providers or use user credentials. The standard host remains configurable with upstream Pi's own SDK facilities.

First drive the harness with project-local acpx 0.22.0 using an isolated named custom agent and structured argv. Then connect the tailless frontend to that same harness. Use official SDK clients to exercise both v1/v2 and the standard sample agent to supplement the existing frontend fixtures. Record exact peers, versions and outcomes; a CLI check is not a graphical-editor certification or proof of every ACP feature.

Check independent install/build, package contents, upstream ancestry, code style, actual SDK tool execution, stdio MCP, replay, detach during work, completion while detached, cancellation, permissions, forms and capability presence/absence/callback. Verify the terminal flow: prompt, detach, reconnect, resume the same ID, then prompt again without losing history.
