/** Shared connection types and validation for custom ACP inputs. */
import { RequestError } from "@agentclientprotocol/sdk";
import type { SessionUpdate, StateUpdate } from "@agentclientprotocol/sdk/experimental/v2";

export type Update = Extract<
	SessionUpdate,
	{
		sessionUpdate:
			| "user_message"
			| "agent_message_chunk"
			| "agent_thought_chunk"
			| "tool_call_update"
			| "state_update"
			| "notice";
	}
>;

export interface Peer {
	id: string;
	info: { name: string; version: string };
	version: 1 | 2;
	capabilities: Record<string, unknown>;
	signal: AbortSignal;
	request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
	update(sessionId: string, update: Update): Promise<void>;
	project(sessionId: string, update: Update): unknown[];
	notify(method: string, params: unknown): Promise<void>;
}

export type Foreground = Extract<StateUpdate, { state: "idle" | "running" | "requires_action" }>;

/** Validate an object at the custom-method or configuration boundary. */
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw RequestError.invalidParams(undefined, "Expected object");
	return value as Record<string, unknown>;
}

/** Validate a string at the custom-method or configuration boundary. */
export function text(value: unknown): string {
	if (typeof value !== "string") throw RequestError.invalidParams(undefined, "Expected string");
	return value;
}

/** Read optional capability metadata without inferring support. */
export function metadata(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? object(value) : {};
}

/** Reject a competing prompt or session owner. */
export function busy(): never {
	throw new RequestError(-32600, "Session is busy", { reason: "session_busy" });
}
