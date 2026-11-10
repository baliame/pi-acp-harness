/** Real Pi turns driven by independent draft-aware JSON-RPC peers. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarness, type Harness } from "@pi-acp/harness";
import { installSharedQueue } from "@pi-acp/harness/capabilities/shared-queue";
import { attachRevision, multiClientAttach } from "@pi-acp/harness/experimental/multi-client-attach";
import { promptDelivery } from "@pi-acp/harness/experimental/prompt-delivery";
import { createDemo } from "../examples/demo.ts";
import { metadata, object } from "../src/wire.ts";

class Peer {
	readonly messages: AnyMessage[] = [];
	blockOutput?: Promise<void>;
	private id = 0;
	private pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
	private writer: WritableStreamDefaultWriter<AnyMessage>;
	private connection: ReturnType<ReturnType<Harness["router"]>["connect"]>;
	answer: (method: string, params: unknown) => unknown | Promise<unknown> = () => ({
		outcome: { outcome: "selected", optionId: "allow" },
	});

	get lastRequestId(): number {
		return this.id;
	}

	constructor(host: Harness) {
		const outbound = new TransformStream<AnyMessage>();
		const inbound = new TransformStream<AnyMessage>();
		this.writer = outbound.writable.getWriter();
		this.connection = host.router().connect({ readable: outbound.readable, writable: inbound.writable });
		void inbound.readable
			.pipeTo(
				new WritableStream({
					write: (message) => {
						this.messages.push(message);
						if ("method" in message) {
							if ("id" in message) {
								void Promise.resolve(this.answer(message.method, message.params))
									.then((result) => this.writer.write({ jsonrpc: "2.0", id: message.id, result }))
									.catch(() => {});
							}
						} else if (typeof message.id === "number") {
							const pending = this.pending.get(message.id);
							this.pending.delete(message.id);
							if ("result" in message) pending?.resolve(message.result);
							else pending?.reject(message.error);
						}
						return this.blockOutput;
					},
				}),
			)
			.catch(() => {});
	}

	async initialize(version: 1 | 2 = 2): Promise<Record<string, unknown>> {
		const meta = { "com.example/experimental-acp": { attach: { profile: 1, revision: attachRevision } } };
		return object(
			await this.request(
				"initialize",
				version === 2
					? {
							protocolVersion: 2,
							info: { name: "independent-test", version: "1" },
							capabilities: { elicitation: { form: {} }, _meta: meta },
						}
					: {
							protocolVersion: 1,
							clientInfo: { name: "legacy-test", version: "1" },
							clientCapabilities: { _meta: meta },
						},
			),
		);
	}

	request(method: string, params: unknown): Promise<unknown> {
		const id = ++this.id;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			void this.writer.write({ jsonrpc: "2.0", id, method, params }).catch(reject);
		});
	}

	async notify(method: string, params: unknown): Promise<void> {
		await this.writer.write({ jsonrpc: "2.0", method, params });
	}

	async close(): Promise<void> {
		await this.writer.close().catch(() => {});
		await this.connection.closed;
	}
}

async function setup(tokensPerSecond = 1000) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-shared-"));
	const demo = await createDemo(cwd, tokensPerSecond);
	demo.host.use(multiClientAttach());
	const delivery = promptDelivery();
	demo.host.use(delivery);
	installSharedQueue(demo.host, delivery);
	const peers: Peer[] = [];
	return {
		...demo,
		cwd,
		delivery,
		peer: async (version: 1 | 2 = 2) => {
			const peer = new Peer(demo.host);
			peers.push(peer);
			await peer.initialize(version);
			return peer;
		},
		close: async () => {
			await demo.host.close();
			await Promise.all(peers.map((peer) => peer.close()));
			await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		},
	};
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		assert(Date.now() < deadline, "Timed out waiting for protocol state");
		await setTimeout(5);
	}
}

const prompt = (sessionId: string, text: string) => ({
	sessionId,
	prompt: [{ type: "text", text }],
	delivery: "queue",
});
const errorCode = (code: number) => (error: unknown) => object(error).code === code;

test("queue stays outside history; any member can pop; FIFO starts a separate turn", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	const first = await demo.peer();
	const second = await demo.peer();
	const hold = gate();
	demo.faux.setResponses([
		async () => {
			await hold.promise;
			return fauxAssistantMessage("first complete");
		},
		fauxAssistantMessage("second complete"),
	]);
	const { sessionId } = object(await first.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
		sessionId: string;
	};
	const attached = object(await second.request("session/attach", { sessionId }));
	assert.equal(attached.historyPolicy, "full");
	await first.request("session/prompt", prompt(sessionId, "current"));
	const removed = assert.rejects(second.request("session/prompt", prompt(sessionId, "remove me")), errorCode(-32800));
	let inserted = false;
	const next = first.request("session/prompt", prompt(sessionId, "keep me")).then((value) => {
		inserted = true;
		return value;
	});
	const queue = demo.delivery.queue(demo.host.sessions.get(sessionId)!);
	await until(() => queue.snapshot().entries.length === 2);
	assert.equal(inserted, false);
	assert(!JSON.stringify(demo.host.sessions.get(sessionId)!.journal).includes("remove me"));
	const head = queue.snapshot().entries[0]!.id;
	const popped = object(await first.request("_com.example/shared-queue/pop", { sessionId, expectedHeadId: head }));
	assert.equal(object(popped.removed).clientId, attached.clientId);
	await removed;
	await assert.rejects(
		second.request("_com.example/shared-queue/pop", { sessionId, expectedHeadId: head }),
		errorCode(-32600),
	);
	assert.equal(demo.host.sessions.get(sessionId)!.state.state, "running");
	hold.release();
	assert(object(await next).messageId);
	await demo.host.sessions.get(sessionId)!.run;
	assert.equal(queue.snapshot().entries.length, 0);
	assert.equal(demo.host.sessions.get(sessionId)!.pi.messages.filter((message) => message.role === "user").length, 2);
	assert(!JSON.stringify(demo.host.sessions.get(sessionId)!.pi.messages).includes("remove me"));
	assert(
		second.messages.some((message) => "method" in message && message.method === "_com.example/shared-queue/update"),
	);
});

test(
	"attach response precedes pending permission RPC; conflicting decisions execute once",
	{ timeout: 15000 },
	async (t) => {
		const demo = await setup();
		t.after(demo.close);
		const first = await demo.peer(1);
		const second = await demo.peer();
		const late = gate();
		first.answer = async () => {
			await late.promise;
			return { outcome: { outcome: "selected", optionId: "deny" } };
		};
		const { sessionId } = object(await first.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
			sessionId: string;
		};
		const running = first.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "use a tool" }] });
		await until(() =>
			first.messages.some((message) => "method" in message && message.method === "session/request_permission"),
		);
		const attached = object(await second.request("session/attach", { sessionId, historyPolicy: "pending_only" }));
		assert(JSON.stringify(attached.history).includes("permission_request"));
		await running;
		late.release();
		const responseIndex = second.messages.findIndex(
			(message) => "result" in message && metadata(message.result).historyPolicy === "pending_only",
		);
		const requestIndex = second.messages.findIndex(
			(message) => "method" in message && message.method === "session/request_permission",
		);
		assert(responseIndex >= 0 && requestIndex > responseIndex);
		assert.equal(demo.counts.executions, 1);
		await until(() =>
			second.messages.some(
				(message) => "method" in message && JSON.stringify(message.params).includes("permission_resolved"),
			),
		);
	},
);

test("history policies, membership access and independently running sessions", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	const first = await demo.peer();
	const second = await demo.peer();
	const { sessionId } = object(await first.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
		sessionId: string;
	};
	const initial = object(await first.request("session/prompt", prompt(sessionId, "hello")));
	await demo.host.sessions.get(sessionId)!.run;
	await assert.rejects(second.request("_com.example/shared-queue/list", { sessionId }), errorCode(-32002));
	const full = object(
		await second.request("session/attach", { sessionId, historyPolicy: "after_message", afterMessageId: "missing" }),
	);
	assert.equal(full.historyPolicy, "full");
	assert(JSON.stringify(full.history).includes("hello"));
	const after = object(
		await second.request("session/attach", {
			sessionId,
			historyPolicy: "after_message",
			afterMessageId: initial.messageId,
		}),
	);
	assert.equal(after.historyPolicy, "after_message");
	assert(!JSON.stringify(after.history).includes('"text":"hello"'));
	assert.equal(
		"history" in object(await second.request("session/attach", { sessionId, historyPolicy: "none" })),
		false,
	);
	const hold = gate();
	demo.faux.setResponses([
		async () => {
			await hold.promise;
			return fauxAssistantMessage("S1 finished");
		},
		fauxAssistantMessage("S2 finished"),
	]);
	await second.request("session/prompt", prompt(sessionId, "S1"));
	const other = object(await second.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
		sessionId: string;
	};
	await second.request("session/prompt", prompt(other.sessionId, "S2"));
	await demo.host.sessions.get(other.sessionId)!.run;
	assert.equal(demo.host.sessions.get(sessionId)!.state.state, "running");
	await second.request("session/detach", { sessionId });
	assert.equal(demo.host.sessions.get(sessionId)!.peers.size, 1);
	hold.release();
	await demo.host.sessions.get(sessionId)!.run;
	await assert.rejects(
		first.request("session/prompt", { ...prompt(sessionId, "bad"), delivery: "steer" }),
		errorCode(-32602),
	);
	assert.equal(Array.isArray(object(await first.request("session/list", {})).sessions), true);
});

test(
	"waiting request withdrawal, submitter departure, active cancellation and close",
	{ timeout: 15000 },
	async (t) => {
		const demo = await setup();
		t.after(demo.close);
		const first = await demo.peer();
		const second = await demo.peer();
		first.answer = second.answer = () => new Promise(() => {});
		const { sessionId } = object(await first.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
			sessionId: string;
		};
		await second.request("session/attach", { sessionId });
		const session = demo.host.sessions.get(sessionId)!;
		const queue = demo.delivery.queue(session);
		await first.request("session/prompt", prompt(sessionId, "use a tool"));
		await until(() => session.state.state === "requires_action");
		const withdrawn = assert.rejects(
			second.request("session/prompt", prompt(sessionId, "withdraw")),
			errorCode(-32800),
		);
		const requestId = second.lastRequestId;
		await until(() => queue.snapshot().entries.length === 1);
		await second.notify("$/cancel_request", { requestId });
		await withdrawn;
		assert.equal(queue.snapshot().entries.length, 0);
		void second.request("session/prompt", prompt(sessionId, "drop on disconnect")).catch(() => {});
		await until(() => queue.snapshot().entries.length === 1);
		await second.close();
		await until(() => queue.snapshot().entries.length === 0);
		const third = await demo.peer();
		await third.request("session/attach", { sessionId });
		third.answer = first.answer;
		const next = first.request("session/prompt", prompt(sessionId, "next turn"));
		await until(() => queue.snapshot().entries.length === 1);
		await third.notify("session/cancel", { sessionId });
		assert(object(await next).messageId);
		await until(() => !session.run);
		assert(JSON.stringify(session.pi.messages).includes("next turn"));
		await first.request("session/prompt", prompt(sessionId, "use a tool again"));
		await until(() => session.state.state === "requires_action");
		const removed = assert.rejects(
			third.request("session/prompt", prompt(sessionId, "never execute after close")),
			errorCode(-32800),
		);
		await until(() => queue.snapshot().entries.length === 1);
		await first.request("session/close", { sessionId });
		await removed;
		assert.equal(queue.snapshot().entries.length, 0);
		assert.equal(session.peers.size, 0);
		assert(!JSON.stringify(session.pi.messages).includes("never execute after close"));
		assert.equal(demo.counts.executions, 0);
	},
);

test("queue is bounded; plain busy prompts stay rejected; empty pop is a no-op", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	const peer = await demo.peer();
	peer.answer = () => new Promise(() => {});
	const { sessionId } = object(await peer.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
		sessionId: string;
	};
	const empty = object(await peer.request("_com.example/shared-queue/pop", { sessionId, expectedHeadId: null }));
	assert.equal(empty.removed, null);
	assert.equal(empty.revision, 0);
	await peer.request("session/prompt", prompt(sessionId, "use a tool"));
	await until(() => demo.host.sessions.get(sessionId)!.state.state === "requires_action");
	await assert.rejects(
		peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "plain busy" }] }),
		errorCode(-32600),
	);
	const queued = Array.from({ length: 100 }, (_, index) =>
		peer.request("session/prompt", prompt(sessionId, `waiting ${index}`)),
	);
	const settled = Promise.allSettled(queued);
	const queue = demo.delivery.queue(demo.host.sessions.get(sessionId)!);
	await until(() => queue.snapshot().entries.length === 100);
	await assert.rejects(
		peer.request("session/prompt", prompt(sessionId, "overflow")),
		(error: unknown) => metadata(object(error).data).reason === "queue_full",
	);
	await peer.request("session/close", { sessionId });
	assert((await settled).every((result) => result.status === "rejected"));
	assert.equal(queue.snapshot().entries.length, 0);
});

test(
	"a legacy primary queues its own busy input and receives only its turn completion",
	{ timeout: 15000 },
	async (t) => {
		const demo = await setup();
		t.after(demo.close);
		const first = await demo.peer(1);
		const second = await demo.peer();
		const { sessionId } = object(await first.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
			sessionId: string;
		};
		await second.request("session/attach", { sessionId });
		const hold = gate();
		demo.faux.setResponses([
			async () => {
				await hold.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);
		const content = (text: string) => ({ sessionId, prompt: [{ type: "text", text }] });
		const running = first.request("session/prompt", content("current"));
		await until(() => !!demo.host.sessions.get(sessionId)!.run);
		let complete = false;
		const queued = first.request("session/prompt", content("queued")).then((value) => {
			complete = true;
			return value;
		});
		await until(() => demo.delivery.queue(demo.host.sessions.get(sessionId)!).snapshot().entries.length === 1);
		assert.equal(complete, false);
		hold.release();
		assert.equal(object(await running).stopReason, "end_turn");
		assert.equal(object(await queued).stopReason, "end_turn");
		assert(
			second.messages.some(
				(message) => "method" in message && JSON.stringify(message.params).includes("prompt_received"),
			),
		);
	},
);

test("module dependencies, registration conflicts and core-only declarations", async () => {
	const host = createHarness();
	host.use({ id: "missing", requires: ["absent"] });
	assert.throws(() => host.start(), /Missing/);
	const conflict = createHarness();
	conflict.use(multiClientAttach());
	assert.throws(() => conflict.use(multiClientAttach()), /Duplicate/);
	assert.throws(() => conflict.use({ id: "override", methods: { "session/prompt": () => ({}) } }), /baseline/);
	const core = createHarness();
	const peer = new Peer(core);
	try {
		const initialized = await peer.initialize();
		assert.equal(metadata(metadata(initialized.capabilities)._meta)["com.example/experimental-acp"], undefined);
		await assert.rejects(peer.request("session/attach", { sessionId: "absent" }), errorCode(-32601));
	} finally {
		await core.close();
		await peer.close();
	}
});

test("queue notifications remain behind a joining member's response barrier", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	const first = await demo.peer();
	const second = await demo.peer();
	const hold = gate();
	const response = gate();
	demo.faux.setResponses([
		async () => {
			await hold.promise;
			return fauxAssistantMessage("current complete");
		},
	]);
	const { sessionId } = object(await first.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
		sessionId: string;
	};
	await first.request("session/prompt", prompt(sessionId, "current"));
	second.blockOutput = response.promise;
	try {
		await second.request("session/attach", { sessionId });
		const waiting = assert.rejects(first.request("session/prompt", prompt(sessionId, "waiting")), errorCode(-32800));
		const queue = demo.delivery.queue(demo.host.sessions.get(sessionId)!);
		await until(() => queue.snapshot().entries.length === 1);
		assert(
			!second.messages.some(
				(message) => "method" in message && message.method === "_com.example/shared-queue/update",
			),
		);
		second.blockOutput = undefined;
		response.release();
		await until(() =>
			second.messages.some(
				(message) => "method" in message && message.method === "_com.example/shared-queue/update",
			),
		);
		await first.request("_com.example/shared-queue/pop", {
			sessionId,
			expectedHeadId: queue.snapshot().entries[0]!.id,
		});
		await waiting;
	} finally {
		second.blockOutput = undefined;
		response.release();
		hold.release();
	}
});

test(
	"cancellation-only replies wait for an explicit answer and nobody connected stays blocked",
	{ timeout: 15000 },
	async (t) => {
		const demo = await setup();
		t.after(demo.close);
		const first = await demo.peer();
		const second = await demo.peer();
		first.answer = () => ({ outcome: { outcome: "cancelled" } });
		const answer = gate();
		second.answer = async () => {
			await answer.promise;
			return { outcome: { outcome: "selected", optionId: "allow" } };
		};
		const { sessionId } = object(await first.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
			sessionId: string;
		};
		await second.request("session/attach", { sessionId });
		await first.request("session/prompt", prompt(sessionId, "use a tool"));
		const session = demo.host.sessions.get(sessionId)!;
		await until(() => session.state.state === "requires_action");
		assert.equal(demo.counts.executions, 0);
		await first.close();
		await second.close();
		await until(() => session.peers.size === 0);
		assert.equal(session.state.state, "requires_action");
		const third = await demo.peer();
		await third.request("session/attach", { sessionId, historyPolicy: "pending_only" });
		await until(() => !session.run);
		answer.release();
		assert.equal(demo.counts.executions, 1);
	},
);

test("form responses resolve once and a slow participant cannot block a healthy one", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	const first = await demo.peer();
	const second = await demo.peer();
	const late = gate();
	first.answer = async (method) => {
		if (method === "elicitation/create") {
			await late.promise;
			return { action: "accept", content: { value: "late form" } };
		}
		return { outcome: { outcome: "selected", optionId: "allow" } };
	};
	second.answer = (method) =>
		method === "elicitation/create"
			? { action: "accept", content: { value: "winning form" } }
			: { outcome: { outcome: "selected", optionId: "allow" } };
	const { sessionId } = object(await first.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
		sessionId: string;
	};
	await second.request("session/attach", { sessionId });
	await first.request("session/prompt", prompt(sessionId, "show a form"));
	const session = demo.host.sessions.get(sessionId)!;
	await until(() => !session.run);
	late.release();
	assert.equal(demo.counts.executions, 1);
	assert(JSON.stringify(session.journal).includes("winning form"));
	assert(!JSON.stringify(session.journal).includes("late form"));
	const stalled = gate();
	second.blockOutput = stalled.promise;
	try {
		await first.request("session/prompt", prompt(sessionId, "healthy output"));
		await until(() => !session.run);
		await until(() =>
			first.messages.some(
				(message) => "method" in message && JSON.stringify(message.params).includes("healthy output"),
			),
		);
		assert.equal(session.state.state, "idle");
	} finally {
		second.blockOutput = undefined;
		stalled.release();
	}
});

for (const kind of ["attach", "delivery"] as const) {
	test(`${kind} is independently selectable`, { timeout: 15000 }, async (t) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-module-"));
		const demo = await createDemo(cwd);
		const module = kind === "attach" ? multiClientAttach() : promptDelivery();
		demo.host.use(module);
		const peer = new Peer(demo.host);
		t.after(async () => {
			await demo.host.close();
			await peer.close();
			await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});
		const initialized = await peer.initialize();
		const profile = metadata(metadata(metadata(initialized.capabilities)._meta)["com.example/experimental-acp"]);
		assert(profile[kind]);
		assert.equal(profile[kind === "attach" ? "delivery" : "attach"], undefined);
		const { sessionId } = object(await peer.request("session/new", { cwd, mcpServers: [] })) as { sessionId: string };
		if (kind === "attach") {
			assert.equal(
				object(await peer.request("session/attach", { sessionId, historyPolicy: "none" })).historyPolicy,
				"none",
			);
		} else {
			await assert.rejects(peer.request("session/attach", { sessionId }), errorCode(-32601));
			assert(object(await peer.request("session/prompt", prompt(sessionId, "delivery alone"))).messageId);
			await demo.host.sessions.get(sessionId)!.run;
		}
	});
}

test(
	"a slow v1 source gets completion between turns without blocking the next driver",
	{ timeout: 15000 },
	async (t) => {
		const demo = await setup();
		t.after(demo.close);
		const primary = await demo.peer(1);
		const second = await demo.peer();
		const { sessionId } = object(await primary.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
			sessionId: string;
		};
		await second.request("session/attach", { sessionId });
		const model = gate();
		const output = gate();
		demo.faux.setResponses([
			async () => {
				await model.promise;
				return fauxAssistantMessage("old turn output");
			},
			fauxAssistantMessage("new turn output"),
		]);
		primary.blockOutput = output.promise;
		let completed = false;
		const first = primary
			.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "old input" }] })
			.then((value) => {
				completed = true;
				return value;
			});
		const requestId = primary.lastRequestId;
		try {
			await until(() => !!demo.host.sessions.get(sessionId)!.run);
			const queued = second.request("session/prompt", prompt(sessionId, "new input"));
			await until(() => demo.delivery.queue(demo.host.sessions.get(sessionId)!).snapshot().entries.length === 1);
			model.release();
			assert(object(await queued).messageId);
			await until(() => !demo.host.sessions.get(sessionId)!.run);
			assert.equal(completed, false);
			primary.blockOutput = undefined;
			output.release();
			assert.equal(object(await first).stopReason, "end_turn");
			await until(() =>
				primary.messages.some(
					(message) =>
						"method" in message && metadata(object(message.params).update).sessionUpdate === "prompt_received",
				),
			);
			const response = primary.messages.findIndex(
				(message) => "id" in message && message.id === requestId && "result" in message,
			);
			const next = primary.messages.findIndex(
				(message) =>
					"method" in message && metadata(object(message.params).update).sessionUpdate === "prompt_received",
			);
			assert(response >= 0 && next > response);
			const old = primary.messages
				.slice(0, response)
				.filter(
					(message) =>
						"method" in message &&
						metadata(object(message.params).update).sessionUpdate === "agent_message_chunk",
				);
			assert.equal(
				old
					.map((message) =>
						"method" in message ? metadata(metadata(object(message.params).update).content).text : "",
					)
					.join(""),
				"old turn output",
			);
		} finally {
			primary.blockOutput = undefined;
			output.release();
			model.release();
		}
	},
);

test("repeated full attachment cuts replay once while streaming continues", { timeout: 15000 }, async (t) => {
	const demo = await setup(200);
	t.after(demo.close);
	const first = await demo.peer();
	const second = await demo.peer();
	const { sessionId } = object(await first.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
		sessionId: string;
	};
	await second.request("session/attach", { sessionId });
	await first.request("session/prompt", prompt(sessionId, "slow replay"));
	const session = demo.host.sessions.get(sessionId)!;
	await until(() => session.journal.filter((update) => update.sessionUpdate === "agent_message_chunk").length > 5);
	const replay = object(await second.request("session/attach", { sessionId }));
	const responseId = second.lastRequestId;
	await until(() => !session.run);
	const expected = session.journal
		.filter((update) => update.sessionUpdate === "agent_message_chunk")
		.map((update) => (update.sessionUpdate === "agent_message_chunk" ? metadata(update.content).text : ""))
		.join("");
	await until(() =>
		second.messages.some(
			(message) =>
				"method" in message &&
				metadata(object(message.params).update).state === "idle" &&
				metadata(object(message.params).update).stopReason === "end_turn",
		),
	);
	const index = second.messages.findIndex(
		(message) => "id" in message && message.id === responseId && "result" in message,
	);
	const history = (replay.history as { type: string; update?: Record<string, unknown> }[])
		.filter((item) => item.update?.sessionUpdate === "agent_message_chunk")
		.map((item) => metadata(item.update!.content).text)
		.join("");
	const live = second.messages
		.slice(index + 1)
		.filter(
			(message) =>
				"method" in message && metadata(object(message.params).update).sessionUpdate === "agent_message_chunk",
		)
		.map((message) => ("method" in message ? metadata(metadata(object(message.params).update).content).text : ""))
		.join("");
	assert.equal(history + live, expected);
	assert.equal(session.peers.size, 2);
});

test("a failed v1 turn releases its response barrier for later work", { timeout: 15000 }, async (t) => {
	const demo = await setup();
	t.after(demo.close);
	const peer = await demo.peer(1);
	const { sessionId } = object(await peer.request("session/new", { cwd: demo.cwd, mcpServers: [] })) as {
		sessionId: string;
	};
	demo.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "expected shared failure" }),
		fauxAssistantMessage("recovered"),
	]);
	const input = (text: string) => ({ sessionId, prompt: [{ type: "text", text }] });
	await assert.rejects(peer.request("session/prompt", input("first")), errorCode(-32603));
	assert.equal(object(await peer.request("session/prompt", input("next"))).stopReason, "end_turn");
	const output = peer.messages
		.filter(
			(message) =>
				"method" in message && metadata(object(message.params).update).sessionUpdate === "agent_message_chunk",
		)
		.map((message) => ("method" in message ? metadata(metadata(object(message.params).update).content).text : ""))
		.join("");
	assert(output.includes("recovered"));
});
