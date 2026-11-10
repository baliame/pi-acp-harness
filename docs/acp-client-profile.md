# ACP frontend contract

This is the authoritative local profile for the first frontend phase. The pinned schemas define wire shapes; the requirements define this frontend's supported behavior.

## Pins

ACP revision: `7441d106a853682cce61d2dd7db54123e4b9a477`.

- [V1 schema](schemas/v1.json)
- [V2 schema](schemas/v2.json)

V2 is draft. Changes to pins or supported producer/consumer contracts require review.

## Connection

The frontend is the ACP client. Invoke a configured executable, argv and environment without shell string concatenation. Stdout is newline-delimited UTF-8 JSON-RPC; stderr is diagnostics. Correlate requests by ID and direction. Service incoming requests/notifications while outgoing requests are pending. Validate envelopes and recognized payloads at this wire boundary.

Initially request version 2. If v1 is selected, reconnect with v1-shaped initialize parameters rather than relying on repeated initialization support. Retry once with v1 on a fresh connection for an explicit version/initialization-parameter incompatibility from a legacy v1 endpoint. Do not retry for authentication failures, arbitrary errors, malformed output or an unexplained disconnection. Unsupported versions produce an actionable error. Use the selected version's response shape and subsequent methods.

Use v1 authenticate and v2 auth/login/auth/logout only as advertised. Implement agent-handled authentication and display peer instructions. Advertise terminal auth only if the configured invocation can be reproduced in a real interactive terminal; otherwise report an unsupported flow explicitly. Do not log credentials.

## Sessions

V1: session/new is baseline; use listing/loading only when advertised. The pending session/prompt response represents the active turn; its stop reason ends the turn. Notifications remain independent.

V2: require capabilities.session for session methods. Support new/list/resume/close. Prompt response acknowledges acceptance and identifies the user message; running/requires_action/idle are state_update notifications. Background tool activity does not imply foreground activity. Closing is not deletion, and disconnection does not prove backend cancellation.

Keep one visible session with an in-memory registry per connection. Switching does not cancel/delete another session. Resume reconciles history and state using version-specific order and IDs. Never automatically resend a prompt after uncertain disconnection. Explicit interrupt sends session/cancel. Exit closes the connection without claiming remote work stopped.

Remote cwd is an absolute path in the peer's syntax and need not exist locally. MCP configurations can be supplied as data and forwarded only for transports the peer supports. This frontend does not host MCP or silently execute peer-supplied commands locally.

## Presentation and interaction

Render text/Markdown, user messages, reasoning, terminal-supported images, resource links, tools/results/diffs, plans, configuration, commands, usage and notices. Provide a labeled textual fallback for content the terminal cannot display. V2 tool-associated terminals are display-only.

V1 tool_call creates and tool_call_update changes a call. V2 upserts and chunks address entities by session, type and ID. Keep thoughts and messages with the same ID distinct. Accept initial chunks and later patches without duplication; preserve metadata removal semantics and apply updates in receive order. Unknown display variants may be ignored or shown generically. Malformed recognized variants are protocol errors.

Permission dialogs show the operation, choices and owning session. Return only the explicit user choice. Support form elicitation only for the implemented schema subset and advertise exactly that subset; do not advertise unsupported URL/form behavior. Cancellation/disconnection never silently grants permission. Switching sessions does not discard outstanding interactions.

Do not advertise v1 filesystem or executable terminal delegation. Remote requests never run local commands or write local files. User-installed local extensions are trusted Node.js code, as in pi, not sandboxed code.

## Capability APIs and local extensions

APIs are independent of package identity. Use namespaced capability metadata in v2 capabilities._meta and v1's corresponding clientCapabilities/agentCapabilities metadata. Nested capability metadata must not imply unimplemented parent support. Native code and extensions share capability lookup and method dispatch.

Load declarations before initialize. Omitted capabilities mean unsupported. Consumers interpret their known contract's version data; unknown metadata never downloads or executes code. Custom methods begin with underscore and use a reverse-DNS namespace. Dispatch by exact method name, not a targetCapability field. Each API defines params/results/errors/scope/notifications/version compatibility. Do not add a generic capabilities/invoke or plugin manifest negotiation method. Unknown requests return Method not found; unknown notifications are ignored. Custom calls work in both directions and contract handlers validate their inputs.

Provide a frontend-owned TypeScript extension API for local commands, configurable shortcuts, capability declarations, request/notification handlers, transcript/tool renderers, and cleanup. Connected context provides capability lookup, custom calls, session state and local UI. Local UI includes dialogs, notifications, widgets above/below the editor, components/overlays, editor text/replacement/autocomplete, status/header/footer, themes and terminal input. Exclude the embedded model/tool runtime. Existing mixed pi extensions require adaptation.

Reload disposes old registrations/components. Changed advertised capabilities mark an explicit reconnect as required; presentation-only changes do not. Standard session config and command updates remain live.

A fixture task-list capability will be consumed both by native code and a frontend extension. It verifies the API boundary, not a production task system or harness.

## Verification

Use deterministic ACP fixture processes for v1/v2, negotiation, unsupported versions, malformed input, independent notifications, permissions, session replay and capabilities. No model providers or paid tokens. Real-peer checks may supplement fixtures; do not claim ecosystem-wide certification from fixture tests.
