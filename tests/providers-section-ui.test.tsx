import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { AnimationRenderer } from "../components/settings/animation-renderer.tsx";
import { WorkIqConnection } from "../components/settings/workiq-connection.tsx";

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

test("Providers lists the GitHub Copilot connection under Models, then the animation renderer and Work IQ; other saved variables (a retired search key included) stay masked/read-only last", async () => {
	globalThis.fetch = async (url) => {
		if (url === "/api/copilot") return Response.json({ state: "signed-in", login: "octocat" });
		if (url === "/api/copilot/accounts") return Response.json({ accounts: [{ id: "s1", login: "octocat", host: "https://github.com", active: true, source: "gh" }] });
		if (url === "/api/copilot/login") return Response.json(null);
		if (url === "/api/manim") return Response.json({ state: "ready", reason: "Ready. Animations render on this computer, inside Docker.", image: "manimcommunity/manim:v0.22.0" });
		assert.equal(url, "/api/keys");
		return Response.json({
			keys: [
				{ id: "FUTURE_VAR", info: null, present: true, masked: "…abcd", source: "file", shadowedByEnv: false },
				{ id: "OPENAI_API_KEY", info: null, present: true, masked: "…wxyz", source: "file", shadowedByEnv: false },
				{ id: "TAVILY_API_KEY", info: null, present: true, masked: "…5678", source: "file", shadowedByEnv: false },
			],
		});
	};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<KeysSection />));
	await act(async () => {});

	const headings = [...document.querySelectorAll('[data-testid^="group-"] > p')].map((el) => el.textContent);
	assert.deepEqual(headings, ["Models", "Animations", "Work IQ", "Other saved keys"]);
	assert.equal(byTest("copilot-status").textContent, "Signed in as @octocat");
	assert.equal(byTest("manim-status").textContent, "Ready");
	assert.equal(document.querySelector('[data-testid="manim-install"]'), null, "nothing to install");
	assert(byTest("workiq-connection").closest('[data-testid="group-workiq"]'));
	assert.equal(byTest("workiq-status").textContent, "Not tested", "Work IQ is only asked when the learner tests it");
	assert.equal(document.querySelector('[data-testid="group-keys"]'), null, "no key rows while the catalog is empty");
	assert(byTest("group-unknown-keys").parentElement?.lastElementChild === byTest("group-unknown-keys"));
	for (const id of ["FUTURE_VAR", "OPENAI_API_KEY", "TAVILY_API_KEY"]) {
		assert(byTest(`unknown-${id}`).closest('[data-testid="group-unknown-keys"]'));
		assert(!byTest(`unknown-${id}`).querySelector("input, button"), "read-only");
	}
	assert.equal(byTest("unknown-FUTURE_VAR").textContent, "FUTURE_VAR…abcd");
	assert.equal(document.querySelector('[data-testid="add-provider"]'), null, "no model API key entry");
});

test("Animations: Install starts the one-time download and the row turns to installing", async () => {
	const calls: string[] = [];
	globalThis.fetch = async (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${String(url)}`);
		const image = "manimcommunity/manim:v0.22.0";
		if (init?.method === "POST") return Response.json({ state: "installing", reason: "Downloading the Manim renderer (about 500 MB).", image, progress: "2 of 11 layers" });
		return Response.json({ state: "not-installed", reason: "Docker is running. Install the Manim renderer — a one-time download of about 500 MB.", image });
	};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<AnimationRenderer />));
	await act(async () => {});
	assert.equal(byTest("manim-status").textContent, "Not installed");
	assert.match(byTest("manim-reason").textContent ?? "", /one-time download of about 500 MB/);

	await act(async () => {
		byTest("manim-install").dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
	});
	await act(async () => {});
	assert.deepEqual(calls, ["GET /api/manim", "POST /api/manim"]);
	assert.equal(byTest("manim-status").textContent, "Installing · 2 of 11 layers");
	assert.equal(document.querySelector('[data-testid="manim-install"]'), null);
	assert.equal(byTest("manim-check").hasAttribute("disabled"), true, "no re-check while downloading");
});

test("Work IQ: Test connection asks once at a time and shows why it failed, then that it connected", async () => {
	const calls: string[] = [];
	let reply: (body: unknown) => void = () => {};
	globalThis.fetch = (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${String(url)}`);
		return new Promise<Response>((resolve) => (reply = (body) => resolve(Response.json(body))));
	};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<WorkIqConnection />));
	const click = () =>
		act(async () => {
			byTest("workiq-test").dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
		});

	await click();
	assert.deepEqual(calls, ["POST /api/workiq"]);
	assert.equal(byTest("workiq-status").textContent, "Testing… (can take a minute)");
	assert.equal(byTest("workiq-test").hasAttribute("disabled"), true, "one test at a time");
	const error = "Work IQ stopped before answering (exit code 1). Work IQ said: EULA not accepted";
	await act(async () => reply({ ok: false, error }));
	await act(async () => {});
	assert.equal(byTest("workiq-status").textContent, "Couldn't connect");
	assert.equal(byTest("workiq-error").textContent, error);

	await click();
	await act(async () => reply({ ok: true }));
	await act(async () => {});
	assert.deepEqual(calls, ["POST /api/workiq", "POST /api/workiq"]);
	assert.equal(byTest("workiq-status").textContent, "Connected");
	assert.equal(document.querySelector('[data-testid="workiq-error"]'), null);
});