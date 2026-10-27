/**
 * GitHub Copilot's hosted web search as a Cairn search engine.
 *
 * Each search opens a short Copilot session whose only tool is the hosted
 * web_search (from Copilot's built-in GitHub MCP server), asks the model
 * to run the query once, keeps the tool's own result — an answer with URL
 * citations — and closes the session before the model writes anything
 * else. Copilot's search is Bing-backed and takes roughly 20–40 seconds.
 */
import type { SessionEvent } from "@github/copilot-sdk";
import type { SearchHit, SearchProvider } from "../../core/search.ts";
import { copilotRuntime, type CopilotRuntimePort } from "./runtime.ts";
import { copilotErrorText } from "./stream.ts";

const SEARCH_TIMEOUT_MS = 90_000;
const SNIPPET_MAX = 500;
const PASSAGE_MAX = 300;

const RELAY_PROMPT =
	"You run web searches for another program. Call the web_search tool exactly once, using the " +
	"user's message verbatim as the query. Do not answer from memory and do not call any other tool.";

export interface CopilotSearchOptions {
	/** The Copilot model that issues the search call. */
	model: string;
	/** Test seam: a fake runtime replaces the real one. */
	runtime?: () => Promise<CopilotRuntimePort>;
	timeoutMs?: number;
}

interface Citation {
	start_index?: number;
	url_citation?: { title?: string; url?: string };
}

interface SearchPayload {
	text: { value?: string; annotations?: Citation[] | null };
}

interface ToolResultLike {
	content?: string;
	contents?: unknown[];
	structuredContent?: unknown;
	citableSources?: { content?: string; title?: string; url?: string }[];
}

function isPayload(value: unknown): value is SearchPayload {
	return typeof value === "object" && value !== null && typeof (value as SearchPayload).text === "object" && (value as SearchPayload).text !== null;
}

/** The first JSON document in `text` (the tool may append more after a blank line). */
function firstJson(text: unknown): unknown {
	if (typeof text !== "string" || !text.trim()) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		for (let end = text.indexOf("}\n"); end !== -1; end = text.indexOf("}\n", end + 1)) {
			try {
				return JSON.parse(text.slice(0, end + 1));
			} catch {
				// Not a document boundary; keep looking.
			}
		}
	}
	return undefined;
}

function payloadOf(result: ToolResultLike | undefined): SearchPayload | undefined {
	if (isPayload(result?.structuredContent)) return result.structuredContent;
	const texts = [result?.content, ...(result?.contents ?? []).map((part) => (part as { text?: unknown } | null)?.text)];
	for (const text of texts) {
		const parsed = firstJson(text);
		if (isPayload(parsed)) return parsed;
	}
	return undefined;
}

function plain(text: string): string {
	return text
		.replace(/【[^】]*】/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*|__|`/g, "")
		.replace(/^\s*(#+|[-+*]|\d+\.)\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The answer text a citation marker at `index` supports: the run of text
 *  since the previous marker or line break, trimmed to whole sentences. */
function citedPassage(answer: string, index: number | undefined): string {
	if (index === undefined || index <= 0) return "";
	const before = answer.slice(0, index).replace(/(\s*【[^】]*】)+\s*$/u, "");
	let text = plain(before.slice(Math.max(before.lastIndexOf("】"), before.lastIndexOf("\n")) + 1));
	if (text.length > PASSAGE_MAX) {
		text = text.slice(-PASSAGE_MAX);
		const sentence = text.search(/[.!?]\s/);
		text = sentence >= 0 ? text.slice(sentence + 2) : text.slice(text.indexOf(" ") + 1);
	}
	return text;
}

/** Turn Copilot's web_search result into search hits: one per cited URL,
 *  its snippet the answer passage that cites it. */
export function copilotSearchHits(result: unknown, count: number): SearchHit[] {
	const raw = (typeof result === "object" && result !== null ? result : undefined) as ToolResultLike | undefined;
	const payload = payloadOf(raw);
	const sources = raw?.citableSources ?? [];
	if (!payload && !sources.length) throw new Error("Copilot web search returned a result Cairn could not read");
	const hits = new Map<string, SearchHit>();
	const add = (url: string | undefined, title: string | undefined, snippet: string) => {
		if (!url || !/^https?:\/\//i.test(url)) return;
		const hit = hits.get(url);
		if (!hit) hits.set(url, { title: title?.trim() || url, url, snippet: snippet.slice(0, SNIPPET_MAX) });
		else if (snippet && !hit.snippet.includes(snippet)) hit.snippet = (hit.snippet ? `${hit.snippet} … ${snippet}` : snippet).slice(0, SNIPPET_MAX);
	};
	const answer = payload?.text.value ?? "";
	for (const citation of payload?.text.annotations ?? []) {
		add(citation.url_citation?.url, citation.url_citation?.title, citedPassage(answer, citation.start_index));
	}
	for (const source of sources) add(source.url, source.title, plain(source.content ?? ""));
	return [...hits.values()].slice(0, count);
}

function isWebSearch(data: { toolName: string; mcpToolName?: string }): boolean {
	return data.mcpToolName === "web_search" || data.toolName === "web_search";
}

/** Run one search through Copilot's hosted web_search tool. */
export async function copilotWebSearch(query: string, count: number, options: CopilotSearchOptions): Promise<SearchHit[]> {
	const port = await (options.runtime ?? copilotRuntime)();
	const session = await port.createSession({ model: options.model, systemPrompt: RELAY_PROMPT, tools: [], mcpTools: ["web_search"] });
	try {
		const result = await new Promise<unknown>((resolve, reject) => {
			const searches = new Set<string>();
			let settled = false;
			let unsubscribe: () => void = () => undefined;
			const finish = (error: Error | undefined, value?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				if (error) reject(error);
				else resolve(value);
			};
			const timer = setTimeout(() => finish(new Error("Copilot web search timed out")), options.timeoutMs ?? SEARCH_TIMEOUT_MS);
			unsubscribe = session.on((event: SessionEvent) => {
				switch (event.type) {
					case "tool.execution_start":
						if (isWebSearch(event.data)) searches.add(event.data.toolCallId);
						return;
					case "tool.execution_complete":
						if (!searches.has(event.data.toolCallId)) return;
						if (!event.data.success) return finish(new Error(`Copilot web search failed: ${event.data.error?.message ?? "unknown error"}`));
						return finish(undefined, event.data.result);
					case "session.error":
						return finish(new Error(copilotErrorText(event.data.message || event.data.errorType, event.data.statusCode)));
					case "session.idle":
						return finish(new Error("Copilot web search is not available for this account (the model was not offered the web_search tool)"));
				}
			});
			session.send({ prompt: query }).catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
		});
		return copilotSearchHits(result, count);
	} finally {
		// The model would go on to summarize the results; stop it and drop the session.
		void session
			.abort()
			.catch(() => undefined)
			.then(() => session.disconnect())
			.catch(() => undefined)
			.then(() => port.deleteSession(session.sessionId))
			.catch(() => undefined);
	}
}

export function copilotSearchProvider(options: CopilotSearchOptions): SearchProvider {
	return { id: "copilot", search: (query, count) => copilotWebSearch(query, count, options) };
}
