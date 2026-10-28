/**
 * Web search (search port wave, 2026-09-20; Copilot-only since
 * 2026-10-27, when the keyed Tavily/Brave engines retired): GitHub
 * Copilot's hosted web search against a FAKE Copilot runtime (result
 * shape from a recorded Copilot web_search call).
 *
 * PURE + injected runtime — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageOptions, SessionEvent } from "@github/copilot-sdk";
import type { CopilotRuntimePort, SessionSpec } from "../src/agent/copilot/runtime.ts";
import { copilotSearchHits, copilotWebSearch } from "../src/agent/copilot/search.ts";

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
