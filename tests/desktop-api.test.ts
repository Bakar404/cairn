import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
// Installed Next 16.3.2 retains the old test-helper export despite proxy.md's new name.
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { desktopAPIAuthorized } from "../src/server/desktop-access.ts";
import { proxy, config } from "../proxy.ts";
import { browserServiceSpawnEnv } from "../src/agent/subagents/headless.ts";
const require = createRequire(import.meta.url);
const { desktopAPIHeaders, trustedSender, HEADER } = require("../electron/desktop-api.cjs");
const secret = "a".repeat(64);
const origin = "http://127.0.0.1:12345";

function fixture() {
	const mainFrame = { url: `${origin}/chat/new` };
	const contents = { id: 5, mainFrame, isDestroyed: () => false };
	const win = { webContents: contents, isDestroyed: () => false };
	const details = { url: `${origin}/api/settings`, webContentsId: contents.id, webContents: contents, frame: mainFrame, initiatorOrigin: origin, requestHeaders: { Accept: "application/json" } };
	return { mainFrame, contents, win, details };
}

test("desktop capability injects only trusted app mainframe exact-origin API requests and strips every other case", () => {
	const { details, win, mainFrame, contents } = fixture();
	assert.equal(desktopAPIHeaders(details, origin, secret, [win])[HEADER], secret);
	for (const mutation of [
		{ url: "https://thirdparty.invalid/api/settings" },
		{ url: "http://127.0.0.1:12346/api/settings" },
		{ url: `${origin}/chat/new` },
		{ frame: { url: `${origin}/chat/new` } }, // forged frame identity
		{ frame: { url: "about:srcdoc", parent: mainFrame } },
		{ frame: null },
		{ webContentsId: 6 },
		{ webContents: { ...contents } },
		{ initiatorOrigin: "https://thirdparty.invalid" },
		{ initiatorOrigin: "null" },
	]) {
		const result = desktopAPIHeaders({ ...details, ...mutation, requestHeaders: { "X-LearnHarness-Desktop": secret } }, origin, secret, [win]);
		assert(!Object.keys(result).some((key) => key.toLowerCase() === HEADER), JSON.stringify(mutation));
	}
	assert.equal(desktopAPIHeaders(details, origin, secret, [])[HEADER], undefined, "other WebContents are not app windows");
	mainFrame.url = "https://thirdparty.invalid/after-navigation";
	assert.equal(desktopAPIHeaders(details, origin, secret, [win])[HEADER], undefined, "navigation revokes trust even for the same native frame");
	assert.equal(desktopAPIHeaders(details, origin, null, [win])[HEADER], undefined, "externally launched desktop dev receives no packaged capability");
});

test("all methods fail closed for desktop missing/wrong secret; API-only matcher covers SSE/settings/spending", () => {
	assert(desktopAPIAuthorized(new Headers(), {}), "browser-only API-key mode unchanged");
	assert(!desktopAPIAuthorized(new Headers({ [HEADER]: secret }), { LH_DESKTOP_SERVER: "1" }), "missing server secret must not disable authorization");
	for (const value of [undefined, "", "wrong", secret + ", " + secret]) {
		assert(!desktopAPIAuthorized(new Headers(value === undefined ? {} : { [HEADER]: value }), { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret }));
	}
	assert(desktopAPIAuthorized(new Headers({ [HEADER]: secret }), { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret }));
	for (const pathname of ["/api/events", "/api/chat", "/api/settings/models", "/api/chats/scratch/markdown"]) assert(unstable_doesProxyMatch({ config, nextConfig: {}, url: origin + pathname }));
	assert(!unstable_doesProxyMatch({ config, nextConfig: {}, url: origin + "/chat/new" }));
	const originalMarker = process.env.LH_DESKTOP_SERVER;
	const originalSecret = process.env.LH_DESKTOP_API_SECRET;
	try {
		process.env.LH_DESKTOP_SERVER = "1";
		process.env.LH_DESKTOP_API_SECRET = secret;
		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
			assert.equal(proxy(new NextRequest(origin + "/api/settings", { method })).status, 403);
			assert.equal(proxy(new NextRequest(origin + "/api/settings", { method, headers: { [HEADER]: secret } })).headers.get("x-middleware-next"), "1");
		}
	} finally {
		if (originalMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = originalMarker;
		if (originalSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = originalSecret;
	}
});

test("every mode refuses API writes from another site; reads, the app's own writes and header-less calls pass", () => {
	const originalMarker = process.env.LH_DESKTOP_SERVER;
	const originalSecret = process.env.LH_DESKTOP_API_SECRET;
	const host = "127.0.0.1:3000";
	const send = (method: string, headers: Record<string, string>) =>
		proxy(new NextRequest(`http://${host}/api/chat`, { method, headers: { host, ...headers } }));
	const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";
	try {
		delete process.env.LH_DESKTOP_SERVER;
		delete process.env.LH_DESKTOP_API_SECRET;
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			for (const site of ["cross-site", "same-site"]) assert.equal(send(method, { "sec-fetch-site": site }).status, 403, `${method} ${site}`);
			for (const site of ["same-origin", "none"]) assert(passes(send(method, { "sec-fetch-site": site })), `${method} ${site}`);
		}
		// Without Sec-Fetch-Site, Origin must name this server.
		for (const origin of ["https://thirdparty.invalid", "http://127.0.0.1:3001", "null"]) assert.equal(send("POST", { origin }).status, 403, origin);
		assert(passes(send("POST", { origin: `http://${host}` })));
		assert(passes(send("POST", { origin: "https://cairn.example", "x-forwarded-host": "cairn.example" })), "behind a proxy");
		assert(passes(send("POST", { origin: "https://cairn.example", "x-forwarded-host": "cairn.example, internal.invalid" })), "behind a chain of proxies");
		assert.equal(send("POST", { origin: "https://cairn.example", "x-forwarded-host": "internal.invalid, cairn.example" }).status, 403, "only the first forwarded host counts");
		assert(passes(send("POST", {})), "the server's own calls and curl send neither header");
		for (const method of ["GET", "HEAD", "OPTIONS"]) assert(passes(send(method, { "sec-fetch-site": "cross-site" })), method);
		process.env.LH_DESKTOP_SERVER = "1";
		process.env.LH_DESKTOP_API_SECRET = secret;
		assert.equal(send("POST", { [HEADER]: secret, "sec-fetch-site": "cross-site" }).status, 403, "the desktop capability doesn't lift the guard");
		assert(passes(send("POST", { [HEADER]: secret, "sec-fetch-site": "same-origin" })));
	} finally {
		if (originalMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = originalMarker;
		if (originalSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = originalSecret;
	}
});
test("desktop IPC requires the trusted main frame, and the browser service never inherits the desktop secret", () => {
	const { contents, mainFrame, win } = fixture();
	const BrowserWindow = { fromWebContents: (value: unknown) => value === contents ? win : null };
	assert(trustedSender({ sender: contents, senderFrame: mainFrame }, origin, BrowserWindow));
	assert(!trustedSender({ sender: contents, senderFrame: { url: mainFrame.url } }, origin, BrowserWindow));
	mainFrame.url = "https://thirdparty.invalid/";
	assert(!trustedSender({ sender: contents, senderFrame: mainFrame }, origin, BrowserWindow));
	assert.equal(browserServiceSpawnEnv({ LH_DESKTOP_API_SECRET: secret, LH_DESKTOP_SERVER: "1" }).LH_DESKTOP_API_SECRET, undefined);
});
