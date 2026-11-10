/** One backend module adds an API and can also supply ordinary Pi extension hooks. */
import { RequestError } from "@agentclientprotocol/sdk";
import type { Harness } from "@pi-acp/harness";

/** Install the sample contract consumed by native code and a separate UI extension. */
export function installTasks(host: Harness): void {
	host.registerCapability("com.example/tasks", { version: 1 });
	host.onRequest("_com.example/tasks/list", (params, ctx) => {
		const session = ctx.session(sessionId(params));
		return { tasks: [{ id: "sdk", title: `Pi tool calls: ${session.toolCalls}`, status: session.state.state }] };
	});
	host.onRequest("_com.example/tasks/callback", (params, ctx) => {
		ctx.session(sessionId(params));
		const capability = ctx.capability("com.example/ui");
		if (!capability || typeof capability !== "object" || !("version" in capability) || capability.version !== 1)
			throw new RequestError(-32600, "Frontend API unavailable", { reason: "capability_unavailable" });
		return ctx.request("_com.example/ui/ping", { text: "ping" });
	});
}

function sessionId(params: unknown): string {
	if (!params || typeof params !== "object" || !("sessionId" in params) || typeof params.sessionId !== "string")
		throw RequestError.invalidParams(undefined, "Expected a sessionId");
	return params.sessionId;
}
