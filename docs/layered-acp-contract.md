# Layered ACP and shared sessions

This adds optional modules to the existing local PoC. The original `docs/poc-contract.md` and `docs/acp-client-profile.md` continue to define the default L1 behavior. Only explicitly installed modules enable the behavior below. No claim of finalized ACP conformance is made for a proposal or its local adaptations.

## Layers and ownership

L1 composes Pi SDK sessions with the pinned baseline ACP v1/v2 surfaces. It owns transport framing, standard validation, session driving and narrow public protocol-module hooks. Without modules it keeps exclusive session ownership and rejects busy prompts exactly as today.

L2 contains independently installable protocol modules with their own schemas, tests and version adapters: multi-client attach and the queue subset of prompt delivery. L3 contains an independently installable shared-queue capability and its UI consumer. L3 keeps underscore-prefixed namespaced methods and cannot replace standard methods. Existing task and UI extensions remain L3 consumers.

Provide backend and frontend modules through separate package export paths, such as `experimental/multi-client-attach` and `experimental/prompt-delivery`. Keep the two repositories independent. Core library entrypoints must not import these modules. CLI composition may import optional modules at the top level and activate the ones explicitly selected. No new global package or repository is required.

Public startup hooks cover version-specific method/field/update registration, connection/session lifecycle, participation and interaction routing, ordered presentation/replay, and prompt dispatch. Registrations are fixed before initialization; duplicates and missing dependencies fail startup. Standard validators remain in force. SDK 2.4.0 strips unrecognized parsed fields, so declared draft additions must be captured and validated at the public stream boundary and preserved for the registered module. Do not patch SDK dependencies or expose private fields as an extension API. A response barrier must make after-response work observable in actual wire order.

## Pinned experiments

| Module | Proposal revision | Supported scope |
|---|---|---|
| Multi-client attach | RFD #533, `98e098b7ca7c289066d20f73411ce649081d378b` | Attach/detach, equal participation, history modes, permission resolution, prompt/completion and departure updates |
| Prompt delivery | RFD #1261, `ee193af58f211a1cbfde30029d5283f9c94c554c` | v2 `delivery: "queue"`; steering remains unsupported |

Module-owned metadata under `_meta["com.example/experimental-acp"]` identifies the enabled profile revision for consumers that recognize this local contract. It is owned extension metadata, not a new standard capability negotiation or a package manifest. Each module supplies its own entry. The v2 prompt module additionally advertises the proposal's `capabilities.session.prompt.delivery.queue: {}`; it never advertises `steer`.

The attach draft uses `update.type` in examples and does not define a complete history schema. Our explicit local wire profile uses ACP's `sessionUpdate` discriminator for `permission_resolved`, `prompt_received`, `turn_complete` and `client_disconnected`. These variants are registered only by L2. Root method names and documented draft parameters remain `session/attach` and `session/detach`. This profile is an adaptation of the pinned proposal, not a claim those variants are baseline ACP.

## Membership, replay and interaction

Creating a session on an L2-enabled host registers its creating connection as its first participant, including an ordinary v1 client. `session/attach` accepts `{sessionId, historyPolicy?, afterMessageId?, clientId?, clientInfo?}`. Supported history policies are `full` (default), `pending_only`, `none`, and `after_message`. An omitted clientId is assigned; a supplied ID is correlation data, not authentication, and cannot impersonate an already-live connection. Repeating attach on the same connection must not duplicate membership.

The response contains `sessionId`, assigned `clientId`, other `connectedClients`, the applied `historyPolicy`, and `history` except for `none`. Complete the snapshot response before sending live traffic to the new member. Replay actionable pending requests as fresh RPCs only after that response. Existing members continue receiving updates during replay; the joining member receives each retained/live event once in order.

