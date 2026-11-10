/** Application-level queue inspection and atomic removal over public L2 services. */
import type { PromptDeliveryModule } from "../experimental/prompt-delivery.ts";
import type { Harness } from "../harness.ts";
import { object, text } from "../wire.ts";

/** Install an independently consumable queue capability on a composed host. */
export function installSharedQueue(host: Harness, delivery: PromptDeliveryModule): void {
	host.registerCapability("com.example/shared-queue", { version: 1 });
	host.use({
		id: "com.example/shared-queue",
		requires: ["multi-client-attach", "prompt-delivery"],
		session: (session) => {
			delivery.queue(session).subscribe((snapshot, change) => {
				session.notify("_com.example/shared-queue/update", { ...snapshot, change });
			});
		},
	});
	host.onRequest("_com.example/shared-queue/list", (params, ctx) =>
		delivery.queue(ctx.session(text(object(params).sessionId))).snapshot(),
	);
	host.onRequest("_com.example/shared-queue/pop", (params, ctx) => {
		const value = object(params);
		const expected = value.expectedHeadId === null ? null : text(value.expectedHeadId);
		return delivery.queue(ctx.session(text(value.sessionId))).pop(expected, ctx.peer);
	});
}
