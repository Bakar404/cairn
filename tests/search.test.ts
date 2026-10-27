/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback from a pin) + the Tavily/Brave adapters against a STUB fetch
 * (never the network — the wire shapes are verified against the published
 * docs, and the tests pin those shapes) + GitHub Copilot's hosted web
 * search against a FAKE Copilot runtime (result shape from a recorded
 * Copilot web_search call).
 *
 * PURE + injected fetch/runtime — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { MessageOptions, SessionEvent } from "@github/copilot-sdk";
import type { CopilotRuntimePort, SessionSpec } from "../src/agent/copilot/runtime.ts";
import { copilotSearchHits, copilotWebSearch } from "../src/agent/copilot/search.ts";
import type { SearchProvider } from "../src/core/search.ts";
import { resolveSearchEngineFor, tavilyProvider, braveProvider, withSearchBackup } from "../src/server/search.ts";

describe("resolveSearchEngineFor (the auto-detect decision)", () => {
	it("no keys: honestly unavailable, no default", () => {
		const out = resolveSearchEngineFor(undefined, {});
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /no search engine configured/i);
	});

	it("a key alone is enough — no engine choice needed", () => {
		const tav = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001" });
		assert.ok(tav.available);
		assert.equal(tav.engine, "tavily");
		assert.match(tav.reason, /auto/);

		const brv = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" });
		assert.ok(brv.available);
		assert.equal(brv.engine, "brave");
	});

	it("both keys, no pin: preference order — Tavily first (owner decision)", () => {
		const out = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "tavily");
	});

	it("the explicit pin wins when its key is present", () => {
		const out = resolveSearchEngineFor("brave", {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "brave");
		assert.match(out.reason, /chosen/);
	});

	it("the explicit pin does NOT silently fall back to the other engine", () => {
		const out = resolveSearchEngineFor("tavily", { brave: "brave-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /tavily/);
		assert.match(out.reason, /API key is missing/);
	});

	it("GitHub Copilot search comes first when nothing is pinned — no key needed", () => {
		const alone = resolveSearchEngineFor(undefined, {}, true);
		assert.ok(alone.available);
		assert.equal(alone.engine, "copilot");
		assert.equal(alone.key, null);
		assert.match(alone.reason, /GitHub Copilot \(auto\)/);

		const withKeys = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001", brave: "brave-throwaway-key-00001" }, true);
		assert.equal(withKeys.engine, "copilot");
	});

	it("a pinned keyed engine still beats Copilot search, and a keyless pin stays unavailable", () => {
		const pinned = resolveSearchEngineFor("brave", { brave: "brave-throwaway-key-00001" }, true);
		assert.equal(pinned.engine, "brave");
		assert.equal(pinned.key, "brave-throwaway-key-00001");

		const keyless = resolveSearchEngineFor("tavily", {}, true);
		assert.ok(!keyless.available);
		assert.match(keyless.reason, /API key is missing/);
	});

	it("signed out of Copilot with no keys: the reason names both ways to turn search on", () => {
		const out = resolveSearchEngineFor(undefined, {}, false);
		assert.ok(!out.available);
		assert.match(out.reason, /sign in to GitHub Copilot or set a Tavily or Brave search API key/);
	});

	it("signed in to Copilot but no model chosen: the reason points to the models, and a key still works", () => {
		const out = resolveSearchEngineFor(undefined, {}, "no-model");
		assert.ok(!out.available);
		assert.match(out.reason, /choose models above to search with GitHub Copilot/);

		const keyed = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" }, "no-model");
		assert.equal(keyed.engine, "brave");
	});
});

describe("withSearchBackup (Copilot search with a keyed engine behind it)", () => {
	const hit = (url: string) => ({ title: url, url, snippet: "" });

	it("uses the backup only when the primary search fails", async () => {
		const warn = mock.method(console, "warn", () => undefined);
		try {
			let backupCalls = 0;
			const backup: SearchProvider = { id: "tavily", search: async () => (backupCalls++, [hit("https://backup.test/")]) };
			const ok = withSearchBackup({ id: "copilot", search: async () => [hit("https://copilot.test/")] }, backup);
			assert.equal(ok.id, "copilot");
			assert.deepEqual((await ok.search("q", 5)).map((h) => h.url), ["https://copilot.test/"]);
			assert.equal(backupCalls, 0);

			const failing = withSearchBackup({ id: "copilot", search: async () => { throw new Error("search timed out"); } }, backup);
			assert.deepEqual((await failing.search("q", 5)).map((h) => h.url), ["https://backup.test/"]);
			assert.equal(backupCalls, 1);
			assert.match(String(warn.mock.calls[0]?.arguments[0]), /copilot failed, using tavily: search timed out/);
		} finally {
			warn.mock.restore();
		}
	});
});

/** A Copilot web_search result shaped like the recorded tool output: an
 *  answer whose citation markers (【3:n†source】) sit at each annotation's
 *  start_index, followed by the URL the marker cites. */
function copilotPayload(parts: (string | { url: string; title: string })[]) {
	let value = "";
	const annotations: { start_index: number; end_index: number; text: string; url_citation: { title: string; url: string } }[] = [];
	for (const part of parts) {
		if (typeof part === "string") {
			value += part;
			continue;
		}
		const marker = `【3:${annotations.length + 1}†source】`;
		annotations.push({ start_index: value.length, end_index: value.length + marker.length, text: "", url_citation: part });
		value += marker;
	}
	return { annotations: null, bing_searches: [{ text: "q", url: "https://www.bing.com/search?q=q" }], text: { annotations, value }, type: "output_text" };
}

const SOURCE_A = { url: "https://nodejs.test/releases", title: "Node.js releases" };
const SOURCE_B = { url: "https://blog.test/node-24", title: "Node 24 is LTS" };
const SOURCE_C = { url: "https://nodejs.test/blog", title: "Release notes" };
const PAYLOAD = copilotPayload([
	"The latest **Node.js** LTS line is 24, codenamed Krypton.",
	SOURCE_A,
	SOURCE_B,
	"\n\n### Details\n- Security fixes ship until April 2028.",
	SOURCE_A,
	"\n- See the [release notes](https://nodejs.test/blog) for more.",
	SOURCE_C,
	{ url: "ftp://files.test/node.tar", title: "not a web page" },
]);

describe("copilotSearchHits (Copilot web_search result → hits)", () => {
	it("one hit per cited URL, its snippet the plain answer passage that cites it", () => {
		assert.deepEqual(copilotSearchHits({ structuredContent: PAYLOAD }, 10), [
			{ ...SOURCE_A, snippet: "The latest Node.js LTS line is 24, codenamed Krypton. … Security fixes ship until April 2028." },
			{ ...SOURCE_B, snippet: "The latest Node.js LTS line is 24, codenamed Krypton." },
			{ ...SOURCE_C, snippet: "See the release notes for more." },
		]);
		assert.equal(copilotSearchHits({ structuredContent: PAYLOAD }, 2).length, 2);
	});

	it("reads the answer from the text content when there is no structured copy", () => {
		const urls = (result: unknown) => copilotSearchHits(result, 10).map((h) => h.url);
		const expected = [SOURCE_A.url, SOURCE_B.url, SOURCE_C.url];
		assert.deepEqual(urls({ content: `${JSON.stringify(PAYLOAD)}\n\n${JSON.stringify({ note: "trailing document" })}` }), expected);
		assert.deepEqual(urls({ contents: [{ type: "text", text: JSON.stringify(PAYLOAD) }] }), expected);
	});

	it("falls back to citable sources, and refuses a result it cannot read", () => {
		assert.deepEqual(copilotSearchHits({ citableSources: [{ id: "1", title: "Doc", url: "https://doc.test/", content: "A **bold** claim." }] }, 5), [
			{ title: "Doc", url: "https://doc.test/", snippet: "A bold claim." },
		]);
		assert.throws(() => copilotSearchHits({ content: "plain text, not JSON" }, 5), /could not read/);
		assert.throws(() => copilotSearchHits(undefined, 5), /could not read/);
	});
});

const searchEvent = (type: string, data: Record<string, unknown>) => ({ id: type, timestamp: "", parentId: null, type, data }) as unknown as SessionEvent;

/** A fake Copilot runtime whose one session plays `script` after the query is sent. */
function fakeCopilot(script: (emit: (type: string, data: Record<string, unknown>) => void) => void) {
	const log: string[] = [];
	const specs: SessionSpec[] = [];
	const handlers = new Set<(event: SessionEvent) => void>();
	const session = {
		sessionId: "search-session",
		on(handler: (event: SessionEvent) => void) {
			handlers.add(handler);
			return () => void handlers.delete(handler);
		},
		async send(options: MessageOptions) {
			log.push(`send:${options.prompt}`);
			setImmediate(() => script((type, data) => [...handlers].forEach((handler) => handler(searchEvent(type, data)))));
		},
		async abort() {
			log.push("abort");
		},
		async disconnect() {
			log.push("disconnect");
		},
	};
	const port = {
		async createSession(spec: SessionSpec) {
			specs.push(spec);
			return session;
		},
		async deleteSession(id: string) {
			log.push(`delete:${id}`);
		},
	} as unknown as CopilotRuntimePort;
	return { log, specs, runtime: async () => port };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("copilotWebSearch (one Copilot session per search)", () => {
	it("returns the hosted web_search's cited sources and closes the session", async () => {
		const fake = fakeCopilot((emit) => {
			emit("tool.execution_start", { toolCallId: "intent", toolName: "report_intent" });
			emit("tool.execution_complete", { toolCallId: "intent", success: true, result: { content: "ok" } });
			emit("tool.execution_start", { toolCallId: "s1", toolName: "web_search", mcpServerName: "github-mcp-server", mcpToolName: "web_search" });
			emit("tool.execution_complete", { toolCallId: "s1", success: true, result: { content: JSON.stringify(PAYLOAD), structuredContent: PAYLOAD } });
		});
		const hits = await copilotWebSearch("node lts", 5, { model: "claude-haiku-4.5", runtime: fake.runtime });
		assert.deepEqual(hits.map((h) => h.url), [SOURCE_A.url, SOURCE_B.url, SOURCE_C.url]);
		assert.equal(fake.specs[0]?.model, "claude-haiku-4.5");
		assert.deepEqual(fake.specs[0]?.tools, []);
		assert.deepEqual(fake.specs[0]?.mcpTools, ["web_search"]);
		await settle();
		assert.deepEqual(fake.log, ["send:node lts", "abort", "disconnect", "delete:search-session"]);
	});

	it("rejects when the search fails, when the model never searches, and on a Copilot error", async () => {
		const options = (fake: ReturnType<typeof fakeCopilot>) => ({ model: "m", runtime: fake.runtime });
		const failed = fakeCopilot((emit) => {
			emit("tool.execution_start", { toolCallId: "s1", toolName: "web_search", mcpToolName: "web_search" });
			emit("tool.execution_complete", { toolCallId: "s1", success: false, error: { message: "upstream unavailable" } });
		});
		await assert.rejects(copilotWebSearch("q", 5, options(failed)), /Copilot web search failed: upstream unavailable/);

		const neverSearched = fakeCopilot((emit) => emit("session.idle", {}));
		await assert.rejects(copilotWebSearch("q", 5, options(neverSearched)), /not available for this account/);

		const signedOut = fakeCopilot((emit) => emit("session.error", { errorType: "authentication", message: "Not authenticated", statusCode: 401 }));
		await assert.rejects(copilotWebSearch("q", 5, options(signedOut)), /GitHub Copilot is not signed in/);

		await settle();
		for (const fake of [failed, neverSearched, signedOut]) assert.ok(fake.log.includes("delete:search-session"));
	});

	it("gives up after the timeout", async () => {
		const silent = fakeCopilot(() => undefined);
		await assert.rejects(copilotWebSearch("q", 5, { model: "m", runtime: silent.runtime, timeoutMs: 20 }), /timed out/);
		await settle();
		assert.ok(silent.log.includes("delete:search-session"));
	});
});

/** A one-shot stub fetch: asserts the request shape and returns the canned response. */
function stubFetch(canned: unknown, expect: (url: string, init: RequestInit) => void) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		expect(url, init);
		return new Response(JSON.stringify(canned), { status: 200 });
	};
}