History uses timestamped `{type: "session_update", update}` items carrying the selected-version presentation projection. Pending interactions additionally use `{type: "permission_request", toolCallId, status: "pending", request}` display items; the item itself cannot authorize an action. This completes the draft's otherwise illustrative history format. `pending_only` includes pending-interaction display items. `after_message` starts after the last retained event associated with afterMessageId; an unknown message falls back to full history and reports `historyPolicy: "full"`. The same message IDs used by live updates are retained for replay.

All participants may prompt, cancel, configure, close and use session-scoped APIs. Different sessions run independently. Viewing another session changes only the local view; all other memberships and runs continue. Updates, dialogs and cancellation are always scoped by sessionId. Session-scoped APIs use the installed participation policy rather than retaining an exclusive-owner check behind L2.

`session/detach {sessionId}` returns `{sessionId,status:"detached"}` and removes only that membership. Disconnect removes the connection's memberships. `client_disconnected` identifies the departing client. When the last participant leaves, existing Pi work and retained history remain process-owned; permissioned actions wait for a participant. Baseline load/resume remains sequential handoff and must not silently join a session owned by other clients. Attach does not replace the creator's workspace or client-supplied MCP configuration. A replay/resume must not mutate shared MCP configuration while other participants remain.

Permission requests go to attached clients; valid allow or deny resolves the operation once. Late and duplicate answers cannot execute it again. Publish `permission_resolved` with toolCallId, chosenOptionId and resolvedBy, and cancel the other outstanding request copies. Disconnects, malformed answers and unsupported-method errors do not authorize execution. Cancellation responses do not beat a still-pending explicit decision; if all connected recipients cancel, resolve cancelled. If everyone disconnects, retain the blocked action for a later attach. Supported form elicitations use the same single-resolution rule with accept/decline; send only modes a client advertises. Session cancellation invalidates all interaction copies.

The prompt source receives its ordinary selected-version response. Other draft-aware members receive `prompt_received` with prompt, sentBy and messageId when the message is inserted. Legacy v1 members receive a standard user-message projection for another client's prompt. Do not display both projections as duplicate user messages. v1 secondary clients use `turn_complete` to settle visible activity; v2 continues to use standard state_update as authoritative and treats duplicate completion information idempotently. No input is resent on reconnect.

## FIFO delivery

With prompt delivery installed, v2 `session/prompt` may supply advertised `delivery: "queue"`. Unknown or unsupported delivery values fail with -32602 before insertion. A plain busy v2 prompt retains the default busy error. An idle queue request inserts immediately; a busy one waits FIFO for the current turn to end. Report idle before starting the next turn. Each accepted entry starts a separate Pi turn; do not merge messages into one turn or run two model loops against the same session concurrently.

A queued v2 request remains pending. Only actual insertion returns messageId and emits its user_message. Removing a waiting entry sends -32800 to its original request and never adds it to Pi context or retained conversation history. This preserves the pinned proposal's distinction between waiting and insertion. Use a request-specific lifetime, not the existing short generic RPC timeout, for a queued prompt.

With both modules enabled, any attached participant can submit. For interoperability with the chosen legacy primary, L2 supplies a documented v1 adaptation: a plain v1 prompt received while busy joins the same FIFO and its response waits for that entry's turn completion. This is a local compatibility policy, not a claim that RFD #1261 specifies v1. Each response stays on its originating connection.

Cancelling the active session stops the current turn but keeps pending messages, which proceed after idle. Closing the session stops the run, removes all waiting entries before they can start, settles their requests as cancelled, stops session resources and releases all members while retaining history. Cancelling a queued request removes that entry; disconnecting its submitter drops its uninserted entries and notifies remaining participants. A session's queue is limited to 100 waiting entries; overflow receives a documented queue_full error without insertion. There is no steering in this iteration.

Pi's existing SDK still owns the model loop and context. Its follow-up queue supports delayed input and clearing the entire queue, but not the required cross-client entry IDs and atomic pop. The protocol module therefore owns only the waiting request FIFO and invokes the existing one-turn SDK driving path when an entry is ready. It does not create another agent engine.

## L3 shared-queue API

