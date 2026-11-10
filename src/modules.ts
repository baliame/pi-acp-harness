/** Public startup contracts for optional protocol policies and wire additions. */
import type { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2";
import type { Harness } from "./harness.ts";
import type { Session, StopReason } from "./session.ts";
import type { Peer, Update } from "./wire.ts";

export interface ProtocolContext {
	host: Harness;
	peer: Peer;
	signal: AbortSignal;
	requestId: string | number | null;
	fields: Record<string, unknown>;
	afterResponse(action: () => void): void;
}

export interface ProtocolModule {
	id: string;
	requires?: string[];
	methods?: Record<string, (params: unknown, context: ProtocolContext) => unknown | Promise<unknown>>;
	fields?: Record<string, Record<string, (value: unknown) => unknown>>;
	updates?: Record<string, (value: unknown) => unknown>;
	capabilities?(version: 1 | 2, capabilities: Record<string, unknown>): void;
	session?(session: Session): void;
}

export interface Participation {
	readonly peers: ReadonlySet<Peer>;
	attach(peer: Peer, replay: boolean): Promise<void>;
	detach(peer: Peer): void;
	emit(update: Update): void;
	flush(): Promise<void>;
	notify(method: `_${string}`, params: unknown): void;
	interact(request: Interaction, signal: AbortSignal): Promise<unknown>;
	prompted?(
		peer: Peer,
		content: ContentBlock[],
		messageId: string,
		run: Promise<StopReason>,
		afterResponse: ProtocolContext["afterResponse"],
	): Promise<void>;
}

export type Interaction = (peer: Peer) => { method: string; params: unknown };

export interface PromptResult {
	messageId: string;
	completion: Promise<StopReason>;
	flushed?: Promise<void>;
}

export interface Delivery {
	submit(peer: Peer, content: ContentBlock[], context: ProtocolContext): Promise<PromptResult>;
	removePeer(peer: Peer): void;
	close(): void;
}
