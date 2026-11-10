/** Native multi-connection transports enforce the same local admission policy. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { serveShared } from "@pi-acp/harness";
import { multiClientAttach } from "@pi-acp/harness/experimental/multi-client-attach";
import { WebSocket } from "ws";
import { createDemo } from "../examples/demo.ts";

test(
	"HTTP and multiple native sockets share a registry; token, Host and Origin gate admission",
	{ timeout: 15000 },
	async (t) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-shared-network-"));
		const token = randomBytes(32).toString("base64url");
		const tokenFile = join(cwd, "token");
		await writeFile(tokenFile, token);
		const demo = await createDemo(cwd);
		demo.host.use(multiClientAttach());
		const origin = "http://127.0.0.1:31888";
		const server = await serveShared(demo.host, { tokenFile, origins: [origin] });
		t.after(async () => {
			await server.close();
			await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});
		const headers = { Authorization: `Bearer ${token}` };
		assert.equal((await fetch(server.url)).status, 403);
		assert.equal((await fetch(server.url, { headers: { Authorization: token } })).status, 403);
		assert.equal(
			(await fetch(server.url, { headers: { ...headers, Origin: "https://denied.example" } })).status,
			403,
		);
		const badHost = await new Promise<number>((resolve, reject) => {
			const attempt = request(server.url, { headers: { ...headers, Host: "localhost:1234" } }, (response) => {
				response.resume();
				resolve(response.statusCode!);
			});
			attempt.on("error", reject);
			attempt.end();
		});
		assert.equal(badHost, 403);
		for (const options of [
			{ headers: { Origin: origin } },
			{ headers: { ...headers, Origin: "https://denied.example" } },
		]) {
			await new Promise<void>((resolve, reject) => {
				const socket = new WebSocket(server.wsUrl, options);
				socket.once("open", () => {
					socket.terminate();
					reject(new Error("Unauthorized WebSocket accepted"));
				});
				socket.once("unexpected-response", (_request, response) => {
					assert.equal(response.statusCode, 403);
					response.resume();
					socket.terminate();
					resolve();
				});
				socket.on("error", () => {});
			});
		}
		const peers = [
			v2.client().connect(createHttpStream(server.url, { headers })),
			v2
				.client()
				.connect(
					createWebSocketStream(`${server.wsUrl}?token=${token}`, { WebSocket, headers: { Origin: origin } }),
				),
			v2.client().connect(createWebSocketStream(server.wsUrl, { WebSocket, headers })),
		];
		for (const peer of peers) t.after(() => peer.close());
		for (const peer of peers)
			await peer.agent.request("initialize", { protocolVersion: 2, info: { name: "transport-test", version: "1" } });
		const created = await Promise.all(
			peers.map((peer) => peer.agent.request("session/new", { cwd, mcpServers: [] })),
		);
		assert.equal(new Set(created.map((session) => session.sessionId)).size, 3);
		for (const peer of peers) assert.equal((await peer.agent.request("session/list", {})).sessions.length, 3);
	},
);
