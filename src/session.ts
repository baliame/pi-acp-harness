/** A real Pi session with retained ACP presentation and one attached client. */
import { randomUUID } from "node:crypto";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ContentBlock, ElicitationPropertySchema, ToolCallUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type {
	AgentSession,
	AgentSessionEvent,
	AgentToolResult,
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Delivery, Participation } from "./modules.ts";
import { busy, type Foreground, metadata, object, type Peer, type Update } from "./wire.ts";

export type StopReason = "end_turn" | "cancelled" | "error" | "max_tokens";

const idleStates: Record<StopReason, Foreground> = {
	end_turn: { state: "idle", stopReason: "end_turn" },
	cancelled: { state: "idle", stopReason: "cancelled" },
	error: { state: "idle", stopReason: "error" },
	max_tokens: { state: "idle", stopReason: "max_tokens" },
};

export class Session {
	readonly id = randomUUID();
	readonly journal: Update[] = [];
	readonly waiters = new Set<() => void>();
	participation?: Participation;
	delivery?: Delivery;
	pi!: AgentSession;
	extensionsActive = false;
	peer?: Peer;
	state: Foreground = { state: "idle" };
	closing = false;
	toolCalls = 0;
	run?: Promise<StopReason>;
	abort = new AbortController();
	piExtension?: ExtensionAPI;
	private output = Promise.resolve();
	private replaying = false;
	private pending: Update[] = [];
	private assistantId = "";
	private tools = new Map<string, ToolCallUpdate>();
	private changed = new Date().toISOString();
	private stopReason: StopReason = "end_turn";
	private interactions = 0;
	private diagnostic: (message: string) => void;
	readonly cwd: string;

	constructor(cwd: string, diagnostic: (message: string) => void) {
		this.cwd = cwd;
		this.diagnostic = diagnostic;
	}

	/** Install permission hooks into each ordinary Pi extension runtime. */
	extension(): ExtensionFactory {
		return (pi) => {
			pi.on("tool_call", async (event) => {
				const call = {
					toolCallId: event.toolCallId,
					title: event.toolName,
					name: event.toolName,
					rawInput: event.input,
				};
				this.tools.set(event.toolCallId, call);
				this.emit({ sessionUpdate: "tool_call_update", ...call, status: "pending" });
				const response = object(
					await this.interact((peer) => ({
						method: "session/request_permission",
						params: {
							sessionId: this.id,
							...(peer.version === 2
								? { title: `Allow ${event.toolName}?`, subject: { type: "tool_call", toolCall: call } }
								: { toolCall: call }),
							options: [
								{ optionId: "allow", name: "Allow once", kind: "allow_once" },
								{ optionId: "deny", name: "Deny", kind: "reject_once" },
							],
						},
					})),
				);
				const outcome = object(response.outcome);
				if (outcome.outcome !== "selected" || outcome.optionId !== "allow")
					return { block: true, reason: "Permission denied" };
				return undefined;
			});
		};
	}

	/** Attach exclusively and replay before releasing live traffic. */
	async attach(peer: Peer, replay: boolean): Promise<void> {
		if (this.participation) return this.participation.attach(peer, replay);
		if (this.peer && this.peer !== peer && !this.peer.signal.aborted) busy();
		this.peer = peer;
		this.replaying = true;
		this.pending = [];
		try {
			if (replay) for (const update of this.journal.slice()) await peer.update(this.id, update);
			while (this.pending.length) {
				const pending = this.pending;
				this.pending = [];
				for (const update of pending) await peer.update(this.id, update);
			}
			this.output = peer.update(this.id, { sessionUpdate: "state_update", ...this.state });
			this.replaying = false;
			await this.output;
			for (const wake of this.waiters) wake();
		} catch (error) {
			this.detach(peer);
			throw error;
		}
	}

	/** Release only this client's attachment; keep the SDK run alive. */
	detach(peer: Peer): void {
		this.delivery?.removePeer(peer);
		if (this.participation) {
			this.participation.detach(peer);
			return;
		}
		if (this.peer !== peer) return;
		this.peer = undefined;
		this.replaying = false;
		this.pending = [];
		for (const wake of this.waiters) wake();
	}

	/** Insert a user message and start one foreground SDK run. */
	prompt(content: ContentBlock[]): string {
		if (this.run || this.closing) busy();
		const prompt = content
			.map((item) => {
				if (item.type === "text") return String(item.text);
				if (item.type === "resource_link")
					return `${item.name ?? "Resource"}: ${item.uri}\n${item.description ?? ""}`;
				throw RequestError.invalidParams(undefined, "This harness accepts text and resource_link prompts");
			})
			.join("\n");
		const messageId = randomUUID();
		this.abort = new AbortController();
		this.stopReason = "end_turn";
		this.emit({ sessionUpdate: "user_message", messageId, content });
		this.setState({ state: "running" });
		this.run = this.execute(prompt).finally(() => {
			this.run = undefined;
		});
		return messageId;
	}

	/** Stop foreground work and pending interactions without deleting history. */
	async cancel(): Promise<void> {
		const run = this.run;
		this.abort.abort();
		await this.pi.abort();
		await run;
	}

	/** Flush output before completing lifecycle requests. */
	async flush(): Promise<void> {
		if (this.participation) return this.participation.flush();
		await this.output;
	}

	/** Test participation through the selected session policy. */
	has(peer: Peer): boolean {
		return this.participation ? this.participation.peers.has(peer) : this.peer === peer;
	}

	/** Read participants without coupling application APIs to a policy implementation. */
	get peers(): ReadonlySet<Peer> {
		return this.participation?.peers ?? new Set(this.peer ? [this.peer] : []);
	}

