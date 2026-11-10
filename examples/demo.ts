/** Real Pi SDK sessions with a deterministic provider; no credentials or network calls. */
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { defineTool, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHarness } from "@pi-acp/harness";
import { Type } from "typebox";

/** Build a runnable example that still uses Pi's actual model loop and tools. */
export async function createDemo(cwd: string, tokensPerSecond = 1000) {
	const faux = fauxProvider({ provider: "poc", tokensPerSecond, tokenSize: { min: 2, max: 2 } });
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const counts = { executions: 0 };
	const host = createHarness({
		session: {
			model: faux.getModel(),
			modelRuntime,
			agentDir: join(cwd, ".artifacts/pi"),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			tools: ["read", "poc_echo", "mcp__*"],
		},
		extensions: [
			(pi) => {
				pi.registerTool(
					defineTool({
						name: "poc_echo",
						label: "PoC echo",
						description: "Return text without changing files",
						parameters: Type.Object({ text: Type.String() }),
						execute: async (_id, params, _signal, _update, ctx) => {
							counts.executions++;
							const value =
								params.text === "ask" ? await ctx.ui.input("What should the tool return?") : params.text;
							return { content: [{ type: "text", text: value ?? "Cancelled" }], details: {} };
						},
					}),
				);
			},
		],
	});
	const response: FauxResponseFactory = (context) => {
		const last = context.messages.at(-1);
		if (last?.role === "toolResult")
			return fauxAssistantMessage(
				`Tool result: ${last.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n")}`,
			);
		const users = context.messages.filter((message) => message.role === "user");
		const content = users.at(-1)?.content ?? "";
		const prompt =
			typeof content === "string"
				? content
				: content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("\n");
		if (prompt.includes("read"))
			return fauxAssistantMessage([fauxToolCall("read", { path: "sample.txt" })], { stopReason: "toolUse" });
		if (prompt.includes("form"))
			return fauxAssistantMessage([fauxToolCall("poc_echo", { text: "ask" })], { stopReason: "toolUse" });
		if (prompt.includes("tool"))
			return fauxAssistantMessage([fauxToolCall("poc_echo", { text: "hello from a Pi tool" })], {
				stopReason: "toolUse",
			});
		return fauxAssistantMessage(
			`Pi says: ${prompt}. User messages: ${users.length}. ${prompt.includes("slow") ? "Continuing while the frontend is detached. ".repeat(20) : ""}`,
		);
	};
	faux.setResponses(Array.from({ length: 200 }, () => response));
	return { host, faux, counts };
}
