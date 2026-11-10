/** Pinned optional ACP attachment with equal participants and one interaction outcome. */
import { randomUUID } from "node:crypto";
import { RequestError } from "@agentclientprotocol/sdk";
import { DEFAULT_MAX_BUFFERED_BYTES, DEFAULT_MAX_OUTPUT_STALL_MS } from "@agentclientprotocol/sdk/experimental/server";
import type { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2";
import type { Interaction, Participation, ProtocolContext, ProtocolModule } from "../modules.ts";
import type { Session, StopReason } from "../session.ts";
import { busy, metadata, object, type Peer, text, type Update } from "../wire.ts";

export const attachRevision = "98e098b7ca7c289066d20f73411ce649081d378b";

interface Member {
	peer: Peer;
	ready: boolean;
	lifetime: AbortController;
	replay: Promise<void>;
	initial?: Boundary;
	output: Promise<void>;
	bytes: number;
	buffer: (() => void)[];
}

interface Boundary {
	index: number;
	state: Session["state"];
	pending: unknown[];
}

interface PendingInteraction {
	id: string;
	request: Interaction;
	attempts: Map<Peer, AbortController>;
	cancelled: Set<Peer>;
	unavailable: Set<Peer>;
	finish(value: unknown, peer?: Peer): void;
}

/** Create the independently selectable multi-client attach module. */
export function multiClientAttach(): ProtocolModule {
	return {
		id: "multi-client-attach",
		updates: Object.fromEntries(
			["prompt_received", "turn_complete", "permission_resolved", "client_disconnected"].map((tag) => [
				tag,
				parseUpdate,
			]),
		),
		capabilities: (_version, capabilities) => {
			const meta = metadata(capabilities._meta);
			capabilities._meta = meta;
			meta["com.example/experimental-acp"] = {
				...metadata(meta["com.example/experimental-acp"]),
				attach: { revision: attachRevision, profile: 1 },
			};
		},
		session: (session) => {
			session.participation = new SharedSession(session);
		},
		methods: {
			"session/attach": async (params, ctx) => {
				const value = object(params);
				const session = ctx.host.sessions.get(text(value.sessionId));
				if (!session) throw new RequestError(-32002, "Unknown session");
				if (session.closing) throw new RequestError(-32600, "Session is closing");
				if (value.clientId !== undefined) {
					const id = text(value.clientId);
					for (const existing of ctx.host.sessions.values()) {
						if (existing.has(ctx.peer) && ctx.peer.id !== id)
							throw RequestError.invalidParams(undefined, "An attached client's ID cannot change");
						if ([...existing.peers].some((peer) => peer !== ctx.peer && peer.id === id))
							throw RequestError.invalidParams(undefined, "Client ID is already in use");
					}
				}
				if (!session.extensionsActive) throw new RequestError(-32600, "Resume the closed session before attaching");
				// This module installs the same policy on every session in its host.
				const shared = session.participation as SharedSession;
				const { result, release } = await shared.join(ctx.peer, value);
				ctx.afterResponse(release);
				return result;
			},
			"session/detach": (params, ctx) => {
				const session = ctx.host.active(ctx.peer, text(object(params).sessionId));
				session.detach(ctx.peer);
				return { sessionId: session.id, status: "detached" };
			},
		},
	};
}

class SharedSession implements Participation {
	readonly peers = new Set<Peer>();
	private session: Session;
	private members = new Map<Peer, Member>();
	private history: { update: Update; timestamp: string }[] = [];
	private interactions = new Map<string, PendingInteraction>();

	constructor(session: Session) {
		this.session = session;
	}

	async attach(peer: Peer, replay: boolean): Promise<void> {
		if ([...this.peers].some((member) => member !== peer)) busy();
		this.add(peer);
		const member = this.members.get(peer)!;
		const gate = await this.beginReplay(member);
		const retained = replay ? this.history.slice(0, gate.boundary.index) : [];
		try {
			await gate.output;
			for (const record of retained) await peer.update(this.session.id, record.update);
		} finally {
			gate.release();
		}
		await member.output;
	}

	async join(
		peer: Peer,
		params: Record<string, unknown>,
	): Promise<{ result: Record<string, unknown>; release(): void }> {
		const requested = params.historyPolicy === undefined ? "full" : text(params.historyPolicy);
		if (!["full", "pending_only", "none", "after_message"].includes(requested))
			throw RequestError.invalidParams(undefined, "Unknown history policy");
		if (params.clientId !== undefined) {
			const id = text(params.clientId);
			if ([...this.peers].some((member) => member !== peer && member.id === id))
				throw RequestError.invalidParams(undefined, "Client ID is already in use");
			if (!this.peers.has(peer)) peer.id = id;
		}
		if (params.clientInfo !== undefined) {
			const info = object(params.clientInfo);
			peer.info = { name: text(info.name), version: text(info.version) };
		}
		const cursor = requested === "after_message" ? text(params.afterMessageId) : undefined;
		this.add(peer);
		const gate = await this.beginReplay(this.members.get(peer)!);
		const retained = this.history.slice(0, gate.boundary.index);
		let policy = requested;
		let start = 0;
		if (policy === "after_message") {
			const index = retained.findLastIndex(({ update }) => "messageId" in update && update.messageId === cursor);
			if (index < 0) policy = "full";
			else start = index + 1;
		}
		const connectedClients = [...this.peers].filter((member) => member !== peer).map(participant);
		const history =
			policy === "pending_only" || policy === "none"
				? []
				: retained
						.slice(start)
						.flatMap(({ update, timestamp }) =>
							peer
								.project(this.session.id, update)
								.map((projection) => ({ type: "session_update", update: projection, timestamp })),
						);
		if (policy !== "none") {
			if (policy !== "pending_only")
				for (const update of peer.project(this.session.id, {
					sessionUpdate: "state_update",
					...gate.boundary.state,
				}))
					history.push({ type: "session_update", update, timestamp: new Date().toISOString() });
		}
		const result = {
			sessionId: this.session.id,
			clientId: peer.id,
			connectedClients,
			historyPolicy: policy,
			...(policy === "none" ? {} : { history: [...history, ...gate.boundary.pending] }),
		};
		await gate.output;
		return { result, release: gate.release };
	}

	private release(member: Member): void {
		const peer = member.peer;
		if (this.members.get(peer) !== member) return;
		member.ready = true;
		for (const send of member.buffer.splice(0)) send();
		const snapshot: Update = { sessionUpdate: "state_update", ...this.session.state };
		this.send(member, snapshot, () => peer.update(this.session.id, snapshot));
		for (const pending of this.interactions.values()) this.ask(pending, peer);
	}

	detach(peer: Peer): void {
		if (!this.peers.delete(peer)) return;
		this.members.get(peer)!.lifetime.abort();
		this.members.delete(peer);
		for (const pending of this.interactions.values()) {
			pending.attempts.get(peer)?.abort();
			pending.attempts.delete(peer);
			pending.cancelled.delete(peer);
			pending.unavailable.delete(peer);
			this.checkCancelled(pending);
		}
		this.broadcast({
			sessionUpdate: "client_disconnected",
			client: participant(peer),
			timestamp: new Date().toISOString(),
		});
	}

	emit(update: Update): void {
		if (update.sessionUpdate !== "state_update" && update.sessionUpdate !== "notice")
			this.history.push({ update, timestamp: new Date().toISOString() });
		// Input needs its source participant before selecting an echo projection.
		if (update.sessionUpdate === "user_message") return;
		for (const member of this.members.values())
			this.send(member, update, () => member.peer.update(this.session.id, update));
	}

	prompted(
		source: Peer,
		content: ContentBlock[],
		messageId: string,
		run: Promise<StopReason>,
		afterResponse: ProtocolContext["afterResponse"],
	): Promise<void> {
		for (const member of this.members.values()) {
			const peer = member.peer;
			if (peer === source && peer.version === 1 && !this.aware(peer)) continue;
			if (peer !== source && this.aware(peer))
				this.send(member, content, () =>
					this.draft(peer, {
						sessionUpdate: "prompt_received",
						prompt: content,
						sentBy: participant(source),
						messageId,
					}),
				);
			else
				this.send(member, content, () =>
					peer.update(this.session.id, { sessionUpdate: "user_message", content, messageId }),
				);
		}
		return run.then(async (stopReason) => {
			const member = this.members.get(source);
			const output = source.version === 1 && member ? this.completeTurn(member, afterResponse) : undefined;
			for (const member of this.members.values())
				if (member.peer !== source && this.aware(member.peer))
					this.send(member, stopReason, () =>
						this.draft(member.peer, { sessionUpdate: "turn_complete", stopReason }),
					);
			await output;
		});
	}

	async flush(): Promise<void> {
		// Each member preserves order; a stalled member must not hold up the Pi run.
	}

	notify(method: `_${string}`, params: unknown): void {
		for (const member of this.members.values()) this.send(member, params, () => member.peer.notify(method, params));
	}

	interact(request: Interaction, signal: AbortSignal): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) {
				reject(RequestError.requestCancelled());
				return;
			}
			const pending: PendingInteraction = {
				id: randomUUID(),
				request,
				attempts: new Map(),
				cancelled: new Set(),
				unavailable: new Set(),
				finish: (value, peer) => {
					if (!this.interactions.delete(pending.id)) return;
					signal.removeEventListener("abort", cancel);
					for (const attempt of pending.attempts.values()) attempt.abort();
					if (peer) {
						const call = request(peer);
						const params = object(call.params);
						const tool = metadata(params.toolCall ?? metadata(params.subject).toolCall);
						this.broadcast({
							sessionUpdate: "permission_resolved",
							toolCallId: tool.toolCallId ?? pending.id,
							chosenOptionId: metadata(object(value).outcome).optionId ?? object(value).action ?? null,
							resolvedBy: participant(peer),
						});
					}
					resolve(value);
				},
			};
			const cancel = () => {
				if (!this.interactions.delete(pending.id)) return;
				for (const attempt of pending.attempts.values()) attempt.abort();
				reject(RequestError.requestCancelled());
			};
			this.interactions.set(pending.id, pending);
			signal.addEventListener("abort", cancel, { once: true });
			for (const member of this.members.values()) if (member.ready) this.ask(pending, member.peer);
		});
	}

	private pendingFor(peer?: Peer): unknown[] {
		if (!peer) return [];
		return [...this.interactions.values()].map((pending) => {
			const request = pending.request(peer);
			const params = object(request.params);
			const tool = metadata(params.toolCall ?? metadata(params.subject).toolCall);
			return { type: "permission_request", toolCallId: tool.toolCallId ?? pending.id, status: "pending", request };
		});
	}

	private ask(pending: PendingInteraction, peer: Peer): void {
		if (pending.attempts.has(peer) || pending.unavailable.has(peer) || peer.signal.aborted) return;
		const call = pending.request(peer);
		if (call.method === "elicitation/create" && !metadata(peer.capabilities.elicitation).form) return;
		const attempt = new AbortController();
		pending.attempts.set(peer, attempt);
		void peer
			.request(call.method, call.params, AbortSignal.any([attempt.signal, peer.signal]))
			.then((value) => {
				if (!this.interactions.has(pending.id) || !this.peers.has(peer) || attempt.signal.aborted) return;
				const result = object(value);
				const outcome = metadata(result.outcome);
				// Session builds the option list; the generic interaction callback erases its type.
				const options = object(call.params).options as { optionId: string }[] | undefined;
				if (
					call.method === "session/request_permission" &&
					outcome.outcome === "selected" &&
					options?.some((entry) => entry.optionId === outcome.optionId)
				)
					pending.finish(value, peer);
				else if (call.method === "elicitation/create" && ["accept", "decline"].includes(String(result.action)))
					pending.finish(value, peer);
				else if (outcome.outcome === "cancelled" || result.action === "cancel") {
					pending.cancelled.add(peer);
					this.checkCancelled(pending);
				}
			})
			.catch(() => {
				if (!this.interactions.has(pending.id)) return;
				pending.attempts.delete(peer);
				if (this.peers.has(peer)) pending.unavailable.add(peer);
				this.checkCancelled(pending);
			});
	}

	private checkCancelled(pending: PendingInteraction): void {
		const recipients = [...pending.attempts.keys()].filter((peer) => this.peers.has(peer));
		if (!recipients.length || !recipients.every((peer) => pending.cancelled.has(peer))) return;
		const peer = recipients[0]!;
		pending.finish(
			pending.request(peer).method === "elicitation/create"
				? { action: "cancel" }
				: { outcome: { outcome: "cancelled" } },
			peer,
		);
	}

	private add(peer: Peer): void {
		if (this.peers.has(peer)) return;
		this.peers.add(peer);
		this.members.set(peer, {
			peer,
			ready: false,
			lifetime: new AbortController(),
			replay: Promise.resolve(),
			initial: this.boundary(peer),
			output: Promise.resolve(),
			bytes: 0,
			buffer: [],
		});
	}

	private boundary(peer: Peer): Boundary {
		return { index: this.history.length, state: this.session.state, pending: this.pendingFor(peer) };
	}

	private async beginReplay(member: Member): Promise<{ boundary: Boundary; output: Promise<void>; release(): void }> {
		const previous = member.replay;
		let finish!: () => void;
		member.replay = new Promise((resolve) => {
			finish = resolve;
		});
		member.lifetime.signal.addEventListener("abort", finish, { once: true });
		await previous;
		if (member.lifetime.signal.aborted) throw RequestError.requestCancelled();
		member.ready = false;
		const boundary = member.initial ?? this.boundary(member.peer);
		member.initial = undefined;
		return {
			boundary,
			output: member.output,
			release: () => {
				member.lifetime.signal.removeEventListener("abort", finish);
				this.release(member);
				finish();
			},
		};
	}

	private completeTurn(member: Member, afterResponse: ProtocolContext["afterResponse"]): Promise<void> {
		let presented!: () => void;
		let release!: () => void;
		const flushed = new Promise<void>((resolve) => {
			presented = resolve;
		});
		const response = new Promise<void>((resolve) => {
			release = resolve;
		});
		const gone = () => {
			presented();
			release();
		};
		member.lifetime.signal.addEventListener("abort", gone, { once: true });
		afterResponse(() => {
			member.lifetime.signal.removeEventListener("abort", gone);
			release();
		});
		// This queue marker separates the old turn's output from the member's next turn.
		this.send(member, null, async () => {
			presented();
			await response;
		});
		return flushed;
	}

	private send(member: Member, payload: unknown, action: () => Promise<void>): void {
		const bytes = Buffer.byteLength(JSON.stringify(payload)) + 512;
		member.bytes += bytes;
		if (member.bytes > DEFAULT_MAX_BUFFERED_BYTES) {
			this.session.detach(member.peer);
			return;
		}
		const send = () => {
			member.output = member.output
				.then(async () => {
					if (!this.peers.has(member.peer)) return;
					let timer: ReturnType<typeof setTimeout>;
					try {
						await Promise.race([
							action(),
							new Promise<never>((_resolve, reject) => {
								timer = setTimeout(
									() => reject(new Error("Participant output stalled")),
									DEFAULT_MAX_OUTPUT_STALL_MS,
								);
								timer.unref();
							}),
						]);
					} finally {
						clearTimeout(timer!);
						member.bytes -= bytes;
					}
				})
				.catch(() => this.session.detach(member.peer));
		};
		if (member.ready) send();
		else member.buffer.push(send);
	}

	private aware(peer: Peer): boolean {
		const profile = metadata(metadata(metadata(peer.capabilities._meta)["com.example/experimental-acp"]).attach);
		return profile.profile === 1 && profile.revision === attachRevision;
	}

	private draft(peer: Peer, update: Record<string, unknown>): Promise<void> {
		return peer.notify("session/update", { sessionId: this.session.id, update });
	}

	private broadcast(update: Record<string, unknown>): void {
		for (const member of this.members.values())
			if (this.aware(member.peer)) this.send(member, update, () => this.draft(member.peer, update));
	}
}

