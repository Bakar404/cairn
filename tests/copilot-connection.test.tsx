/**
 * The GitHub Copilot row's in-app sign-in, mounted against an isolated DOM
 * with fetch stubbed: browser sign-in, the GitHub Enterprise Cloud address,
 * resuming and cancelling, and the account list's switch / sign-out.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CopilotConnection } from "../components/settings/copilot-connection.tsx";
import { onSettingsSaved, type SettingsSection } from "../components/settings-signal.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const GITHUB_URL = "https://github.com/login/oauth/authorize?client_id=Iv1.test";
const GHE_URL = "https://contoso.ghe.com/login/oauth/authorize?client_id=Iv1.test";
const originalFetch = globalThis.fetch;

type Handler = (body: Record<string, unknown> | undefined, url: URL) => Response | Promise<Response>;
interface Call {
	method: string;
	path: string;
	body?: Record<string, unknown>;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let calls: Call[] = [];
let unexpected: string[] = [];
let opened: string[] = [];
let signals: SettingsSection[] = [];
let stopSignals: (() => void) | undefined;

/** Fetch answers by "METHOD /path"; anything else is recorded and fails
 *  the test in afterEach (the component swallows fetch errors). */
function serve(routes: Record<string, Handler>): void {
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input), "http://localhost");
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		calls.push({ method, path: url.pathname + url.search, ...(body ? { body } : {}) });
		const handler = routes[`${method} ${url.pathname}`];
		if (!handler) {
			unexpected.push(`${method} ${url.pathname}`);
			return Response.json({ error: "unexpected" }, { status: 500 });
		}
		return handler(body, url);
	};
}

async function mount(): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<CopilotConnection />));
	await settle();
}

async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++) await act(async () => new Promise((resolve) => setImmediate(resolve)));
}

const query = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function byTest(id: string): HTMLElement {
	const node = query(id);
	assert.ok(node, `expected ${id}`);
	return node;
}

async function click(target: HTMLElement): Promise<void> {
	await act(async () => {
		target.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
	});
	await settle();
}

/** The address field is uncontrolled: read on submit. */
function type(input: HTMLElement, value: string): void {
	(input as HTMLInputElement).value = value;
}

async function submit(form: HTMLElement): Promise<void> {
	await act(async () => {
		form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
	});
	await settle();
}

function signedOut(): Response {
	return Response.json({ state: "signed-out", message: "Not signed in" });
}

function beforeEachTest(): void {
	calls = [];
	unexpected = [];
	opened = [];
	signals = [];
	(dom.window as unknown as { open: (url: string) => null }).open = (url: string) => {
		opened.push(url);
		return null;
	};
	stopSignals = onSettingsSaved((section) => signals.push(section));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	stopSignals?.();
	globalThis.fetch = originalFetch;
	assert.deepEqual(unexpected, [], "every request was one the test expected");
});

