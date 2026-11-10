/** Run the same deterministic SDK harness through standard ACP stdio. */
import { stdio } from "@pi-acp/harness";
import { createDemo } from "./demo.ts";
import { installTasks } from "./tasks.ts";

const { host } = await createDemo(process.cwd());
installTasks(host);
await stdio(host);