	/** Broadcast a capability event through the active participation and replay policy. */
	notify(method: `_${string}`, params: unknown): void {
		if (this.participation) {
			this.participation.notify(method, params);
			return;
		}
		const peer = this.peer;
		if (peer) void peer.notify(method, params).catch(() => this.detach(peer));
	}

	/** Return current session metadata without exposing local storage paths. */
	info(): { sessionId: string; cwd: string; updatedAt: string } {
		return { sessionId: this.id, cwd: this.cwd, updatedAt: this.changed };
	}

	/** Translate SDK deltas and tool events into retained ACP entities. */
	observe(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") this.assistantId = randomUUID();
				break;
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta" || update.type === "thinking_delta")
					this.emit({
						sessionUpdate: update.type === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk",
						messageId: this.assistantId,
						content: { type: "text", text: update.delta },
					});
				break;
			}
			case "message_end":
				if (event.message.role === "assistant") {
					if (event.message.stopReason === "error") this.stopReason = "error";
					if (event.message.stopReason === "aborted") this.stopReason = "cancelled";
					if (event.message.stopReason === "length") this.stopReason = "max_tokens";
					if (event.message.errorMessage)
						this.emit({
							sessionUpdate: "agent_message_chunk",
							messageId: this.assistantId,
							content: { type: "text", text: event.message.errorMessage },
						});
				}
				break;
			case "tool_execution_start":
				this.toolCalls++;
				this.emit({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					title: event.toolName,
					status: "in_progress",
					rawInput: event.args,
				});
				break;
			case "tool_execution_update":
				this.toolResult(event.toolCallId, event.partialResult, "in_progress");
				break;
			case "tool_execution_end":
				this.toolResult(event.toolCallId, event.result, event.isError ? "failed" : "completed");
				break;
		}
	}

	/** Ask through the current owner, retrying only after ownership changes. */
	async interact(
		request: (peer: Peer) => { method: string; params: unknown },
		signal: AbortSignal = this.abort.signal,
	): Promise<unknown> {
		this.interactions++;
		this.setState({ state: "requires_action" });
		try {
			if (this.participation) return await this.participation.interact(request, signal);
			for (;;) {
				const peer = await this.owner(signal);
				const attempt = AbortSignal.any([signal, peer.signal]);
				try {
					const call = request(peer);
					const result = await peer.request(call.method, call.params, attempt);
					if (this.peer === peer && !peer.signal.aborted) return result;
				} catch (error) {
					if (signal.aborted || (this.peer === peer && !peer.signal.aborted)) throw error;
				}
			}
		} finally {
			this.interactions--;
			if (!signal.aborted && !this.interactions) this.setState({ state: "running" });
		}
	}

	/** Collect one primitive value using negotiated form elicitation. */
	async form(title: string, schema: ElicitationPropertySchema, signal?: AbortSignal): Promise<unknown> {
		if (![...this.peers].some((peer) => metadata(peer.capabilities.elicitation).form)) return undefined;
		const response = object(
			await this.interact(
				() => ({
					method: "elicitation/create",
					params: {
						sessionId: this.id,
						mode: "form",
						message: title,
						requestedSchema: { type: "object", properties: { value: schema }, required: ["value"] },
					},
				}),
				signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal,
			),
		);
		return response.action === "accept" ? object(response.content).value : undefined;
	}

	/** Append ordered presentation updates without changing Pi's model context. */
	emit(update: Update): void {
		this.changed = new Date().toISOString();
		if (update.sessionUpdate !== "state_update" && update.sessionUpdate !== "notice") this.journal.push(update);
		if (this.participation) {
			this.participation.emit(update);
			return;
		}
		if (this.replaying) {
			this.pending.push(update);
			return;
		}
		const peer = this.peer;
		if (peer && !(peer.version === 1 && update.sessionUpdate === "user_message"))
			this.output = this.output
				.then(() => peer.update(this.id, update))
				.catch((error: unknown) => {
					if (!peer.signal.aborted) this.diagnostic(String(error));
					this.detach(peer);
				});
	}

	private setState(state: Foreground): void {
		this.state = state;
		this.emit({ sessionUpdate: "state_update", ...state });
	}

	private async execute(prompt: string): Promise<StopReason> {
		try {
			await this.pi.prompt(prompt, { source: "rpc" });
			await this.pi.waitForIdle();
		} catch (error) {
			if (!this.abort.signal.aborted) {
				this.stopReason = "error";
				this.emit({
					sessionUpdate: "agent_message_chunk",
					messageId: randomUUID(),
					content: { type: "text", text: String(error) },
				});
			}
		}
		const reason = this.abort.signal.aborted ? "cancelled" : this.stopReason;
		this.setState(idleStates[reason]);
		await this.flush();
		return reason;
	}

	private toolResult(id: string, result: AgentToolResult<unknown>, status: string): void {
		this.emit({
			sessionUpdate: "tool_call_update",
			toolCallId: id,
			status,
			content: result.content.map((item) => ({ type: "content", content: item })),
		});
	}

	private owner(signal: AbortSignal): Promise<Peer> {
		return new Promise((resolve, reject) => {
			const check = () => {
				if (!signal.aborted && (!this.peer || this.peer.signal.aborted || this.replaying)) return;
				this.waiters.delete(check);
				signal.removeEventListener("abort", check);
				if (signal.aborted) reject(RequestError.requestCancelled());
				else resolve(this.peer!);
			};
			this.waiters.add(check);
			signal.addEventListener("abort", check, { once: true });
			check();
		});
	}
}