describe("Copilot sign-in in Settings", () => {
	it("signed out: Sign in with GitHub opens GitHub, waits, then shows the account and its plan", async (t) => {
		beforeEachTest();
		t.mock.timers.enable({ apis: ["setInterval"] });
		let done = false;
		let polls = 0;
		serve({
			"GET /api/copilot": () => (done ? Response.json({ state: "signed-in", login: "octocat" }) : signedOut()),
			"GET /api/copilot/accounts": () =>
				Response.json(done ? { accounts: [{ id: "s1", login: "octocat", host: "https://github.com", active: true }], plan: "enterprise" } : { accounts: [] }),
			"GET /api/copilot/login": (_body, url) => {
				if (!url.searchParams.has("id")) return Response.json(null);
				polls++;
				if (polls === 2) done = true;
				return Response.json({ id: "flow-1", provider: "github", step: done ? { state: "signed-in", login: "octocat" } : { state: "browser", url: GITHUB_URL } });
			},
			"POST /api/copilot/login": () => Response.json({ id: "flow-1", provider: "github", step: { state: "browser", url: GITHUB_URL } }),
		});
		await mount();
		assert.equal(byTest("copilot-status").textContent, "Not signed in");
		assert.match(byTest("copilot-help").textContent ?? "", /personal or Enterprise Managed \(EMU\)/);
		assert.equal(byTest("copilot-sign-in").textContent, "Sign in with GitHub");
		assert.ok(query("copilot-sign-in-ghe"));
		assert.equal(query("copilot-accounts"), null, "no accounts to list");

		await click(byTest("copilot-sign-in"));
		assert.deepEqual(calls.find((c) => c.method === "POST"), { method: "POST", path: "/api/copilot/login", body: { provider: "github" } });
		assert.deepEqual(opened, [GITHUB_URL]);
		assert.equal(byTest("copilot-login").dataset.state, "browser");
		assert.equal(byTest("copilot-login-open").getAttribute("href"), GITHUB_URL);
		assert.equal(query("copilot-sign-in"), null, "one sign-in at a time");
		assert.equal(query("copilot-help"), null, "the sign-in panel replaces the help");

		await act(async () => t.mock.timers.tick(1500));
		await settle();
		assert.equal(byTest("copilot-login").dataset.state, "browser", "still waiting on the browser");
		await act(async () => t.mock.timers.tick(1500));
		await settle();
		assert.equal(query("copilot-login"), null);
		assert.equal(byTest("copilot-status").textContent, "Signed in as @octocat");
		assert.equal(byTest("copilot-plan").textContent, "· Copilot Enterprise");
		assert.ok(signals.includes("keys"), "models and setup re-read after sign-in");
		assert.equal(query("copilot-help"), null);
	});

	it("GitHub Enterprise Cloud asks for the address, shows a rejected one, then continues in the browser", async () => {
		beforeEachTest();
		let rejectFirst = true;
		serve({
			"GET /api/copilot": () => signedOut(),
			"GET /api/copilot/accounts": () => Response.json({ accounts: [] }),
			"GET /api/copilot/login": () => Response.json(null),
			"POST /api/copilot/login": () => Response.json({ id: "flow-2", provider: "ghe", step: { state: "needs-host" } }),
			"PATCH /api/copilot/login": () => {
				if (rejectFirst) {
					rejectFirst = false;
					return Response.json({ error: "Enter your GitHub Enterprise Cloud address, like your-company.ghe.com." }, { status: 400 });
				}
				return Response.json({ id: "flow-2", provider: "ghe", step: { state: "browser", url: GHE_URL } });
			},
		});
		await mount();
		await click(byTest("copilot-sign-in-ghe"));
		assert.equal(byTest("copilot-login").dataset.state, "needs-host");
		assert.deepEqual(opened, [], "nothing to open before the address");
		type(byTest("copilot-login-host"), "   ");
		await submit(byTest("copilot-login-host").closest("form") as HTMLElement);
		assert.equal(calls.filter((c) => c.method === "PATCH").length, 0, "an empty address is not sent");

		type(byTest("copilot-login-host"), "github.com");
		await submit(byTest("copilot-login-host").closest("form") as HTMLElement);
		assert.match(byTest("copilot-error").textContent ?? "", /your-company\.ghe\.com/);
		assert.equal(byTest("copilot-login").dataset.state, "needs-host", "the address can be fixed");

		type(byTest("copilot-login-host"), "contoso.ghe.com");
		await submit(byTest("copilot-login-host").closest("form") as HTMLElement);
		assert.deepEqual(calls.filter((c) => c.method === "PATCH").map((c) => c.body), [{ id: "flow-2", host: "github.com" }, { id: "flow-2", host: "contoso.ghe.com" }]);
		assert.deepEqual(opened, [GHE_URL]);
		assert.equal(byTest("copilot-login").dataset.state, "browser");
		assert.equal(query("copilot-error"), null);
	});

	it("a sign-in still waiting is picked up on open; Cancel closes it even when the server no longer knows it", async () => {
		beforeEachTest();
		serve({
			"GET /api/copilot": () => signedOut(),
			"GET /api/copilot/accounts": () => Response.json({ error: "runtime down" }, { status: 503 }),
			"GET /api/copilot/login": () => Response.json({ id: "flow-7", provider: "github", step: { state: "browser", url: GITHUB_URL } }),
			"DELETE /api/copilot/login": () => Response.json({ error: "This sign-in is no longer active. Start again." }, { status: 400 }),
		});
		await mount();
		assert.equal(byTest("copilot-login").dataset.state, "browser");
		assert.deepEqual(opened, [], "resuming does not open GitHub again");
		await click(byTest("copilot-login-cancel"));
		assert.equal(query("copilot-login"), null);
		assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/api/copilot/login?id=flow-7"));
		assert.equal(query("copilot-error"), null);
		assert.ok(query("copilot-sign-in"), "ready to start again");
	});

	it("signed in: lists accounts, switches, and offers Sign out only for sign-ins Cairn saved, after a warning", async () => {
		beforeEachTest();
		let active = "s1";
		const accounts = () => ({
			accounts: [
				{ id: "s1", login: "octocat", host: "https://github.com", active: active === "s1", source: "gh" },
				{ id: "s2", login: "mona", host: "https://contoso.ghe.com", active: active === "s2" },
			],
			plan: "business",
		});
		serve({
			"GET /api/copilot": () => Response.json({ state: "signed-in", login: active === "s1" ? "octocat" : "mona" }),
			"GET /api/copilot/accounts": () => Response.json(accounts()),
			"GET /api/copilot/login": () => Response.json(null),
			"POST /api/copilot/accounts": (body) => {
				if (body?.action === "switch") active = String(body.id);
				return Response.json(accounts());
			},
		});
		await mount();
		assert.equal(byTest("copilot-plan").textContent, "· Copilot Business");
		const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="copilot-account"]')];
		assert.equal(rows().length, 2);
		assert.match(rows()[0]!.textContent ?? "", /@octocat.*github\.com.*from the GitHub CLI.*In use/);
		assert.equal(rows()[0]!.querySelector('[data-testid="copilot-account-sign-out"]'), null, "the GitHub CLI's sign-in stays with it");
		assert.match(rows()[1]!.textContent ?? "", /@mona.*contoso\.ghe\.com/);
		assert.equal(byTest("copilot-sign-in").textContent, "GitHub", "add another account");

		await click(rows()[1]!.querySelector<HTMLElement>('[data-testid="copilot-account-use"]')!);
		assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.body), [{ action: "switch", id: "s2" }]);
		assert.equal(byTest("copilot-status").textContent, "Signed in as @mona");
		assert.ok(signals.includes("keys"));

		await click(rows()[1]!.querySelector<HTMLElement>('[data-testid="copilot-account-sign-out"]')!);
		assert.match(byTest("copilot-account-confirm").textContent ?? "", /GitHub Copilot CLI on this computer/);
		assert.equal(calls.filter((c) => c.method === "POST").length, 1, "nothing signed out before confirming");
		await click(byTest("copilot-account-sign-out-confirm"));
		assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.body), [{ action: "switch", id: "s2" }, { action: "sign-out", id: "s2" }]);
	});
});
