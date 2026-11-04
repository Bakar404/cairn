import packageMetadata from "../../package.json" with { type: "json" };
import {
	LEARN_CODE_SAMPLES_TOOL,
	LEARN_FETCH_TOOL,
	LEARN_MCP_URL,
	LEARN_SEARCH_TOOL,
	parseLearnCodeSamples,
	parseLearnSearch,
	type LearnDocsClient,
} from "../core/learn-docs.ts";

/**
 * THE MICROSOFT LEARN ADAPTER (M21): core/learn-docs.ts's LearnDocsClient
 * over the Microsoft Learn MCP server (streamable HTTP, public, no
 * sign-in). No SDK dependency: JSON-RPC over fetch by hand, like the Work
 * IQ adapter. The researcher reads Microsoft's documentation through it and
 * the Goals picker reads certification study guides.
 *
 * One initialize per process, shared by every call (a failed one is retried
 * by the next call), then one tools/call per request. A 404 on a call that
 * carried a session id means the server dropped the session: initialize
 * again and retry once. Every request is bounded by its own timeout and by
 * the caller's signal. Cairn sends only the learner's query or a Learn URL.
 * Under NODE_ENV=test the shared client never reaches the network.
 */

const PROTOCOL_VERSION = "2025-06-18";
/** Per request: a researcher tool call has 30 s in all (tool-execute.ts). */
const TIMEOUT_MS = 25_000;
const ERROR_CHARS = 300;

const REASON = {
	test: "Microsoft Learn is off under tests.",
	unreadable: "Microsoft Learn sent an answer Cairn couldn't read.",
} as const;

export interface HttpLearnDocsOptions {
	/** Default LEARN_MCP_URL. */
	url?: string;
	/** Default the global fetch. */
	fetch?: typeof fetch;
	/** Per request; default 25 s. */
	timeoutMs?: number;
}

interface JsonRpcMessage {
	id?: unknown;
	result?: unknown;
	error?: unknown;
}

export function createHttpLearnDocsClient(options: HttpLearnDocsOptions = {}): LearnDocsClient {
	const url = options.url ?? LEARN_MCP_URL;
	const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
	let session: Promise<string | null> | null = null;
	let nextId = 1;

	/** One POST, body read included, inside the timeout and the caller's signal. */
	async function request(
		message: Record<string, unknown>,
		sessionId: string | null,
		callerSignal?: AbortSignal,
	): Promise<{ response: Response; body: string }> {
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (message.method !== "initialize") headers["MCP-Protocol-Version"] = PROTOCOL_VERSION;
		if (sessionId) headers["Mcp-Session-Id"] = sessionId;
		try {
			const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(message), signal });
			return { response, body: await response.text() };
		} catch (err) {
			if (callerSignal?.aborted) throw abortError();
			if (timeout.aborted) throw new Error(`Microsoft Learn didn't answer within ${duration(timeoutMs)}.`);
			throw new Error(`Couldn't reach Microsoft Learn: ${errorMessage(err)}`);
		}
	}

	function initialize(): Promise<string | null> {
		if (session) return session;
		const attempt = (async () => {
			const id = nextId++;
			const { response, body } = await request(
				{
					jsonrpc: "2.0",
					id,
					method: "initialize",
					params: {
						protocolVersion: PROTOCOL_VERSION,
						capabilities: {},
						clientInfo: { name: "cairn", version: packageMetadata.version },
					},
				},
				null,
			);
			if (!response.ok) throw httpError(response, body);
			rpcResult(response, body, id);
			const sessionId = response.headers.get("mcp-session-id");
			// Best effort: a stateless server answers 202 and needs nothing more.
			await request({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId).catch(() => undefined);
			return sessionId;
		})();
		session = attempt;
		attempt.catch(() => {
			if (session === attempt) session = null;
		});
		return attempt;
	}

	async function callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) throw abortError();
		for (let attempt = 0; ; attempt++) {
			const init = initialize();
			const sessionId = await abortable(init, signal);
			const id = nextId++;
			const { response, body } = await request(
				{ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
				sessionId,
				signal,
			);
			if (attempt === 0 && sessionId && isSessionError(response, body)) {
				if (session === init) session = null;
				continue;
			}
			if (!response.ok) throw httpError(response, body);
			return toolText(rpcResult(response, body, id));
		}
	}

	return {
		async search(query, signal) {
			return parseLearnSearch(await callTool(LEARN_SEARCH_TOOL, { query }, signal));
		},
		fetch(pageUrl, signal) {
			return callTool(LEARN_FETCH_TOOL, { url: pageUrl }, signal);
		},
		async codeSamples(query, language, signal) {
			const args = language ? { query, language } : { query };
			return parseLearnCodeSamples(await callTool(LEARN_CODE_SAMPLES_TOOL, args, signal));
		},
	};
}

