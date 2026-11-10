/** Reconnect an official HTTP client to one persistent SDK host. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { serve } from "@pi-acp/harness";
import { createDemo } from "../examples/demo.ts";

test(
	"HTTP detach keeps sessions; a new connection resumes and retains model context",
	{ timeout: 15000 },
	async (t) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-acp-http-"));
		const { host } = await createDemo(cwd);
		const server = await serve(host);
		t.after(async () => {
			await server.close();
			await rm(cwd, { recursive: true, force: true });
		});
		const connect = async () => {
			const updates: acp.UpdateSessionNotification[] = [];
			let check: (() => void) | undefined;
			const connection = acp
				.client()
				.onNotification("session/update", ({ params }) => {
					updates.push(params);
					check?.();
				})
				.connect(createHttpStream(server.url));
			await connection.agent.request("initialize", {
				protocolVersion: 2,
				info: { name: "http-test", version: "1" },
			});
			return {
				connection,
				updates,
				agent: connection.agent,
				finished: (messageId: string) =>
					new Promise<void>((resolve) => {
						check = () => {
							const start = updates.findIndex(
								({ update }) => update.sessionUpdate === "user_message" && update.messageId === messageId,
							);
							if (
								start >= 0 &&
								updates
									.slice(start)
									.some(
										({ update }) =>
											update.sessionUpdate === "state_update" &&
											update.state === "idle" &&
											update.stopReason,
									)
							)
								resolve();
						};
						check();
					}),
			};
		};
		const first = await connect();
		const { sessionId } = await first.agent.request("session/new", { cwd, mcpServers: [] });
		const firstPrompt = await first.agent.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "first message" }],
		});
		await first.finished(firstPrompt.messageId);
		first.connection.close();
		await first.connection.closed;
		const second = await connect();
		t.after(() => second.connection.close());
		await second.agent.request("session/resume", { sessionId, cwd, mcpServers: [], replayFrom: { type: "start" } });
		const secondPrompt = await second.agent.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "second message" }],
		});
		await second.finished(secondPrompt.messageId);
		const output = second.updates
			.map(({ update }) =>
				acp.SessionUpdate.isAgentMessageChunk(update)
					? String(update.content.type === "text" ? update.content.text : "")
					: "",
			)
			.join("");
		assert(output.includes("User messages: 2"), output);
		assert.equal(host.sessions.size, 1);
		const denied = await fetch(server.url, { headers: { Origin: "https://example.com" } });
		assert.equal(denied.status, 403);
		assert.throws(() => host.registerCapability("com.example/late", {}), /Restart/);
	},
);
