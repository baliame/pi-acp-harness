/** Bind supported Pi dialogs to ACP forms; terminal components stay in the frontend. */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Session } from "./session.ts";

/** Supply Pi's UI contract without embedding a terminal renderer in the harness. */
export function createUI(session: Session): ExtensionUIContext {
	return {
		...session.pi.extensionRunner.getUIContext(),
		select: async (title, options, opts) => {
			const value = await session.form(title, { type: "string", enum: options }, opts?.signal);
			return typeof value === "string" && options.includes(value) ? value : undefined;
		},
		confirm: async (title, message, opts) =>
			(await session.form(`${title}\n${message}`, { type: "boolean" }, opts?.signal)) === true,
		input: async (title, _placeholder, opts) => {
			const value = await session.form(title, { type: "string" }, opts?.signal);
			return typeof value === "string" ? value : undefined;
		},
		editor: async (title) => {
			const value = await session.form(title, { type: "string" });
			return typeof value === "string" ? value : undefined;
		},
		notify: (message) => session.emit({ sessionUpdate: "notice", title: message, severity: "info" }),
	};
}
