/** Run opt-in shared ACP sessions with Pi's deterministic provider and no credentials. */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { serveShared } from "@pi-acp/harness";
import { installSharedQueue } from "@pi-acp/harness/capabilities/shared-queue";
import { multiClientAttach } from "@pi-acp/harness/experimental/multi-client-attach";
import { promptDelivery } from "@pi-acp/harness/experimental/prompt-delivery";
import { createDemo } from "./demo.ts";

const { values } = parseArgs({
	options: {
		cwd: { type: "string", default: process.cwd() },
		port: { type: "string", default: "0" },
		"token-file": { type: "string" },
		origin: { type: "string", multiple: true },
	},
});
if (!values["token-file"]) throw new Error("Provide --token-file in an ignored local directory");
const tokenFile = resolve(values["token-file"]);
await mkdir(dirname(tokenFile), { recursive: true });
try {
	await writeFile(tokenFile, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
const { host } = await createDemo(resolve(values.cwd), 80);
host.use(multiClientAttach());
const delivery = promptDelivery();
host.use(delivery);
installSharedQueue(host, delivery);
const server = await serveShared(host, { tokenFile, port, origins: values.origin });
const token = (await readFile(tokenFile, "utf8")).trim();
const details = `${tokenFile}.connection.json`;
await writeFile(
	details,
	JSON.stringify(
		{
			provider: "deterministic Pi faux provider; no model API",
			url: server.url,
			websocketUrl: server.wsUrl,
			browserWebsocketUrl: `${server.wsUrl}?token=${encodeURIComponent(token)}`,
			tokenFile,
			origins: values.origin ?? [],
		},
		null,
		2,
	),
	{ mode: 0o600 },
);
console.error(`HTTP: ${server.url}\nWebSocket: ${server.wsUrl}\nPrivate browser connection details: ${details}`);
const stop = () => {
	void server.close().then(
		() => process.exit(0),
		(error) => {
			console.error(error);
			process.exit(1);
		},
	);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