/** The server forgot the session (404), or wants one it doesn't have. */
function isSessionError(response: Response, body: string): boolean {
	return response.status === 404 || (response.status === 400 && /session/i.test(body));
}

/** The JSON-RPC answer to request `id`, from a JSON or an SSE body. */
function rpcResult(response: Response, body: string, id: number): unknown {
	const type = response.headers.get("content-type") ?? "";
	const messages = type.includes("text/event-stream") ? sseMessages(body) : jsonMessages(body);
	const match = messages.find((m) => m.id === id) ?? messages.at(-1);
	if (!match) throw new Error(REASON.unreadable);
	if (match.error !== undefined) throw new Error(`Microsoft Learn: ${rpcErrorText(match.error)}`);
	return match.result;
}

function jsonMessages(body: string): JsonRpcMessage[] {
	try {
		const parsed: unknown = JSON.parse(body);
		const list = Array.isArray(parsed) ? parsed : [parsed];
		return list.filter((m): m is JsonRpcMessage => typeof m === "object" && m !== null);
	} catch {
		return [];
	}
}

/** Each SSE event's data lines, joined and parsed; unparsable events skip. */
function sseMessages(body: string): JsonRpcMessage[] {
	const messages: JsonRpcMessage[] = [];
	let data: string[] = [];
	const flush = () => {
		if (data.length > 0) messages.push(...jsonMessages(data.join("\n")));
		data = [];
	};
	for (const line of body.split(/\r?\n/)) {
		if (line === "") flush();
		else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
	}
	flush();
	return messages;
}

function rpcErrorText(error: unknown): string {
	if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
		return cap((error as { message: string }).message);
	}
	return "the request failed.";
}

/** A tools/call result's text parts, joined; isError results throw their text. */
function toolText(result: unknown): string {
	if (typeof result !== "object" || result === null) throw new Error(REASON.unreadable);
	const { content, isError } = result as { content?: unknown; isError?: unknown };
	const text = (Array.isArray(content) ? content : [])
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n\n");
	if (isError === true) throw new Error(`Microsoft Learn: ${cap(text.trim()) || "the tool reported an error."}`);
	return text;
}

function httpError(response: Response, body: string): Error {
	const detail = cap(body.replace(/\s+/g, " ").trim());
	return new Error(`Microsoft Learn answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}

/** The caller stops waiting on abort; the shared promise runs on. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

function abortError(): Error {
	const err = new Error("Microsoft Learn request aborted");
	err.name = "AbortError";
	return err;
}

function errorMessage(err: unknown): string {
	const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
	return `${err instanceof Error ? err.message : String(err)}${cause}`;
}

function cap(text: string): string {
	return text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS - 1)}…` : text;
}

function duration(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

// ─── The process's client ─────────────────────────────────────────────────

const liveClient = createHttpLearnDocsClient();

function offUnderTests(): Promise<never> | null {
	return process.env.NODE_ENV === "test" ? Promise.reject(new Error(REASON.test)) : null;
}

/** The client the researcher and the Goals picker read Microsoft Learn through. */
export const learnDocsClient: LearnDocsClient = {
	search: (query, signal) => offUnderTests() ?? liveClient.search(query, signal),
	fetch: (pageUrl, signal) => offUnderTests() ?? liveClient.fetch(pageUrl, signal),
	codeSamples: (query, language, signal) => offUnderTests() ?? liveClient.codeSamples(query, language, signal),
};
