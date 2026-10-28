/**
 * The search-provider port (search port + model slots wave, 2026-09-20).
 *
 * Web search sits behind ONE seam: the server composes the live adapter
 * (src/server/search.ts) and the agent-layer tool depends on this port
 * only. Since 2026-10-27 the one engine is GitHub Copilot's hosted web
 * search — no key, live while Copilot is signed in and the researcher
 * runs on a Copilot model. The keyed Tavily/Brave engines and the
 * agent.search.engine preference retired; a future engine is one more
 * SearchProviderId plus its adapter.
 *
 * Nothing silently falls back: no engine live = search is honestly
 * unavailable (the tool says so).
 *
 * Pure types + protocol docs only (browser-safe, no node imports).
 */

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** Every engine that can serve a search. "copilot" is GitHub Copilot's
 *  hosted web search: it needs no key and is used while Copilot is
 *  signed in. */
export type SearchProviderId = "copilot";

/** A live search engine: an id (for labels) + one operation. The
 *  adapters own their wire protocol (timeouts, error mapping) — callers
 *  see only this. `search` throws on failure (adapters map errors to
 *  clear Error messages); the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchProviderId;
	search(query: string, count: number): Promise<SearchHit[]>;
}