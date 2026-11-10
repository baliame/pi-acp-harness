/** Small version adapters over the official ACP router and shared Pi session host. */
import { randomUUID } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type { ConfigOption, Harness } from "./harness.ts";
import type { ProtocolContext } from "./modules.ts";
import { ProtocolWire } from "./protocol-wire.ts";
import type { Session } from "./session.ts";
import { metadata, type Peer, text, type Update } from "./wire.ts";

const info = { name: "pi-acp-harness", version: "0.1.0" };

/** Route a fresh connection to its independently negotiated protocol version. */
export function createRouter(host: Harness): Pick<v2.AgentProtocolRouter, "connect"> {
	const wire = new ProtocolWire(host.modules);
	const router = v2.agentProtocolRouter().withV1(agentV1(host, wire)).withV2(agentV2(host, wire));
	return { connect: (stream, options) => router.connect(wire.wrap(stream), options) };
}

function agentV2(host: Harness, wire: ProtocolWire): v2.AgentApp {
	const peer = createPeer(2, wire);
	return v2
		.agent({ name: info.name })
		.onConnect((connection) => {
			peer.signal = connection.signal;
			void connection.closed.then(() => host.detach(peer));
		})
		.onRequest("initialize", ({ params, client }) => {
			peer.info = params.info;
			peer.capabilities = params.capabilities ?? {};
			peer.request = (method, value, signal) =>
				client.request(method, value, { cancellationSignal: signal, stopWaitingOnCancel: true });
			peer.update = (sessionId, update) => client.notify("session/update", { sessionId, update });
			peer.project = (_sessionId, update) => [update];
			return {
				protocolVersion: 2,
				info,
				capabilities: { session: { mcp: { stdio: {} } }, _meta: { ...host.capabilities } },
			};
		})
		.onRequest("session/new", async ({ params }) =>
			setupV2(host, await host.newSession(peer, params.cwd, params.mcpServers ?? [])),
		)
		.onRequest("session/list", () => ({ sessions: [...host.sessions.values()].map((session) => session.info()) }))
		.onRequest("session/resume", async ({ params }) => {
			if (params.replayFrom && params.replayFrom.type !== "start")
				throw v2.RequestError.invalidParams(undefined, "Unsupported replay cursor");
			const session = await host.resume(
				peer,
				params.sessionId,
				params.cwd,
				params.mcpServers ?? [],
				!!params.replayFrom,
			);
			return setupV2(host, session);
		})
		.onRequest("session/prompt", async ({ params, signal, requestId }) => ({
			messageId: (await host.prompt(params.sessionId, params.prompt, context(host, peer, wire, signal, requestId)))
				.messageId,
		}))
		.onNotification("session/cancel", async ({ params }) => {
			const session = host.sessions.get(params.sessionId);
			if (session?.has(peer)) await session.cancel();
		})
		.onRequest("session/close", async ({ params }) => {
			await host.closeSession(peer, params.sessionId);
			return {};
		})
		.onRequest("session/set_config_option", async ({ params }) => {
			if (params.type !== "id")
				throw v2.RequestError.invalidParams(undefined, "Only select configuration is supported");
			return {
				configOptions: await host.setConfig(
					host.active(peer, params.sessionId),
					params.configId,
					text(params.value),
				),
			};
		})
		.onRequest("*", ({ method, params, signal, requestId }) =>
			host.protocol(method, params, context(host, peer, wire, signal, requestId)),
		)
		.onNotification("*", async ({ method, params, signal }) => {
			await host.custom(peer, method, params, signal, true);
		});
}

