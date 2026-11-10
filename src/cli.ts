#!/usr/bin/env node
/** Launch a headless ACP host or attach a client to an existing one. */
import { parseArgs } from "node:util";
import { installSharedQueue } from "./capabilities/shared-queue.ts";
import { multiClientAttach } from "./experimental/multi-client-attach.ts";
import { promptDelivery } from "./experimental/prompt-delivery.ts";
import { createHarness } from "./harness.ts";
import { attach, serve, serveShared, stdio } from "./transport.ts";

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		url: { type: "string" },
		port: { type: "string", default: "0" },
		"token-file": { type: "string" },
		origin: { type: "string", multiple: true },
		experimental: { type: "string", multiple: true },
		"shared-queue": { type: "boolean" },
		help: { type: "boolean", short: "h" },
	},
});

try {
	if (values.help)
		console.log(
			"pi-acp-harness [stdio | serve --port <port> | attach --url <http-or-ws-url> --token-file <file>]\nOptional: --experimental multi-client-attach --experimental prompt-delivery --shared-queue\nExperimental serving requires --token-file; browser clients require an explicit --origin.",
		);
	else if (positionals[0] === "attach") {
		if (!values.url) throw new Error("attach requires --url");
		await attach(values.url, values["token-file"]);
	} else {
		const host = createHarness();
		const experiments = new Set(values.experimental ?? []);
		for (const name of experiments)
			if (!["multi-client-attach", "prompt-delivery"].includes(name)) throw new Error(`Unknown experiment: ${name}`);
		if (experiments.has("multi-client-attach")) host.use(multiClientAttach());
		const delivery = promptDelivery();
		if (experiments.has("prompt-delivery")) host.use(delivery);
		if (values["shared-queue"]) installSharedQueue(host, delivery);
		if (positionals[0] === "serve") {
			const port = Number(values.port);
			if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
			if (experiments.size && !values["token-file"]) throw new Error("Experimental serving requires --token-file");
			const server = values["token-file"]
				? await serveShared(host, { port, tokenFile: values["token-file"], origins: values.origin })
				: await serve(host, port);
			console.error(server.url);
			const stop = () => {
				void server.close().catch(console.error);
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		} else if (!positionals.length || positionals[0] === "stdio") await stdio(host);
		else throw new Error("Expected stdio, serve or attach");
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
