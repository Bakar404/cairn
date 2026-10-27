/**
 * The keyless dictation page (design cleanup, 2026-10-27): with no Deepgram
 * key saved, the bar offers setup and never calls the token route (each
 * pre-mint used to be a 503); a key that lands re-arms the warm pre-mint.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { DictationBar, useDictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";

function Bar() {
	const dictation = useDictation({ append: () => {} });
	return <DictationBar dictation={dictation} />;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

it("a keyless page offers setup and never calls the token route; a saved key re-arms the pre-mint", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let keyPresent = false;
	const requests: string[] = [];
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			requests.push(url);
			if (url === "/api/keys") return new Response(JSON.stringify({ keys: [{ id: "DEEPGRAM_API_KEY", present: keyPresent }] }));
			if (url === "/api/stt/token") return new Response(JSON.stringify({ token: "t" }));
			throw new Error(`unexpected request: ${url}`);
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const button = () => document.querySelector<HTMLButtonElement>('[data-testid="dictation-toggle"]')!;
	try {
		await act(async () => {
			root.render(<Bar />);
			await settle();
		});
		assert.equal(button().getAttribute("aria-label"), "Set up dictation");
		assert.equal(button().textContent, "Set up dictation");
		assert.deepEqual(requests, ["/api/keys"], "no token request without a key");

		keyPresent = true;
		await act(async () => {
			notifySettingsSaved("keys");
			await settle();
		});
		assert.equal(button().getAttribute("aria-label"), "Start dictation");
		assert.deepEqual(requests, ["/api/keys", "/api/keys", "/api/stt/token"], "the saved key is re-read and warms the next run");
	} finally {
		act(() => {
			root.unmount();
		});
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
