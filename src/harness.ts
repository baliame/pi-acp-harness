/** Compose upstream Pi sessions with fixed ACP capabilities and method handlers. */

import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2";
import type {
	CreateAgentSessionOptions,
	ExtensionFactory,
	InlineExtension,
	McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	createMcpExtension,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PromptResult, ProtocolContext, ProtocolModule } from "./modules.ts";
import { createRouter } from "./protocol.ts";
import { Session } from "./session.ts";
import { createUI } from "./ui.ts";
import { metadata, object, type Peer, text } from "./wire.ts";

export interface HarnessOptions {
	session?: Omit<CreateAgentSessionOptions, "resourceLoader" | "sessionManager" | "cwd">;
	extensions?: InlineExtension[];
	diagnostic?: (message: string) => void;
}

export interface MethodContext {
	peer: Peer;
	signal: AbortSignal;
	session(id: string): Session;
	capability(name: string): unknown;
	request(method: `_${string}`, params: unknown): Promise<unknown>;
}

export type MethodHandler = (params: unknown, context: MethodContext) => unknown | Promise<unknown>;
export interface ConfigOption {
	configId: string;
	name: string;
	category: string;
	type: "select";
	currentValue: string;
	options: { value: string; name: string }[];
}

interface McpServer {
	name: string;
	config: McpServerConfig;
}

/** Create an SDK host; register capabilities before opening a transport. */
export function createHarness(options: HarnessOptions = {}): Harness {
	return new Harness(options);
}

export class Harness {
	readonly sessions = new Map<string, Session>();
	private protocolModules: ProtocolModule[] = [];
	private declarations: Record<string, unknown> = {};
	private requests = new Map<string, MethodHandler>();
	private notifications = new Map<string, MethodHandler>();
	private options: HarnessOptions;
	private started = false;
	private mcp = new Map<Session, McpServer[]>();

	constructor(options: HarnessOptions) {
		this.options = options;
	}

	/** Read the host's fixed capability declarations. */
	get capabilities(): Readonly<Record<string, unknown>> {
		return this.declarations;
	}

	/** Read the fixed protocol registrations without exposing their container. */
	get modules(): readonly ProtocolModule[] {
		return this.protocolModules;
	}

	/** Add a protocol module before any connections are accepted. */
	use(module: ProtocolModule): void {
		if (this.started) throw new Error("Restart the host to change protocol modules");
		if (this.modules.some((entry) => entry.id === module.id)) throw new Error(`Duplicate module: ${module.id}`);
		for (const method of Object.keys(module.methods ?? {})) {
			if (!method.startsWith("session/") || this.modules.some((entry) => method in (entry.methods ?? {})))
				throw new Error(`Duplicate or invalid protocol method: ${method}`);
			if (
				[
					"session/new",
					"session/list",
					"session/load",
					"session/resume",
					"session/prompt",
					"session/close",
					"session/set_config_option",
					"session/cancel",
				].includes(method)
			)
				throw new Error(`Cannot replace a baseline method: ${method}`);
		}
		for (const entry of this.modules) {
			for (const name of Object.keys(module.updates ?? {}))
				if (name in (entry.updates ?? {})) throw new Error(`Duplicate update: ${name}`);
			for (const [method, fields] of Object.entries(module.fields ?? {}))
				for (const field of Object.keys(fields))
					if (field in (entry.fields?.[method] ?? {})) throw new Error(`Duplicate field: ${method}.${field}`);
		}
		this.protocolModules.push(module);
	}

	/** Advertise a documented API independently of its implementation package. */
	registerCapability(name: string, value: unknown): void {
		this.beforeStart(name);
		if (name in this.declarations) throw new Error(`Duplicate capability: ${name}`);
		this.declarations[name] = value;
	}

	/** Register an exact namespaced custom request. */
	onRequest(method: `_${string}`, handler: MethodHandler): void {
		this.beforeStart(method);
		if (this.requests.has(method)) throw new Error(`Duplicate method: ${method}`);
		this.requests.set(method, handler);
	}

	/** Register an exact namespaced custom notification. */
	onNotification(method: `_${string}`, handler: MethodHandler): void {
		this.beforeStart(method);
		if (this.notifications.has(method)) throw new Error(`Duplicate notification: ${method}`);
		this.notifications.set(method, handler);
	}

	/** Add an ordinary Pi extension factory to every new SDK session. */
	addExtension(factory: ExtensionFactory): void {
		if (this.started) throw new Error("Restart the host to change extensions");
		this.options.extensions = [...(this.options.extensions ?? []), factory];
	}

