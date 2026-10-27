import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} } });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
});

test("Providers is the first/default page; General is last and other pages keep relative order", () => {
	const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
	const ids = [...html.matchAll(/data-testid="settings-nav-([^"]+)"/g)].map((m) => m[1]);
	assert.deepEqual(ids, ["keys", "agent", "appearance", "graph", "keyboard", "general"]);
	assert.match(html, /settings-nav-keys[^>]*aria-current="true"/);
	assert.match(html, />Providers<\/button>/);
});

test("Providers lists the GitHub Copilot connection under Models, then the tool keys; other saved variables stay masked/read-only last", async () => {
	globalThis.fetch = async (url) => {
		if (url === "/api/copilot") return Response.json({ state: "signed-in", login: "octocat" });
		assert.equal(url, "/api/keys");
		return Response.json({
			keys: [
				{ id: "FUTURE_VAR", info: null, present: true, masked: "…abcd", source: "file", shadowedByEnv: false },
				{ id: "OPENAI_API_KEY", info: null, present: true, masked: "…wxyz", source: "file", shadowedByEnv: false },
			],
		});
	};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<KeysSection />));
	await act(async () => {});

	const headings = [...document.querySelectorAll('[data-testid^="group-"] > p')].map((el) => el.textContent);
	assert.deepEqual(headings, ["Models", "Dictation", "Search", "Other saved keys"]);
	assert.equal(byTest("copilot-status").textContent, "Signed in as @octocat");
	assert(byTest("key-deepgram_api_key").closest('[data-testid="group-dictation"]'));
	assert(byTest("key-tavily_api_key").closest('[data-testid="group-search"]'));
	assert(byTest("key-brave_api_key").closest('[data-testid="group-search"]'));
	assert(byTest("group-unknown-keys").parentElement?.lastElementChild === byTest("group-unknown-keys"));
	for (const id of ["FUTURE_VAR", "OPENAI_API_KEY"]) {
		assert(byTest(`unknown-${id}`).closest('[data-testid="group-unknown-keys"]'));
		assert(!byTest(`unknown-${id}`).querySelector("input, button"), "read-only");
	}
	assert.equal(byTest("unknown-FUTURE_VAR").textContent, "FUTURE_VAR…abcd");
	assert.equal(document.querySelector('[data-testid="add-provider"]'), null, "no model API key entry");
});