describe("tavilyProvider (wire shape per docs.tavily.com, verified 2026-09-20)", () => {
	it("POSTs api.tavily.com/search with Bearer auth + the query body", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/a", content: "line1\nline2" },
					{ title: "No URL", content: "dropped" },
				],
			},
			(url, init) => {
				assert.equal(url, "https://api.tavily.com/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer tvly-throwaway-key-00001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.max_results, 5);
				// The legacy api_key-in-body form is retired — auth is the header.
				assert.equal(body.api_key, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/a", snippet: "line1 line2" }]);
	});

	it("maps the {detail:{error}} error body into the message", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", async () =>
			new Response(JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Tavily search API 401: Unauthorized/);
	});
});

describe("braveProvider (wire shape per Brave's dashboard docs, verified 2026-09-20)", () => {
	it("GETs res/v1/web/search with the X-Subscription-Token header", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", stubFetch(
			{
				web: {
					results: [
						{ title: "Example", url: "https://example.com/b", description: "a description" },
						{ description: "dropped — no url" },
					],
				},
			},
			(url, init) => {
				assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), url);
				assert.ok(url.includes("q=test+query"), url); // URLSearchParams: spaces as +
				assert.ok(url.includes("count=5"));
				const headers = init.headers as Record<string, string>;
				assert.equal(headers["x-subscription-token"], "brave-throwaway-key-00001");
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/b", snippet: "a description" }]);
	});

	it("surfaces the HTTP status on failure", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", async () =>
			new Response("rate limited", { status: 429 }),
		);
		await assert.rejects(provider.search("q", 5), /Brave search API 429/);
	});
});