	/** Create a connection-local version router over the shared session registry. */
	router(): ReturnType<typeof createRouter> {
		this.start();
		return createRouter(this);
	}

	/** Fix startup declarations before accepting a connection. */
	start(): void {
		if (this.started) return;
		const pending = this.modules.slice();
		const ordered: ProtocolModule[] = [];
		while (pending.length) {
			const index = pending.findIndex((module) =>
				(module.requires ?? []).every((id) => ordered.some((entry) => entry.id === id)),
			);
			if (index < 0) throw new Error("Missing or cyclic protocol module dependencies");
			ordered.push(pending.splice(index, 1)[0]!);
		}
		this.protocolModules = ordered;
		this.started = true;
	}

	/** Create and bind an actual upstream Pi AgentSession. */
	async newSession(peer: Peer, cwd: string, servers: unknown[]): Promise<Session> {
		if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
			throw RequestError.invalidParams(undefined, "cwd must name an existing absolute harness directory");
		const mcp = parseMcp(servers);
		const session = new Session(resolve(cwd), (message) => this.diagnostic(message));
		for (const module of this.modules) module.session?.(session);
		const options = this.options.session ?? {};
		const agentDir = options.agentDir ?? getAgentDir();
		const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
		const registration: ExtensionFactory = (pi) => {
			// Replacement must use the Pi extension that owns these MCP registrations.
			session.piExtension = pi;
			pi.on("session_start", () => {
				for (const server of this.mcp.get(session) ?? []) pi.registerMcpServer(server.name, server.config);
			});
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				session.extension(),
				registration,
				...(this.options.extensions ?? []),
				createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: join(agentDir, "mcp.log") }),
			],
		});
		this.mcp.set(session, mcp);
		try {
			await resourceLoader.reload();
			const result = await createAgentSession({
				...options,
				cwd,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
			});
			session.pi = result.session;
			session.pi.subscribe((event) => session.observe(event));
			await session.pi.bindExtensions({
				mode: "rpc",
				uiContext: createUI(session),
				onError: (error) => this.diagnostic(error.error),
			});
			session.extensionsActive = true;
			this.sessions.set(session.id, session);
			await session.attach(peer, false);
			return session;
		} catch (error) {
			session.pi?.dispose();
			this.mcp.delete(session);
			throw error;
		}
	}

	/** Find an active session owned by this connection. */
	active(peer: Peer, id: string): Session {
		const session = this.sessions.get(id);
		if (!session || session.closing || !session.has(peer))
			throw new RequestError(-32002, "Unknown or inactive session");
		return session;
	}

	/** Reattach a retained SDK session and replace its client-supplied MCP configuration. */
	async resume(peer: Peer, id: string, cwd: string, servers: unknown[], replay: boolean): Promise<Session> {
		const session = this.sessions.get(id);
		if (!session) throw new RequestError(-32002, "Unknown session");
		if (session.closing) throw new RequestError(-32600, "Session is closing");
		if (resolve(cwd) !== session.cwd) throw RequestError.invalidParams(undefined, "Session workspace cannot change");
		const mcp = parseMcp(servers);
		if ([...session.peers].some((member) => member !== peer))
			throw new RequestError(-32600, "Session is busy", { reason: "session_busy" });
		await session.attach(peer, replay);
		for (const previous of this.mcp.get(session) ?? []) session.piExtension!.unregisterMcpServer(previous.name);
		for (const server of mcp) session.piExtension!.registerMcpServer(server.name, server.config);
		this.mcp.set(session, mcp);
		if (!session.extensionsActive) {
			await session.pi.extensionRunner.emit({ type: "session_start", reason: "resume" });
			session.extensionsActive = true;
		}
		return session;
	}

	/** Stop session-owned background work while retaining its SDK conversation. */
	async closeSession(peer: Peer, id: string): Promise<void> {
		const session = this.active(peer, id);
		session.closing = true;
		try {
			session.delivery?.close();
			await session.cancel();
			await session.pi.extensionRunner.emit({ type: "session_shutdown", reason: "resume" });
			session.extensionsActive = false;
			await session.flush();
			for (const member of session.peers) session.detach(member);
		} finally {
			session.closing = false;
		}
	}

	/** Dispatch a validated prompt through the selected scheduling policy. */
	async prompt(id: string, content: ContentBlock[], context: ProtocolContext): Promise<PromptResult> {
		const session = this.active(context.peer, id);
		if (content.some((item) => item.type !== "text" && item.type !== "resource_link"))
			throw RequestError.invalidParams(undefined, "This harness accepts text and resource_link prompts");
		if (session.delivery) return session.delivery.submit(context.peer, content, context);
		const messageId = session.prompt(content);
		const completion = session.run!;
		const flushed = session.participation?.prompted?.(
			context.peer,
			content,
			messageId,
			completion,
			context.afterResponse,
		);
		return { messageId, completion, flushed };
	}

	/** Dispatch only explicitly registered non-baseline protocol methods. */
	protocol(method: string, params: unknown, context: ProtocolContext): unknown | Promise<unknown> {
		for (const module of this.modules) {
			const handler = module.methods?.[method];
			if (handler) return handler(params, context);
		}
		return this.custom(context.peer, method, params, context.signal);
	}

	/** Detach every session on a closed connection without stopping its runs. */
	detach(peer: Peer): void {
		for (const session of this.sessions.values()) session.detach(peer);
	}

	/** Dispatch custom APIs with session ownership and peer capability access. */
	async custom(
		peer: Peer,
		method: string,
		params: unknown,
		signal: AbortSignal,
		notification = false,
	): Promise<unknown> {
		const handler = (notification ? this.notifications : this.requests).get(method);
		if (!handler) {
			if (notification) return;
			throw new RequestError(-32601, "Method not found");
		}
		return handler(params, {
			peer,
			signal,
			session: (id) => this.active(peer, id),
			capability: (name) => metadata(peer.capabilities._meta)[name],
			request: (name, value) => peer.request(name, value, signal),
		});
	}

	/** Expose only model and thinking choices that Pi can apply. */
	config(session: Session): ConfigOption[] {
		const models = session.pi.modelRuntime.getAvailableSnapshot();
		const model = session.pi.model;
		const result: ConfigOption[] = [];
		if (model)
			result.push({
				configId: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: `${model.provider}/${model.id}`,
				options: models.map((item) => ({ value: `${item.provider}/${item.id}`, name: item.name })),
			});
		result.push({
			configId: "thinking",
			name: "Thinking",
			category: "thought_level",
			type: "select",
			currentValue: session.pi.thinkingLevel,
			options: session.pi.getAvailableThinkingLevels().map((level) => ({ value: level, name: level })),
		});
		return result;
	}

	/** Apply a selected advertised value without changing global Pi settings. */
	async setConfig(session: Session, id: string, value: string): Promise<ConfigOption[]> {
		const option = this.config(session).find((item) => item.configId === id);
		if (!option?.options.some((item) => item.value === value))
			throw RequestError.invalidParams(undefined, "Unknown configuration choice");
		if (id === "model") {
			const model = session.pi.modelRuntime
				.getAvailableSnapshot()
				.find((item) => `${item.provider}/${item.id}` === value)!;
			await session.pi.setModel(model, { persist: false });
		} else {
			const level = session.pi.getAvailableThinkingLevels().find((item) => item === value)!;
			session.pi.setThinkingLevel(level, { persist: false });
		}
		return this.config(session);
	}

	/** Dispose SDK sessions only when the owning host shuts down. */
	async close(): Promise<void> {
		for (const session of this.sessions.values()) {
			session.closing = true;
			session.delivery?.close();
		}
		for (const session of this.sessions.values()) {
			await session.cancel();
			if (session.extensionsActive)
				await session.pi.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.pi.dispose();
		}
		this.sessions.clear();
		this.mcp.clear();
	}

	diagnostic(message: string): void {
		(this.options.diagnostic ?? console.error)(message);
	}

	private beforeStart(name: string): void {
		if (this.started) throw new Error("Restart the host to change capability declarations");
		if (!/^_?[a-zA-Z0-9.-]+\/.+/.test(name)) throw new Error("Use a reverse-DNS namespace");
	}
}

function parseMcp(servers: unknown[]): McpServer[] {
	const names = new Set<string>();
	return servers.map((value) => {
		// Client-supplied executable configuration is a host process boundary.
		const server = object(value);
		if (server.type !== undefined && server.type !== "stdio")
			throw RequestError.invalidParams(undefined, "Only stdio MCP is supported");
		const name = text(server.name);
		if (names.has(name)) throw RequestError.invalidParams(undefined, "Duplicate MCP server name");
		names.add(name);
		if (!Array.isArray(server.args) || !Array.isArray(server.env))
			throw RequestError.invalidParams(undefined, "Expected MCP args and env arrays");
		return {
			name,
			config: {
				command: text(server.command),
				args: server.args.map(text),
				env: Object.fromEntries(
					server.env.map((entry) => {
						const pair = object(entry);
						return [text(pair.name), text(pair.value)];
					}),
				),
				exposure: "direct",
			},
		};
	});
}
