/** Run the deterministic SDK example: node examples/serve.ts [workspace] [port]. */
import { resolve } from "node:path";
import { serve } from "@pi-acp/harness";
import { createDemo } from "./demo.ts";
import { installTasks } from "./tasks.ts";

const cwd = resolve(process.argv[2] ?? process.cwd());
const { host } = await createDemo(cwd, 40);
installTasks(host);
const server = await serve(host, Number(process.argv[3] ?? 0));
console.error(server.url);
const stop = () => {
	void server.close().catch(console.error);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