function parseUpdate(value: unknown): Record<string, unknown> {
	const update = object(value);
	switch (update.sessionUpdate) {
		case "prompt_received":
			text(update.messageId);
			validateParticipant(update.sentBy);
			if (!Array.isArray(update.prompt)) throw RequestError.invalidParams(undefined, "Expected prompt content");
			for (const value of update.prompt) {
				const content = object(value);
				if (content.type === "text") text(content.text);
				else if (content.type === "resource_link") text(content.uri);
				else throw RequestError.invalidParams(undefined, "Unsupported prompt content");
			}
			break;
		case "turn_complete":
			if (!["end_turn", "cancelled", "error", "max_tokens"].includes(text(update.stopReason)))
				throw RequestError.invalidParams(undefined, "Unknown turn completion");
			break;
		case "permission_resolved":
			text(update.toolCallId);
			validateParticipant(update.resolvedBy);
			if (update.chosenOptionId !== null) text(update.chosenOptionId);
			break;
		case "client_disconnected":
			validateParticipant(update.client);
			text(update.timestamp);
			break;
		default:
			throw RequestError.invalidParams(undefined, "Unknown attach update");
	}
	return update;
}

function participant(peer: Peer): { clientId: string; name: string; version: string } {
	return { clientId: peer.id, ...peer.info };
}

function validateParticipant(value: unknown): void {
	const client = object(value);
	text(client.clientId);
	text(client.name);
	text(client.version);
}