The optional `com.example/shared-queue: {version:1}` capability requires the attach and prompt-delivery modules. Its wire methods are `_com.example/shared-queue/list` and `_com.example/shared-queue/pop`. They accept an attached sessionId; pop also requires `expectedHeadId: string|null`. All participants have the same authority, regardless of which client submitted an entry.

A snapshot is `{sessionId,revision,entries}`, where entries are FIFO `{id,clientId,prompt,receivedAt}` values and prompt is the original supported ACP content array. List returns the current snapshot. Pop atomically removes the expected head without executing it or interrupting the current turn, returning `{removed:entry|null,...snapshot}`. A mismatched expectedHeadId returns -32600 with `data.reason:"queue_changed"` and changes nothing; an empty queue with null expectedHeadId returns removed:null. Concurrent stale pops cannot accidentally remove a different message. Popped text is not restored to an editor.

Broadcast `_com.example/shared-queue/update` snapshots after enqueue, start, pop, request withdrawal, submitter disconnect and close. Each includes a monotonically increasing per-session revision and change `{type,entryId,byClientId?}`. A joining consumer obtains the latest snapshot after attach. Entries that have begun execution are absent and cannot be popped. The UI treats snapshots idempotently and preserves its editor draft. These are application capability APIs, not additional ACP proposals. `com.example` is a local demonstration namespace.

## Frontend and composition

Tailless explicitly enables protocol modules through an `experimental` configuration list before initialization; L3 uses the existing independent frontend-extension loading path. Disabled modules expose no draft commands or parsers. A missing or incompatible peer profile produces an explicit unavailable/mismatch result, without falling back to creating another conversation.

The attach module adds `/attach [session-id]` (a picker when omitted) and `/detach [session-id]`, plus startup `--attach <id>` mutually exclusive with --resume. Attachment activates the selected view while leaving other attached sessions running. Existing /sessions and --resume keep their baseline sequential-resume meaning. /switch changes the local view. Header/status marks experimental shared-session mode, and a resolved permission dismisses its losing local dialog.

The queue extension adds `/queue` and `/queue-pop`, with a widget showing FIFO entries and submitting client names. Enqueue and pop changes update every capable client's widget. All attached clients receive the protocol notifications, but an unmodified Panda does not acquire queue widgets or pop controls. The first target is Panda creating a v1 session and tailless attaching as a v2 participant; Panda joining an already-shared session is deferred. Live baseline output and permission flow remain available to the legacy primary, while it may ignore draft-only metadata.

Both L2 modules can be omitted or installed independently. Shared-queue startup rejects missing L2 dependencies. L1-only operation and existing L3 tasks must work without either experiment. L2 changes require restart/reconnect; ordinary L3 presentation reload retains existing cleanup rules.

## Network endpoint and local scope

Reuse official SDK HTTP and WebSocket server/client adapters and `ws` for native upgrades. Declare `ws` 8.22.2 and `@types/ws` 8.18.1 directly and exactly; existing dependencies retain their pins. Add an opt-in native WebSocket endpoint with multiple independent connections over the same host session registry. The existing single-client external bridge is not the shared-session endpoint.

Default L1 serving remains unchanged. A shared network composition requires a project-local bearer token file and binds only to 127.0.0.1. Gate both HTTP and WebSocket connections consistently. The stdio connector reads the token file; browser clients may use the token in their WebSocket URL, with tokens redacted from diagnostics. Reject unexpected Host and Origin values; browser Origins must be explicitly allowlisted, including Panda's exact origin when requested. A common token authorizes one local operator, not multiple user identities. Do not use clientId as an authorization credential, add a public listener, or install certificates.

Provide a deterministic shared-server example, frontend configurations and connection details in a local ignored file; do not log tokens, read user credentials, or call providers during verification. Run it on a fresh test port. Do not restart, take over or migrate sessions in the currently running baseline harness. Process restart recovery and a provisioning/control plane remain deferred.