function agentV1(host: Harness, wire: ProtocolWire): v1.AgentApp {
	const peer = createPeer(1, wire);
	const tools = new Map<string, string>();
	return v1
		.agent({ name: info.name })
		.onConnect((connection) => {
			peer.signal = connection.signal;
			void connection.closed.then(() => host.detach(peer));
		})
		.onRequest("initialize", ({ params, client }) => {
			peer.info = params.clientInfo ?? { name: "unknown", version: "unknown" };
			peer.capabilities = params.clientCapabilities ?? {};
			peer.request = (method, value, signal) =>
				client.request(method, value, { cancellationSignal: signal, stopWaitingOnCancel: true });
			peer.update = async (sessionId, update) => {
				for (const item of updatesV1(sessionId, update, tools, peer))
					await client.notify("session/update", { sessionId, update: item });
			};
			peer.project = (sessionId, update) => updatesV1(sessionId, update, tools, peer);
			return {
				protocolVersion: 1,
				agentInfo: info,
				agentCapabilities: {
					loadSession: true,
					sessionCapabilities: { list: {} },
					_meta: { ...host.capabilities },
				},
			};
		})
		.onRequest("session/new", async ({ params }) =>
			setupV1(host, await host.newSession(peer, params.cwd, params.mcpServers ?? [])),
		)
		.onRequest("session/list", () => ({ sessions: [...host.sessions.values()].map((session) => session.info()) }))
		.onRequest("session/load", async ({ params }) => {
			for (const key of tools.keys()) if (key.startsWith(`${params.sessionId}/`)) tools.delete(key);
			return setupV1(host, await host.resume(peer, params.sessionId, params.cwd, params.mcpServers ?? [], true));
		})
		.onRequest("session/prompt", async ({ params, signal, requestId }) => {
			const result = await host.prompt(
				params.sessionId,
				params.prompt,
				context(host, peer, wire, signal, requestId),
			);
			const reason = await result.completion;
			if (result.flushed) await result.flushed;
			if (reason === "error") throw new v1.RequestError(-32603, "Pi run failed");
			return { stopReason: reason ?? "end_turn" };
		})
		.onNotification("session/cancel", async ({ params }) => {
			const session = host.sessions.get(params.sessionId);
			if (session?.has(peer)) await session.cancel();
		})
		.onRequest("session/set_config_option", async ({ params }) => {
			if ("type" in params) throw v1.RequestError.invalidParams(undefined, "Only select configuration is supported");
			return {
				configOptions: configV1(
					await host.setConfig(host.active(peer, params.sessionId), params.configId, params.value),
				),
			};
		})
		.onRequest("*", ({ method, params, signal, requestId }) =>
			host.protocol(method, params, context(host, peer, wire, signal, requestId)),
		)
		.onNotification("*", async ({ method, params, signal }) => {
			await host.custom(peer, method, params, signal, true);
		});
}

function createPeer(version: 1 | 2, wire: ProtocolWire): Peer {
	return {
		id: randomUUID(),
		info: { name: "unknown", version: "unknown" },
		version,
		capabilities: {},
		notify: (method, params) => wire.notify(method, params),
		project: () => [],
		signal: new AbortController().signal,
		request: async () => {
			throw new Error("Connection is not initialized");
		},
		update: async () => {
			throw new Error("Connection is not initialized");
		},
	};
}

function context(
	host: Harness,
	peer: Peer,
	wire: ProtocolWire,
	signal: AbortSignal,
	requestId: string | number | null,
): ProtocolContext {
	return {
		host,
		peer,
		signal,
		requestId,
		fields: wire.fields(requestId),
		afterResponse: (action) => wire.afterResponse(requestId, action),
	};
}

function setupV2(host: Harness, session: Session): v2.NewSessionResponse {
	return { sessionId: session.id, configOptions: host.config(session) };
}

function setupV1(host: Harness, session: Session): v1.NewSessionResponse {
	return { sessionId: session.id, configOptions: configV1(host.config(session)) };
}

function configV1(options: ConfigOption[]): v1.SessionConfigOption[] {
	return options.map(({ configId, ...option }) => ({ ...option, id: configId }));
}

function updatesV1(sessionId: string, update: Update, tools: Map<string, string>, peer: Peer): v1.SessionUpdate[] {
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
		case "agent_thought_chunk":
			return [{ sessionUpdate: update.sessionUpdate, content: contentV1(update.content) }];
		case "user_message":
			return (update.content ?? []).map((content) => ({
				sessionUpdate: "user_message_chunk",
				content: contentV1(content),
			}));
		case "tool_call_update": {
			const key = `${sessionId}/${update.toolCallId}`;
			const first = !tools.has(key);
			const title = update.title ?? update.name ?? tools.get(key) ?? "Tool";
			tools.set(key, title);
			const status =
				update.status === "completed"
					? "completed"
					: update.status === "failed" || update.status === "cancelled"
						? "failed"
						: update.status === "in_progress"
							? "in_progress"
							: "pending";
			const call: v1.ToolCall = {
				toolCallId: update.toolCallId,
				status,
				kind: "other",
				title,
				rawInput: update.rawInput,
				rawOutput: update.rawOutput,
				content: update.content?.map((item) => {
					// Pi tool results above create only standard content entries.
					const entry = item as Extract<v2.ToolCallContent, { type: "content" }>;
					return { type: "content", content: contentV1(entry.content) };
				}),
			};
			return first ? [{ ...call, sessionUpdate: "tool_call" }] : [{ ...call, sessionUpdate: "tool_call_update" }];
		}
		case "notice":
			return metadata(peer.capabilities.session).notices ? [update] : [];
		default:
			return [];
	}
}

function contentV1(content: v2.ContentBlock): v1.ContentBlock {
	switch (content.type) {
		case "text":
			return { type: "text", text: String(content.text) };
		case "resource_link":
			return { type: "resource_link", name: String(content.name), uri: String(content.uri) };
		case "image":
			return { type: "image", data: String(content.data), mimeType: String(content.mimeType) };
		default:
			return { type: "text", text: JSON.stringify(content) };
	}
}
