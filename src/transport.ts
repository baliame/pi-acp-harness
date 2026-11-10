/** Official ACP transports for a process-owned host and disposable stdio attachment. */

import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket, WebSocketServer } from "ws";
import type { Harness } from "./harness.ts";

/** Start a single-user persistent ACP endpoint on loopback. */
export async function serve(host: Harness, port = 0): Promise<{ url: string; close(): Promise<void> }> {
	host.start();
	const acp = new AcpServer({ createAgent: () => host.router() });
	const handler = createNodeHttpHandler(acp);
	const server = createServer((request, response) => {
		const address = server.address() as AddressInfo;
		if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${address.port}`) {
			response.writeHead(403).end();
			return;
		}
		handler(request, response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}/acp`,
		close: async () => {
			await host.close();
			await acp.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

export interface SharedServerOptions {
	tokenFile: string;
	port?: number;
	origins?: string[];
}

/** Serve opt-in native HTTP/WebSocket connections for one trusted local operator. */
export async function serveShared(
	host: Harness,
	options: SharedServerOptions,
): Promise<{ url: string; wsUrl: string; close(): Promise<void> }> {
	const token = (await readFile(options.tokenFile, "utf8")).trim();
	if (token.length < 16 || /\s/.test(token))
		throw new Error("Expected a local bearer token of at least 16 non-space characters");
	host.start();
	const acp = new AcpServer({ createAgent: () => host.router() });
	const handler = createNodeHttpHandler(acp);
	const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	const upgrade = createNodeWebSocketUpgradeHandler(acp, sockets);
	const allowed = new Set(options.origins ?? []);
	const authorized = (request: Parameters<typeof handler>[0], websocket: boolean) => {
		const address = server.address() as AddressInfo;
		if (request.headers.host !== `127.0.0.1:${address.port}`) return false;
		if (request.headers.origin !== undefined && !allowed.has(request.headers.origin)) return false;
		let url: URL;
		try {
			url = new URL(request.url ?? "/", `http://127.0.0.1:${address.port}`);
		} catch {
			return false;
		}
		if (url.pathname !== "/acp") return false;
		const authorization = request.headers.authorization;
		const provided = authorization?.startsWith("Bearer ")
			? authorization.slice(7)
			: websocket && !authorization
				? url.searchParams.get("token")
				: null;
		return (
			provided !== null &&
			provided !== undefined &&
			Buffer.byteLength(provided) === Buffer.byteLength(token) &&
			timingSafeEqual(Buffer.from(provided), Buffer.from(token))
		);
	};
	const server = createServer((request, response) => {
		if (!authorized(request, false)) {
			response.writeHead(403).end();
			return;
		}
		handler(request, response);
	});
	server.on("upgrade", (request, socket, head) => {
		if (!authorized(request, true)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		upgrade(request, socket, head);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}/acp`,
		wsUrl: `ws://127.0.0.1:${address.port}/acp`,
		close: async () => {
			await host.close();
			await acp.close();
			for (const socket of sockets.clients) socket.terminate();
			await new Promise<void>((resolve) => sockets.close(() => resolve()));
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

/** Run a standard client-owned stdio agent. */
export async function stdio(host: Harness): Promise<void> {
	const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
	const connection = host.router().connect(stream);
	try {
		await connection.closed;
	} finally {
		await host.close();
	}
}

/** Attach stdio to an existing HTTP endpoint without interpreting ACP messages. */
export async function attach(url: string, tokenFile?: string): Promise<void> {
	const local = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
	const headers: Record<string, string> = tokenFile
		? { Authorization: `Bearer ${(await readFile(tokenFile, "utf8")).trim()}` }
		: {};
	const remote = ["ws:", "wss:"].includes(new URL(url).protocol)
		? createWebSocketStream(url, { WebSocket, headers })
		: createHttpStream(url, { headers });
	const abort = new AbortController();
	const stop = () => abort.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await Promise.race([
			local.readable.pipeTo(remote.writable, { signal: abort.signal }),
			remote.readable.pipeTo(local.writable, { signal: abort.signal }),
		]);
	} catch (error) {
		if (!abort.signal.aborted) throw error;
	} finally {
		abort.abort();
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}
