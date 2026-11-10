/** Preserve declared draft fields and observe actual response writes around the SDK. */
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import type { ProtocolModule } from "./modules.ts";
import { metadata, object } from "./wire.ts";

export class ProtocolWire {
	private requests = new Map<
		string | number | null,
		{ method: string; fields: Record<string, unknown>; after: (() => void)[] }
	>();
	private writer?: WritableStreamDefaultWriter<AnyMessage>;
	private modules: readonly ProtocolModule[];

	constructor(modules: readonly ProtocolModule[]) {
		this.modules = modules;
	}

	/** Observe SDK output before releasing work that must follow its response. */
	wrap(stream: Stream): Stream {
		this.writer = stream.writable.getWriter();
		return {
			readable: stream.readable.pipeThrough(
				new TransformStream({
					transform: (message, controller) => {
						this.capture(message);
						controller.enqueue(message);
					},
				}),
			),
			writable: new WritableStream({
				write: async (message) => {
					if ("result" in message && this.requests.get(message.id)?.method === "initialize") {
						const result = metadata(message.result);
						if (result.protocolVersion === 1 || result.protocolVersion === 2) {
							const capabilities = object(
								result.protocolVersion === 1 ? result.agentCapabilities : result.capabilities,
							);
							for (const module of this.modules) module.capabilities?.(result.protocolVersion, capabilities);
						}
					}
					await this.writer!.write(message);
					if (!("method" in message)) {
						const pending = this.requests.get(message.id);
						this.requests.delete(message.id);
						for (const action of pending?.after ?? []) action();
					}
				},
				close: () => this.writer!.close(),
				abort: (reason) => this.writer!.abort(reason),
			}),
		};
	}

	/** Read only the registered fields retained from this request. */
	fields(id: string | number | null): Record<string, unknown> {
		const request = this.requests.get(id);
		if (!request) return {};
		for (const module of this.modules)
			for (const [name, parse] of Object.entries(module.fields?.[request.method] ?? {}))
				if (name in request.fields) parse(request.fields[name]);
		return request.fields;
	}

	/** Release an interaction only after the corresponding response is written. */
	afterResponse(id: string | number | null, action: () => void): void {
		const request = this.requests.get(id);
		if (request) request.after.push(action);
		else action();
	}

	/** Send a module-validated notification without baseline schema stripping. */
	async notify(method: string, params: unknown): Promise<void> {
		if (method === "session/update") {
			const notification = object(params);
			const update = object(notification.update);
			const tag = String(update.sessionUpdate);
			const parse = this.modules.map((module) => module.updates?.[tag]).find((parse) => parse !== undefined);
			if (!parse) throw new Error(`Unregistered draft update: ${tag}`);
			parse(update);
		}
		await this.writer!.write({ jsonrpc: "2.0", method, params });
	}

	private capture(message: unknown): void {
		// Transport JSON has not reached the SDK's envelope validator yet.
		const record = metadata(message);
		const id = record.id;
		if (
			typeof record.method !== "string" ||
			!(id === null || typeof id === "string" || (typeof id === "number" && Number.isInteger(id)))
		)
			return;
		const fields: Record<string, unknown> = {};
		const params = metadata(record.params);
		for (const module of this.modules)
			for (const name of Object.keys(module.fields?.[record.method] ?? {}))
				if (name in params) fields[name] = params[name];
		this.requests.set(id, { method: record.method, fields, after: [] });
	}
}
