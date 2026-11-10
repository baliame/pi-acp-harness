/** Optional queue-only prompt delivery; Pi remains the owner of each executing turn. */
import { randomUUID } from "node:crypto";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2";
import type { Delivery, PromptResult, ProtocolContext, ProtocolModule } from "../modules.ts";
import type { Session } from "../session.ts";
import { busy, metadata, type Peer } from "../wire.ts";

export const deliveryRevision = "ee193af58f211a1cbfde30029d5283f9c94c554c";

export interface QueueEntry {
	id: string;
	clientId: string;
	prompt: ContentBlock[];
	receivedAt: string;
}

export interface QueueSnapshot {
	sessionId: string;
	revision: number;
	entries: QueueEntry[];
}

export interface QueueChange {
	type: "enqueue" | "start" | "pop" | "withdraw" | "disconnect" | "close";
	entryId: string;
	byClientId?: string;
}

export interface QueueService {
	snapshot(): QueueSnapshot;
	pop(expectedHeadId: string | null, peer: Peer): QueueSnapshot & { removed: QueueEntry | null };
	subscribe(listener: (snapshot: QueueSnapshot, change: QueueChange) => void): () => void;
}

export interface PromptDeliveryModule extends ProtocolModule {
	queue(session: Session): QueueService;
}

interface Waiting {
	afterResponse: ProtocolContext["afterResponse"];
	entry: QueueEntry;
	peer: Peer;
	resolve(result: PromptResult): void;
	reject(error: unknown): void;
	dispose(): void;
}

/** Create a queue module with a public service for independent capability consumers. */
export function promptDelivery(): PromptDeliveryModule {
	const queues = new WeakMap<Session, QueuedDelivery>();
	return {
		id: "prompt-delivery",
		fields: {
			"session/prompt": {
				delivery: (value) => {
					if (value !== "queue") throw RequestError.invalidParams(undefined, "Unsupported prompt delivery");
					return value;
				},
			},
		},
		capabilities: (version, capabilities) => {
			const meta = metadata(capabilities._meta);
			capabilities._meta = meta;
			meta["com.example/experimental-acp"] = {
				...metadata(meta["com.example/experimental-acp"]),
				delivery: { revision: deliveryRevision, profile: 1 },
			};
			if (version === 2) {
				const session = metadata(capabilities.session);
				capabilities.session = session;
				session.prompt = { ...metadata(session.prompt), delivery: { queue: {} } };
			}
		},
		session: (session) => {
			const queue = new QueuedDelivery(session);
			queues.set(session, queue);
			session.delivery = queue;
		},
		queue: (session) => {
			const queue = queues.get(session);
			if (!queue) throw new Error("Prompt delivery is not installed for this session");
			return queue;
		},
	};
}

class QueuedDelivery implements Delivery, QueueService {
	private session: Session;
	private waiting: Waiting[] = [];
	private revision = 0;
	private listeners = new Set<(snapshot: QueueSnapshot, change: QueueChange) => void>();
	private scheduled = false;

	constructor(session: Session) {
		this.session = session;
	}

	async submit(peer: Peer, content: ContentBlock[], context: ProtocolContext): Promise<PromptResult> {
		if (this.session.closing) busy();
		if (peer.version === 1 && "delivery" in context.fields)
			throw RequestError.invalidParams(undefined, "delivery is a v2 field");
		if (context.signal.aborted) throw RequestError.requestCancelled();
		if (!this.session.run && !this.waiting.length) return this.start(peer, content, context.afterResponse);
		if (peer.version === 1 && !this.session.participation) busy();
		if (peer.version === 2 && context.fields.delivery !== "queue") busy();
		if (this.waiting.length >= 100) throw new RequestError(-32600, "Queue is full", { reason: "queue_full" });
		return new Promise((resolve, reject) => {
			const signal = AbortSignal.any([context.signal, peer.signal]);
			const remove = () => this.remove(waiting, peer.signal.aborted ? "disconnect" : "withdraw", peer.id);
			const waiting: Waiting = {
				afterResponse: context.afterResponse,
				entry: { id: randomUUID(), clientId: peer.id, prompt: content, receivedAt: new Date().toISOString() },
				peer,
				resolve,
				reject,
				dispose: () => signal.removeEventListener("abort", remove),
			};
			this.waiting.push(waiting);
			signal.addEventListener("abort", remove, { once: true });
			this.changed({ type: "enqueue", entryId: waiting.entry.id, byClientId: peer.id });
			this.schedule();
		});
	}

	snapshot(): QueueSnapshot {
		return { sessionId: this.session.id, revision: this.revision, entries: this.waiting.map(({ entry }) => entry) };
	}

	pop(expectedHeadId: string | null, peer: Peer): QueueSnapshot & { removed: QueueEntry | null } {
		const head = this.waiting[0];
		if (expectedHeadId !== (head?.entry.id ?? null))
			throw new RequestError(-32600, "Queue changed", { reason: "queue_changed" });
		if (head) this.remove(head, "pop", peer.id);
		return { ...this.snapshot(), removed: head?.entry ?? null };
	}

	subscribe(listener: (snapshot: QueueSnapshot, change: QueueChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	removePeer(peer: Peer): void {
		for (const waiting of this.waiting.slice())
			if (waiting.peer === peer) this.remove(waiting, "disconnect", peer.id);
	}

	close(): void {
		for (const waiting of this.waiting.slice()) this.remove(waiting, "close");
	}

	private start(peer: Peer, content: ContentBlock[], afterResponse: ProtocolContext["afterResponse"]): PromptResult {
		const messageId = this.session.prompt(content);
		const completion = this.session.run!;
		const flushed = this.session.participation?.prompted?.(peer, content, messageId, completion, afterResponse);
		void completion.then(() => this.schedule());
		return { messageId, completion, flushed };
	}

	private schedule(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		void Promise.resolve().then(() => {
			this.scheduled = false;
			if (this.session.closing || this.session.run || !this.waiting.length) return;
			const waiting = this.waiting.shift()!;
			waiting.dispose();
			this.changed({ type: "start", entryId: waiting.entry.id });
			try {
				waiting.resolve(this.start(waiting.peer, waiting.entry.prompt, waiting.afterResponse));
			} catch (error) {
				waiting.reject(error);
				this.schedule();
			}
		});
	}

	private remove(waiting: Waiting, type: QueueChange["type"], byClientId?: string): void {
		const index = this.waiting.indexOf(waiting);
		if (index < 0) return;
		this.waiting.splice(index, 1);
		waiting.dispose();
		waiting.reject(RequestError.requestCancelled());
		this.changed({ type, entryId: waiting.entry.id, byClientId });
	}

	private changed(change: QueueChange): void {
		this.revision++;
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot, change);
	}
}
