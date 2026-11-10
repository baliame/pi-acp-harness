/** Real SDK sessions exercised by an independent official ACP client implementation. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Harness } from "@pi-acp/harness";
import { createDemo } from "../examples/demo.ts";
import { installTasks } from "../examples/tasks.ts";
import { object } from "../src/wire.ts";

async function setup() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-acp-"));
	await writeFile(join(cwd, "sample.txt"), "hello from a real Pi read tool");
	const demo = await createDemo(cwd);
	installTasks(demo.host);
	return {
		...demo,
		cwd,
		close: async () => {
			await demo.host.close();
			await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		},
	};
}

function clientV2(
	host: Harness,
	permission: v2.ClientRequestHandlersByMethod["session/request_permission"] = () => ({
		outcome: { outcome: "selected", optionId: "allow" },
	}),
) {
	const outbound = new TransformStream<v2.AnyMessage>();
	const inbound = new TransformStream<v2.AnyMessage>();
	const updates: v2.UpdateSessionNotification[] = [];
	host.router().connect({ readable: outbound.readable, writable: inbound.writable });
	const connection = v2
		.client()
		.onNotification("session/update", ({ params }) => {
			updates.push(params);
		})
		.onRequest("session/request_permission", permission)
		.onRequest("elicitation/create", () => ({ action: "accept", content: { value: "form answer" } }))
		.onRequest(
			"_com.example/ui/ping",
			(value) => value,
			({ params }) => ({ echoed: params }),
		)
		.connect({ readable: inbound.readable, writable: outbound.writable });
	return { connection, agent: connection.agent, updates };
}

async function initialize(peer: ReturnType<typeof clientV2>) {
	return peer.agent.request("initialize", {
		protocolVersion: 2,
		info: { name: "sdk-test", version: "1" },
		capabilities: {
			elicitation: { form: {} },
			_meta: { "com.example/ui": { version: 1 } },
		},
	});
}

async function idle(host: Harness, id: string) {
	await host.sessions.get(id)!.run;
	await host.sessions.get(id)!.flush();
}

test("v2 drives SDK tools, forms, capabilities and retained context", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	const peer = clientV2(demo.host);
	t.after(() => peer.connection.close());
	const init = await initialize(peer);
	assert.equal(init.protocolVersion, 2);
	const session = await peer.agent.request("session/new", { cwd: demo.cwd, mcpServers: [] });
	const prompt = await peer.agent.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "use a tool" }],
	});
	assert(prompt.messageId);
	await idle(demo.host, session.sessionId);
	assert.equal(demo.counts.executions, 1);
	assert(peer.updates.some(({ update }) => update.sessionUpdate === "tool_call_update"));
	assert(
		peer.updates.some(({ update }) => update.sessionUpdate === "state_update" && update.state === "requires_action"),
	);
	const tasks = object(await peer.agent.request("_com.example/tasks/list", { sessionId: session.sessionId }));
	assert.equal((tasks.tasks as unknown[]).length, 1);
	assert.deepEqual(await peer.agent.request("_com.example/tasks/callback", { sessionId: session.sessionId }), {
		echoed: { text: "ping" },
	});
	await peer.agent.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "show a form" }],
	});
	await idle(demo.host, session.sessionId);
	assert(JSON.stringify(peer.updates).includes("form answer"));
	await peer.agent.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "read the sample" }],
	});
	await idle(demo.host, session.sessionId);
	assert(JSON.stringify(peer.updates).includes("hello from a real Pi read tool"));
	assert.equal((await peer.agent.request("session/list", {})).sessions.length, 1);
	demo.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "intentional provider failure" }),
	]);
	await peer.agent.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "fail" }],
	});
	await idle(demo.host, session.sessionId);
	assert.deepEqual(demo.host.sessions.get(session.sessionId)!.state, { state: "idle", stopReason: "error" });
});

test("v1 uses the same SDK host with prompt completion and history load", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	const outbound = new TransformStream<v1.AnyMessage>();
	const inbound = new TransformStream<v1.AnyMessage>();
	demo.host.router().connect({ readable: outbound.readable, writable: inbound.writable });
	const updates: v1.SessionNotification[] = [];
	const connection = v1
		.client()
		.onNotification("session/update", ({ params }) => {
			updates.push(params);
		})
		.onRequest("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "allow" } }))
		.connect({ readable: inbound.readable, writable: outbound.writable });
	t.after(() => connection.close());
	await connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await connection.agent.request("session/new", { cwd: demo.cwd, mcpServers: [] });
	const result = await connection.agent.request("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: "use a tool" }],
	});
	assert.equal(result.stopReason, "end_turn");
	assert.equal(demo.counts.executions, 1);
	assert(updates.some(({ update }) => update.sessionUpdate === "tool_call"));
	const before = updates.length;
	await connection.agent.request("session/load", { sessionId, cwd: demo.cwd, mcpServers: [] });
	assert(updates.length > before);
	demo.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "intentional provider failure" }),
	]);
	await assert.rejects(
		connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "fail" }] }),
		(error: unknown) => object(error).code === -32603,
	);
});

test(
	"close stops Pi extension resources and resume restarts them without replacing context",
	{ timeout: 15000 },
	async (t) => {
		const demo = await setup();
		t.after(demo.close);
		const lifecycle = { starts: 0, stops: 0 };
		demo.host.addExtension((pi) => {
			pi.on("session_start", () => {
				lifecycle.starts++;
			});
			pi.on("session_shutdown", () => {
				lifecycle.stops++;
			});
		});
		const peer = clientV2(demo.host);
		t.after(() => peer.connection.close());
		await initialize(peer);
		const { sessionId } = await peer.agent.request("session/new", { cwd: demo.cwd, mcpServers: [] });
		const original = demo.host.sessions.get(sessionId)!.pi;
		await peer.agent.request("session/close", { sessionId });
		assert.deepEqual(lifecycle, { starts: 1, stops: 1 });
		await peer.agent.request("session/resume", { sessionId, cwd: demo.cwd, mcpServers: [] });
		assert.deepEqual(lifecycle, { starts: 2, stops: 1 });
		assert.equal(demo.host.sessions.get(sessionId)!.pi, original);
	},
);

test("detach retains work; resume replays once and rejects a competing owner", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	demo.faux.setResponses([
		async () => {
			await setTimeout(150);
			return fauxAssistantMessage("completed while detached");
		},
	]);
	const first = clientV2(demo.host);
	await initialize(first);
	const { sessionId } = await first.agent.request("session/new", { cwd: demo.cwd, mcpServers: [] });
	await first.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "continue" }] });
	const second = clientV2(demo.host);
	t.after(() => second.connection.close());
	await initialize(second);
	await assert.rejects(second.agent.request("session/resume", { sessionId, cwd: demo.cwd, mcpServers: [] }), /busy/);
	first.connection.close();
	await first.connection.closed;
	await idle(demo.host, sessionId);
	assert.equal(demo.host.sessions.size, 1);
	await second.agent.request("session/resume", {
		sessionId,
		cwd: demo.cwd,
		mcpServers: [],
		replayFrom: { type: "start" },
	});
	const output = second.updates.filter(({ update }) => update.sessionUpdate === "agent_message_chunk");
	assert.equal(
		output
			.map(({ update }) =>
				v2.SessionUpdate.isAgentMessageChunk(update)
					? update.content.type === "text"
						? update.content.text
						: ""
					: "",
			)
			.join(""),
		"completed while detached",
	);
	assert.equal(second.updates.at(-1)!.update.sessionUpdate, "state_update");
	await second.agent.request("session/close", { sessionId });
	assert(demo.host.sessions.has(sessionId));
});

test("an interrupted permission stays blocked and asks its new owner", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	let asked!: () => void;
	const pending = new Promise<void>((resolve) => {
		asked = resolve;
	});
	const first = clientV2(
		demo.host,
		({ signal }) =>
			new Promise((resolve) => {
				asked();
				signal.addEventListener("abort", () => resolve({ outcome: { outcome: "cancelled" } }), { once: true });
			}),
	);
	await initialize(first);
	const { sessionId } = await first.agent.request("session/new", { cwd: demo.cwd, mcpServers: [] });
	await first.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "use a tool" }] });
	await pending;
	assert.equal(demo.counts.executions, 0);
	first.connection.close();
	await first.connection.closed;
	assert.equal(demo.host.sessions.get(sessionId)!.state.state, "requires_action");
	let secondAsked = 0;
	const second = clientV2(demo.host, () => {
		secondAsked++;
		return { outcome: { outcome: "selected", optionId: "allow" } };
	});
	t.after(() => second.connection.close());
	await initialize(second);
	await second.agent.request("session/resume", {
		sessionId,
		cwd: demo.cwd,
		mcpServers: [],
		replayFrom: { type: "start" },
	});
	await idle(demo.host, sessionId);
	assert.equal(secondAsked, 1);
	assert.equal(demo.counts.executions, 1);
});

test("cancel stops a blocked tool; busy prompts and unknown methods return errors", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	let asked!: () => void;
	const pending = new Promise<void>((resolve) => {
		asked = resolve;
	});
	const peer = clientV2(
		demo.host,
		({ signal }) =>
			new Promise((resolve) => {
				asked();
				signal.addEventListener("abort", () => resolve({ outcome: { outcome: "cancelled" } }), { once: true });
			}),
	);
	t.after(() => peer.connection.close());
	await initialize(peer);
	const { sessionId } = await peer.agent.request("session/new", { cwd: demo.cwd, mcpServers: [] });
	await peer.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "tool" }] });
	await pending;
	await assert.rejects(
		peer.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "second" }] }),
		/busy/,
	);
	await assert.rejects(
		peer.agent.request("_com.example/missing", {}),
		(error: unknown) => object(error).code === -32601,
	);
	await peer.agent.notify("session/cancel", { sessionId });
	await idle(demo.host, sessionId);
	assert.equal(demo.counts.executions, 0);
	assert.deepEqual(demo.host.sessions.get(sessionId)!.state, { state: "idle", stopReason: "cancelled" });
	await peer.agent.request("session/set_config_option", { sessionId, configId: "thinking", type: "id", value: "off" });
	await assert.rejects(
		peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "thinking",
			type: "id",
			value: "unknown",
		}),
		(error: unknown) => object(error).code === -32602,
	);
});

test("stdio MCP configuration reaches Pi and executes a real MCP tool", { timeout: 20000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	demo.faux.setResponses([
		fauxAssistantMessage(
			[{ type: "toolCall", id: "mcp-call", name: "mcp__sample__echo", arguments: { text: "MCP round trip" } }],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("MCP finished"),
	]);
	const peer = clientV2(demo.host);
	t.after(() => peer.connection.close());
	await initialize(peer);
	const { sessionId } = await peer.agent.request("session/new", {
		cwd: demo.cwd,
		mcpServers: [
			{
				type: "stdio",
				name: "sample",
				command: process.execPath,
				args: [join(import.meta.dirname, "fixtures/mcp.mjs")],
				env: [],
			},
		],
	});
	assert.equal(demo.host.sessions.get(sessionId)!.piExtension!.getMcpServers().length, 1);
	await peer.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "MCP" }] });
	await idle(demo.host, sessionId);
	assert(JSON.stringify(peer.updates).includes("MCP round trip"));
	assert(
		peer.updates.some(({ update }) => update.sessionUpdate === "tool_call_update" && update.status === "completed"),
		JSON.stringify({ updates: peer.updates, tools: demo.host.sessions.get(sessionId)!.pi.getAllTools() }),
	);
	await peer.agent.request("session/resume", { sessionId, cwd: demo.cwd, mcpServers: [] });
	assert.equal(demo.host.sessions.get(sessionId)!.piExtension!.getMcpServers().length, 0);
});
