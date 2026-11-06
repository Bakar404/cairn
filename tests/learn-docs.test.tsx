/**
 * MICROSOFT LEARN (M21): research grounded in Microsoft's official
 * documentation — deterministic, no network, no real Learn server:
 *
 *   1. the pure parsers: search and code-sample answers, Learn URLs, exam
 *      codes, a certification's study guide, and the learning-goal guard,
 *      count and outline
 *   2. the HTTP MCP adapter against a fake fetch: the exact JSON-RPC
 *      exchange over SSE and JSON, the session retry, each way Learn can
 *      fail, the timeout, the caller's abort, and the NODE_ENV=test gate on
 *      the shared client
 *   3. the learn_* tools: honest strings when off or failing; mapped,
 *      clipped and capped answers when on
 *   4. the researcher: the tools and the official-docs paragraph join only
 *      with a client
 *   5. the Settings switch: the strict writer, the lenient reader,
 *      learnDocsEnabled, and the Agent section's row
 */

import "./isolated-data-dir.ts";
import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import packageMetadata from "../package.json" with { type: "json" };
import { AgentSection, composeLearnDocs } from "../components/settings/agent-section.tsx";
import { researcherInstructions, runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { createLearnTools } from "../src/agent/tools/learn.ts";
import {
	isLearnUrl,
	normalizeExamCode,
	parseLearnCodeSamples,
	parseLearnSearch,
	parseStudyGuide,
	studyGuideUrl,
	type LearnCodeSample,
	type LearnDocsClient,
	type LearnSearchHit,
} from "../src/core/learn-docs.ts";
import { GOAL_LIMITS, goalItemCount, goalOutline, parseLearningGoal, type LearningGoal } from "../src/core/learning-goals.ts";
import { sanitizeUserSettings, type AgentSettings } from "../src/core/settings.ts";
import { learnDocsEnabled, resolveSettings } from "../src/core/settings-resolution.ts";
import { createHttpLearnDocsClient, learnDocsClient } from "../src/server/learn-docs.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";

const LEARN = "https://learn.microsoft.com/en-us";

/** Run with some environment values set, then put them back. */
async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
	const env = process.env as Record<string, string | undefined>;
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, env[key]]));
	Object.assign(env, values);
	try {
		return await run();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
	}
}

// ─── 1. the pure parsers ─────────────────────────────────────────────────────

describe("Microsoft Learn's answers", () => {
	it("parseLearnSearch reads {results} and a bare array, and drops entries without a title or url", () => {
		const answer = JSON.stringify({
			results: [
				{ title: " Azure Functions overview ", content: " Run code on demand. ", contentUrl: `${LEARN}/azure/azure-functions/` },
				{ title: "No url", content: "dropped" },
				{ content: "no title", contentUrl: `${LEARN}/x` },
				"junk",
				{ title: "Url fallback", url: `${LEARN}/azure/` },
			],
		});
		assert.deepEqual(parseLearnSearch(answer), [
			{ title: "Azure Functions overview", url: `${LEARN}/azure/azure-functions/`, content: "Run code on demand." },
			{ title: "Url fallback", url: `${LEARN}/azure/`, content: "" },
		]);
		assert.deepEqual(parseLearnSearch(JSON.stringify([{ title: "T", contentUrl: `${LEARN}/t` }])), [
			{ title: "T", url: `${LEARN}/t`, content: "" },
		]);
		assert.deepEqual(parseLearnSearch('{"results":[]}'), []);
	});

	it("an answer that isn't JSON, or comes in an unknown shape, throws a clear error", () => {
		assert.throws(() => parseLearnSearch("Search is down"), {
			message: "Microsoft Learn search sent an answer that isn't JSON.",
		});
		assert.throws(() => parseLearnSearch('{"items":[]}'), {
			message: "Microsoft Learn search sent an answer in a shape Cairn doesn't know.",
		});
		assert.throws(() => parseLearnCodeSamples("<html>"), {
			message: "Microsoft Learn code samples sent an answer that isn't JSON.",
		});
		assert.throws(() => parseLearnCodeSamples("42"), {
			message: "Microsoft Learn code samples sent an answer in a shape Cairn doesn't know.",
		});
	});

	it("parseLearnCodeSamples keeps samples with code and a link; the language is optional", () => {
		const samples = [
			{ description: "Upload a blob", codeSnippet: "client.upload_blob(data)", link: `${LEARN}/storage/`, language: "python" },
			{ description: "No code", link: `${LEARN}/x` },
			{ description: "No link", codeSnippet: "x()" },
			{ code: "az storage blob upload", url: `${LEARN}/cli/`, language: "  " },
		];
		const expected: LearnCodeSample[] = [
			{ description: "Upload a blob", code: "client.upload_blob(data)", url: `${LEARN}/storage/`, language: "python" },
			{ description: "", code: "az storage blob upload", url: `${LEARN}/cli/` },
		];
		assert.deepEqual(parseLearnCodeSamples(JSON.stringify(samples)), expected);
		assert.deepEqual(parseLearnCodeSamples(JSON.stringify({ results: samples })), expected);
	});

	it("isLearnUrl accepts only https pages on learn.microsoft.com", () => {
		assert.equal(isLearnUrl(`${LEARN}/azure/`), true);
		assert.equal(isLearnUrl("https://LEARN.microsoft.com/en-us/dotnet/"), true, "the host's case doesn't matter");
		assert.equal(isLearnUrl("http://learn.microsoft.com/en-us/azure/"), false, "plain http");
		assert.equal(isLearnUrl("https://learn.microsoft.com.evil.example/azure/"), false, "a look-alike host");
		assert.equal(isLearnUrl("https://evil.example/?next=https://learn.microsoft.com/"), false);
		assert.equal(isLearnUrl("https://docs.microsoft.com/en-us/azure/"), false, "another Microsoft host");
		assert.equal(isLearnUrl("learn.microsoft.com/en-us/azure/"), false, "no scheme");
		assert.equal(isLearnUrl(""), false);
	});
});

const AZ104 = studyGuideUrl("az-104");

/** The shape of a real study guide (probed live, trimmed): the retirement
 *  notice under "Purpose of this document" after a bare "Warning" label,
 *  the useful-links table, the current skills with an audience profile and
 *  an at-a-glance list, and the previous version's skills below. */
const GUIDE = `# Study guide for Exam AZ-104: Microsoft Azure Administrator

## Purpose of this document

Warning

This exam will retire on June 30, 2027, at 11:59 PM Central Standard Time. [Learn more](https://techcommunity.microsoft.com/).

This study guide should help you understand what to expect on the exam.

| Useful links | Description |
| --- | --- |
| [Certification renewal](/en-us/credentials/certifications/renew-your-microsoft-certification) | Certifications that will retire stay valid until they expire. |

## Skills measured as of April 18, 2025

### Audience profile

As a candidate for this exam, you should have subject matter expertise in **implementing** Azure.

### Skills at a glance

- Manage Azure identities and governance (20–25%)
- Implement and manage storage (15–20%)

### Manage Azure identities and governance (20–25%)

#### Manage Microsoft Entra users and groups

- Create users and groups
- Manage licenses in [Microsoft Entra ID](https://learn.microsoft.com/en-us/entra/)

#### Manage access to Azure resources

* Manage built-in Azure roles
* Assign roles at **different scopes**

### Implement and manage storage (15 - 20%)

- Configure access to storage
- Configure \`Azure Files\` shares

### Monitor and maintain Azure resources (10–15%)

## Skills measured prior to April 18, 2025

### Deploy and manage Azure compute resources (20–25%)

- An old skill

## Study resources

- [Microsoft Learn](https://learn.microsoft.com/)
`;

const AZ104_GOAL: LearningGoal = {
	kind: "certification",
	title: "Exam AZ-104: Microsoft Azure Administrator",
	source: AZ104,
	note: "This exam will retire on June 30, 2027, at 11:59 PM Central Standard Time.",
	areas: [
		{
			name: "Manage Azure identities and governance",
			weight: "20–25%",
			groups: [
				{ name: "Manage Microsoft Entra users and groups", items: ["Create users and groups", "Manage licenses in Microsoft Entra ID"] },
				{ name: "Manage access to Azure resources", items: ["Manage built-in Azure roles", "Assign roles at different scopes"] },
			],
		},
		{
			name: "Implement and manage storage",
			weight: "15–20%",
			groups: [{ name: "", items: ["Configure access to storage", "Configure Azure Files shares"] }],
		},
	],
};

describe("certification study guides", () => {
	it("normalizeExamCode reads the ways learners write an exam code", () => {
		for (const input of ["AZ-104", "az104", "Exam AZ 104", " exam az-104 ", "Az-104"]) {
			assert.equal(normalizeExamCode(input), "az-104", input);
		}
		assert.equal(normalizeExamCode("SC-900"), "sc-900");
		for (const input of ["hello", "az-1044", "a-104", "azure-104", "104", ""]) {
			assert.equal(normalizeExamCode(input), null, input);
		}
	});

	it("studyGuideUrl is the exam's study guide on Learn", () => {
		assert.equal(AZ104, "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104");
		assert.ok(isLearnUrl(studyGuideUrl("pl-300")));
	});

	it("parseStudyGuide reads the current skills: weighted domains, their groups and skills, and the retirement note", () => {
		assert.deepEqual(parseStudyGuide(GUIDE, AZ104), AZ104_GOAL);
		assert.deepEqual(parseStudyGuide(GUIDE.replace(/\n/g, "\r\n"), AZ104), AZ104_GOAL, "Windows line endings");
	});

	it("without a retirement notice the goal has no note; the links table's mention isn't one", () => {
		const current = GUIDE.replace(/Warning\n\nThis exam will retire[^\n]*\n\n/, "");
		assert.ok(current.includes("will retire stay valid"), "the table row is still there");
		const { note: _note, ...expected } = AZ104_GOAL;
		assert.deepEqual(parseStudyGuide(current, AZ104), expected);
	});

	it("a retirement callout above the first section is read too", () => {
		const callout = GUIDE.replace(/Warning\n\nThis exam will retire[^\n]*\n\n/, "").replace(
			"## Purpose of this document",
			"> [!IMPORTANT]\n> This exam was retired on July 31, 2026. Read the [announcement](https://techcommunity.microsoft.com/).\n\n## Purpose of this document",
		);
		assert.equal(parseStudyGuide(callout, AZ104)?.note, "This exam was retired on July 31, 2026. Read the announcement.");
	});

	it("a page that isn't a study guide, or lists no skills, is null", () => {
		assert.equal(parseStudyGuide("# Azure Functions overview\n\n## Skills measured\n\n### Compute (10%)\n\n- Run code", AZ104), null);
		assert.equal(parseStudyGuide("# Study guide for Exam XX-000: Nothing\n\n## Purpose of this document\n\nText.", AZ104), null);
		assert.equal(
			parseStudyGuide("# Study guide for Exam XX-000: Nothing\n\n## Skills measured\n\n### Audience profile\n\n- Not a skill\n\n### Empty domain (10%)", AZ104),
			null,
		);
		assert.equal(parseStudyGuide("", AZ104), null);
	});

	it("reads a guide laid out like GH-900: skills under Domains, a dated at-a-glance list, groups at ##, a domain at #", () => {
		const gh900 = studyGuideUrl("gh-900");
		const guide = `# Study guide for Exam GH-900: GitHub Foundations

## Purpose of this document

This study guide should help you understand what to expect on the exam.

## About the exam

#### Note

The bullets that follow each of the skills measured are intended to illustrate how we are assessing that skill.

## Domains

### Audience profile

As a candidate for this exam, you should have a fundamental understanding of GitHub.

### Skills at a glance as of January 2026

- Understand Git and GitHub basics (25–30%)
- Work with GitHub repositories (10–15%)

### Understand Git and GitHub basics (25–30%)

#### Version control fundamentals

- Describe the purpose and benefits of version control

### Work with GitHub repositories (10–15%)

## Repository management

- Explain how to add and manage files within a repository

# Understand Privacy, security, and administration (10–15%)

## Security and access management

- Describe how to secure accounts with two-factor authentication (2FA) and passkeys

## Study resources

### Recommendations

- [Microsoft Learn](https://learn.microsoft.com/)

## Change log

- A change
`;
		const expected: LearningGoal = {
			kind: "certification",
			title: "Exam GH-900: GitHub Foundations",
			source: gh900,
			areas: [
				{
					name: "Understand Git and GitHub basics",
					weight: "25–30%",
					groups: [{ name: "Version control fundamentals", items: ["Describe the purpose and benefits of version control"] }],
				},
				{
					name: "Work with GitHub repositories",
					weight: "10–15%",
					groups: [{ name: "Repository management", items: ["Explain how to add and manage files within a repository"] }],
				},
				{
					name: "Understand Privacy, security, and administration",
					weight: "10–15%",
					groups: [
						{
							name: "Security and access management",
							items: ["Describe how to secure accounts with two-factor authentication (2FA) and passkeys"],
						},
					],
				},
			],
		};
		assert.deepEqual(parseStudyGuide(guide, gh900), expected);

		const prose = guide.replace("## Study resources", "## About the domains\n\nSome prose.\n\n### Late domain (10%)\n\n- Not read\n\n## Study resources");
		assert.deepEqual(parseStudyGuide(prose, gh900), expected, "a top-level heading without bullets closes the skills");
	});
});

describe("learning goals (the guard, the count, the outline)", () => {
	it("parseLearningGoal rejects what isn't a goal", () => {
		const area = { name: "Compute", groups: [{ name: "", items: ["Virtual machines"] }] };
		const rejected: unknown[] = [
			null,
			"goal",
			[],
			42,
			{ kind: "exam", title: "T", source: "S", areas: [area] },
			{ kind: "repo", title: "  ", source: "S", areas: [area] },
			{ kind: "repo", title: "T", source: "", areas: [area] },
			{ kind: "repo", title: "T", source: "S", areas: "Compute" },
			{ kind: "repo", title: "T", source: "S", areas: [] },
			{ kind: "repo", title: "T", source: "S", areas: [{ name: " " }, "Compute", null] },
		];
		for (const raw of rejected) assert.equal(parseLearningGoal(raw), null, JSON.stringify(raw));
	});

	it("parseLearningGoal cleans text, drops malformed groups and items, and keeps a named area without groups", () => {
		const goal = parseLearningGoal({
			kind: "repo",
			title: "  The stack\nof cairn ",
			source: "cairn",
			note: "   ",
			extra: "ignored",
			areas: [
				{
					name: "TypeScript",
					weight: 3,
					groups: [
						{ name: "Where this repo uses it", items: ["  src/core\n/*.ts ", 7, "", null] },
						{ name: "no items", items: [] },
						{ name: "items not a list", items: "x" },
						"junk",
					],
				},
				{ name: "Docker" },
			],
		});
		assert.deepEqual(goal, {
			kind: "repo",
			title: "The stack of cairn",
			source: "cairn",
			areas: [
				{ name: "TypeScript", groups: [{ name: "Where this repo uses it", items: ["src/core /*.ts"] }] },
				{ name: "Docker", groups: [] },
			],
		});
	});

	it("parseLearningGoal clamps every list and every text to GOAL_LIMITS", () => {
		const long = "x".repeat(GOAL_LIMITS.text + 50);
		const items = Array.from({ length: GOAL_LIMITS.items + 5 }, (_, i) => `item ${i}`);
		const groups = Array.from({ length: GOAL_LIMITS.groups + 5 }, (_, i) => ({ name: `group ${i}`, items }));
		const areas = Array.from({ length: GOAL_LIMITS.areas + 5 }, (_, i) => ({ name: `area ${i}`, groups }));
		const goal = parseLearningGoal({ kind: "certification", title: long, source: "s", note: long, areas })!;
		assert.equal(goal.areas.length, GOAL_LIMITS.areas);
		assert.equal(goal.areas[0]!.groups.length, GOAL_LIMITS.groups);
		assert.equal(goal.areas[0]!.groups[0]!.items.length, GOAL_LIMITS.items);
		assert.equal(goal.title, `${"x".repeat(GOAL_LIMITS.text - 1)}…`);
		assert.equal(goal.note, goal.title);
		assert.equal(goalItemCount(goal), GOAL_LIMITS.areas * GOAL_LIMITS.groups * GOAL_LIMITS.items);
	});

	it("goalOutline is what the tutor reads: the header, then each area with its weight, groups and items", () => {
		assert.equal(goalItemCount(AZ104_GOAL), 6);
		assert.equal(
			goalOutline(AZ104_GOAL),
			[
				"Goal: Exam AZ-104: Microsoft Azure Administrator",
				"Kind: a Microsoft certification — the skills its exam measures",
				`Source: ${AZ104}`,
				"Note: This exam will retire on June 30, 2027, at 11:59 PM Central Standard Time.",
				"",
				"Areas, with their share of the exam:",
				"1. Manage Azure identities and governance (20–25%)",
				"   Manage Microsoft Entra users and groups:",
				"     - Create users and groups",
				"     - Manage licenses in Microsoft Entra ID",
				"   Manage access to Azure resources:",
				"     - Manage built-in Azure roles",
				"     - Assign roles at different scopes",
				"2. Implement and manage storage (15–20%)",
				"   - Configure access to storage",
				"   - Configure Azure Files shares",
			].join("\n"),
		);
		const repo: LearningGoal = {
			kind: "repo",
			title: "The stack of cairn",
			source: "cairn",
			areas: [{ name: "Next.js", groups: [{ name: "", items: ["app/"] }] }],
		};
		assert.equal(
			goalOutline(repo),
			["Goal: The stack of cairn", "Kind: a code repository — the technologies it is built with", "Source: cairn", "", "Areas:", "1. Next.js", "   - app/"].join("\n"),
		);
	});

	it("goalOutline cuts a huge goal on a line boundary and says how much it cut", () => {
		const item = "y".repeat(GOAL_LIMITS.text);
		const groups = Array.from({ length: GOAL_LIMITS.groups }, (_, g) => ({
			name: `group ${g}`,
			items: Array.from({ length: GOAL_LIMITS.items }, () => item),
		}));
		const goal: LearningGoal = {
			kind: "certification",
			title: "Huge",
			source: "s",
			areas: Array.from({ length: GOAL_LIMITS.areas }, (_, a) => ({ name: `area ${a}`, groups })),
		};
		const outline = goalOutline(goal);
		assert.ok(outline.length <= GOAL_LIMITS.outline, String(outline.length));
		const lines = outline.split("\n");
		const marker = /^\[The outline is cut here: (\d+) more lines\]$/.exec(lines.at(-1)!);
		assert.ok(marker, lines.at(-1));
		const total = 5 + GOAL_LIMITS.areas * (1 + GOAL_LIMITS.groups * (1 + GOAL_LIMITS.items));
		assert.equal(lines.length - 1 + Number(marker[1]), total, "kept lines + cut lines = every line");
		const whole = new RegExp(`^(|Goal: Huge|Kind: .+|Source: s|Areas, .+|\\d+\\. area \\d+|   group \\d+:|     - y{${GOAL_LIMITS.text}})$`);
		for (const line of lines.slice(0, -1)) assert.match(line, whole);
	});
});

// ─── 2. the HTTP MCP adapter against a fake fetch ───────────────────────────

const MCP = "https://learn.example.test/api/mcp";

interface RpcRequest {
	jsonrpc: string;
	id?: number;
	method: string;
	params?: { name?: string; arguments?: Record<string, unknown>; [key: string]: unknown };
}

interface Seen {
	url: string;
	method: string;
	/** Lowercased names. */
	headers: Record<string, string>;
	body: RpcRequest;
	signal: AbortSignal | undefined;
}

type Handler = (request: RpcRequest, seen: Seen) => Response | Promise<Response>;

/** A recording fetch that answers through `handler`. */
function fakeFetch(handler: Handler): { calls: Seen[]; fetch: typeof fetch } {
	const calls: Seen[] = [];
	const fetchImpl = async (input: unknown, init?: RequestInit) => {
		const headers = Object.fromEntries(
			Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
		);
		const body = JSON.parse(String(init?.body)) as RpcRequest;
		const seen: Seen = { url: String(input), method: body.method, headers, body, signal: init?.signal ?? undefined };
		calls.push(seen);
		return handler(body, seen);
	};
	return { calls, fetch: fetchImpl as typeof fetch };
}

/** An SSE answer: one `event: message` per JSON-RPC message. */
function sse(messages: unknown[], headers: Record<string, string> = {}): Response {
	const body = messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream", ...headers } });
}

function json(message: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
	return new Response(JSON.stringify(message), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

const toolText = (text: string) => ({ content: [{ type: "text", text }] });

/** A Learn-like server: initialize (with a session id unless stateless),
 *  202 for notifications, and `answer` for each tools/call — a Response
 *  passes through as is, anything else is the call's result. */
function learnServer(
	answer: (name: string, args: Record<string, unknown>, request: RpcRequest) => unknown,
	options: { session?: string | null; stream?: boolean } = {},
): Handler {
	const session = options.session === undefined ? "session-1" : options.session;
	const stream = options.stream ?? true;
	const reply = (message: unknown, headers: Record<string, string> = {}) =>
		stream ? sse([message], headers) : json(message, { headers });
	return (request) => {
		if (request.method === "initialize") {
			return reply(
				{
					jsonrpc: "2.0",
					id: request.id,
					result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-learn", version: "1.0.0" } },
				},
				session ? { "mcp-session-id": session } : {},
			);
		}
		if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
		const result = answer(request.params?.name ?? "", request.params?.arguments ?? {}, request);
		return result instanceof Response ? result : reply({ jsonrpc: "2.0", id: request.id, result });
	};
}

/** Answers like learnServer, except `method` requests hang until their
 *  signal aborts; `onHang` fires as one starts. */
function hangOn(method: string, onHang?: () => void): Handler {
	const normal = learnServer(() => toolText("page"));
	return (request, seen) => {
		if (request.method !== method) return normal(request, seen);
		onHang?.();
		return new Promise<Response>((_resolve, reject) => {
			const signal = seen.signal!;
			if (signal.aborted) reject(signal.reason);
			else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	};
}

/** AbortSignal.timeout's timer doesn't hold the event loop open: keep it
 *  open while a test waits on one. */
async function holdingTheLoop<T>(run: () => Promise<T>): Promise<T> {
	const hold = setTimeout(() => {}, 10_000);
	try {
		return await run();
	} finally {
		clearTimeout(hold);
	}
}

describe("the Microsoft Learn MCP adapter (fake fetch, no network)", () => {
	it("speaks MCP over SSE: one initialize and its notification, then one tools/call per request", async () => {
		const page = `${LEARN}/azure/azure-functions/functions-overview`;
		const server = fakeFetch(
			learnServer((name, args, request) => {
				if (name === "microsoft_docs_search") {
					return toolText(JSON.stringify({ results: [{ title: "Azure Functions overview", content: "Run code on demand.", contentUrl: page }] }));
				}
				if (name === "microsoft_docs_fetch") {
					// A log notification rides the stream ahead of the answer.
					return sse([
						{ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "fetching" } },
						{ jsonrpc: "2.0", id: request.id, result: toolText(`# Azure Functions overview\n\nRead from ${String(args.url)}`) },
					]);
				}
				return toolText(JSON.stringify([{ description: "Upload a blob", codeSnippet: "client.upload_blob(data)", link: page, language: "python" }]));
			}),
		);
		const client = createHttpLearnDocsClient({ url: MCP, fetch: server.fetch });

		assert.deepEqual(await client.search("azure functions"), [{ title: "Azure Functions overview", url: page, content: "Run code on demand." }]);
		assert.equal(await client.fetch(page), `# Azure Functions overview\n\nRead from ${page}`);
		assert.deepEqual(await client.codeSamples("upload a blob", "python"), [
			{ description: "Upload a blob", code: "client.upload_blob(data)", url: page, language: "python" },
		]);
		await client.codeSamples("upload a blob");

		assert.deepEqual(
			server.calls.map((call) => call.method),
			["initialize", "notifications/initialized", "tools/call", "tools/call", "tools/call", "tools/call"],
		);
		for (const call of server.calls) {
			assert.equal(call.url, MCP);
			assert.equal(call.body.jsonrpc, "2.0");
			assert.equal(call.headers["content-type"], "application/json");
			assert.equal(call.headers.accept, "application/json, text/event-stream");
		}
		const [init, initialized, ...tools] = server.calls;
		assert.deepEqual(init!.body.params, {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "cairn", version: packageMetadata.version },
		});
		assert.equal(init!.headers["mcp-protocol-version"], undefined, "initialize negotiates the version");
		assert.equal(init!.headers["mcp-session-id"], undefined);
		assert.equal(initialized!.body.id, undefined, "a notification carries no id");
		for (const call of [initialized!, ...tools]) {
			assert.equal(call.headers["mcp-session-id"], "session-1");
			assert.equal(call.headers["mcp-protocol-version"], "2025-06-18");
		}
		assert.deepEqual(
			tools.map((call) => call.body.params),
			[
				{ name: "microsoft_docs_search", arguments: { query: "azure functions" } },
				{ name: "microsoft_docs_fetch", arguments: { url: page } },
				{ name: "microsoft_code_sample_search", arguments: { query: "upload a blob", language: "python" } },
				{ name: "microsoft_code_sample_search", arguments: { query: "upload a blob" } },
			],
		);
		const ids = [init!, ...tools].map((call) => call.body.id);
		assert.equal(new Set(ids).size, ids.length, "every request has its own id");
	});

	it("calls that start together share one initialize", async () => {
		const server = fakeFetch(learnServer(() => toolText("[]")));
		const client = createHttpLearnDocsClient({ url: MCP, fetch: server.fetch });
		await Promise.all([client.search("a"), client.search("b"), client.codeSamples("c")]);
		assert.equal(server.calls.filter((call) => call.method === "initialize").length, 1);
		assert.equal(server.calls.filter((call) => call.method === "tools/call").length, 3);
	});

	it("a stateless server that answers JSON works too: no session header, the text parts joined", async () => {
		const server = fakeFetch(
			learnServer(
				() => ({
					content: [
						{ type: "text", text: "Part one." },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
						{ type: "text", text: "Part two." },
					],
				}),
				{ session: null, stream: false },
			),
		);
		const client = createHttpLearnDocsClient({ url: MCP, fetch: server.fetch });
		assert.equal(await client.fetch(`${LEARN}/azure/`), "Part one.\n\nPart two.");
		assert.deepEqual(server.calls.map((call) => call.method), ["initialize", "notifications/initialized", "tools/call"]);
		assert.ok(server.calls.every((call) => call.headers["mcp-session-id"] === undefined));
	});

	it("a JSON batch is read by the request's id", async () => {
		const server = fakeFetch(
			learnServer(
				(_name, _args, request) =>
					json([
						{ jsonrpc: "2.0", id: request.id, result: toolText("mine") },
						{ jsonrpc: "2.0", id: 999, result: toolText("not mine") },
					]),
				{ stream: false },
			),
		);
		assert.equal(await createHttpLearnDocsClient({ url: MCP, fetch: server.fetch }).fetch(`${LEARN}/x`), "mine");
	});

	it("a forgotten session (404) initializes again and retries once", async () => {
		let sessions = 0;
		const server = fakeFetch((request, seen) => {
			if (request.method === "initialize") {
				sessions++;
				return sse([{ jsonrpc: "2.0", id: request.id, result: {} }], { "mcp-session-id": `session-${sessions}` });
			}
			if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (seen.headers["mcp-session-id"] === "session-1") return new Response("Session not found", { status: 404 });
			return sse([{ jsonrpc: "2.0", id: request.id, result: toolText("[]") }]);
		});
		const client = createHttpLearnDocsClient({ url: MCP, fetch: server.fetch });
		assert.deepEqual(await client.search("q"), []);
		assert.deepEqual(
			server.calls.map((call) => `${call.method} ${call.headers["mcp-session-id"] ?? "-"}`),
			[
				"initialize -",
				"notifications/initialized session-1",
				"tools/call session-1",
				"initialize -",
				"notifications/initialized session-2",
				"tools/call session-2",
			],
		);
		await client.search("again");
		assert.equal(sessions, 2, "the new session serves the next call");
	});

	it("a 400 that names the session counts as a forgotten session too", async () => {
		let sessions = 0;
		const server = fakeFetch((request, seen) => {
			if (request.method === "initialize") {
				sessions++;
				return json({ jsonrpc: "2.0", id: request.id, result: {} }, { headers: { "mcp-session-id": `s${sessions}` } });
			}
			if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (seen.headers["mcp-session-id"] === "s1") {
				return json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" } }, { status: 400 });
			}
			return json({ jsonrpc: "2.0", id: request.id, result: toolText("page") });
		});
		assert.equal(await createHttpLearnDocsClient({ url: MCP, fetch: server.fetch }).fetch(`${LEARN}/x`), "page");
		assert.equal(sessions, 2);
	});

	it("it retries only once, and never without a session", async () => {
		const always = fakeFetch(learnServer(() => new Response("Not Found", { status: 404 })));
		await assert.rejects(createHttpLearnDocsClient({ url: MCP, fetch: always.fetch }).search("q"), {
			message: "Microsoft Learn answered HTTP 404: Not Found",
		});
		assert.equal(always.calls.filter((call) => call.method === "tools/call").length, 2);

		const stateless = fakeFetch(learnServer(() => new Response("Not Found", { status: 404 }), { session: null }));
		await assert.rejects(createHttpLearnDocsClient({ url: MCP, fetch: stateless.fetch }).search("q"), {
			message: "Microsoft Learn answered HTTP 404: Not Found",
		});
		assert.equal(stateless.calls.filter((call) => call.method === "tools/call").length, 1);
	});

	it("each way Learn can fail is a clear error", async () => {
		const failing = (
			answer: Parameters<typeof learnServer>[0],
			call: (client: LearnDocsClient) => Promise<unknown> = (client) => client.fetch(`${LEARN}/x`),
		) => call(createHttpLearnDocsClient({ url: MCP, fetch: fakeFetch(learnServer(answer)).fetch }));

		await assert.rejects(
			failing((_name, _args, request) => json({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unknown tool" } })),
			{ message: "Microsoft Learn: Unknown tool" },
		);
		await assert.rejects(failing(() => ({ content: [{ type: "text", text: "Too many requests." }], isError: true })), {
			message: "Microsoft Learn: Too many requests.",
		});
		await assert.rejects(failing(() => ({ content: [], isError: true })), {
			message: "Microsoft Learn: the tool reported an error.",
		});
		await assert.rejects(failing(() => new Response("<html>\n  Internal   error\n</html>", { status: 500 })), {
			message: "Microsoft Learn answered HTTP 500: <html> Internal error </html>",
		});
		await assert.rejects(failing(() => new Response("x".repeat(400), { status: 500 })), {
			message: `Microsoft Learn answered HTTP 500: ${"x".repeat(299)}…`,
		});
		await assert.rejects(failing(() => new Response("", { status: 502 })), { message: "Microsoft Learn answered HTTP 502" });
		await assert.rejects(failing(() => new Response("not json", { headers: { "content-type": "application/json" } })), {
			message: "Microsoft Learn sent an answer Cairn couldn't read.",
		});
		await assert.rejects(failing(() => "a bare string result"), {
			message: "Microsoft Learn sent an answer Cairn couldn't read.",
		});
		await assert.rejects(
			failing(
				() => toolText("Search is down"),
				(client) => client.search("q"),
			),
			{ message: "Microsoft Learn search sent an answer that isn't JSON." },
		);
	});

	it("a failed initialize fails the call, and the next call initializes again", async () => {
		let attempts = 0;
		const server = fakeFetch((request) => {
			if (request.method === "initialize") {
				attempts++;
				if (attempts === 1) return new Response("Service Unavailable", { status: 503 });
				if (attempts === 2) return json({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Initialization failed" } });
				return json({ jsonrpc: "2.0", id: request.id, result: {} }, { headers: { "mcp-session-id": "s3" } });
			}
			if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
			return json({ jsonrpc: "2.0", id: request.id, result: toolText("page") });
		});
		const client = createHttpLearnDocsClient({ url: MCP, fetch: server.fetch });
		await assert.rejects(client.fetch(`${LEARN}/x`), { message: "Microsoft Learn answered HTTP 503: Service Unavailable" });
		await assert.rejects(client.fetch(`${LEARN}/x`), { message: "Microsoft Learn: Initialization failed" });
		assert.equal(await client.fetch(`${LEARN}/x`), "page");
		assert.equal(attempts, 3);
	});

	it("the initialized notification is best effort", async () => {
		const server = fakeFetch((request) => {
			if (request.method === "initialize") return json({ jsonrpc: "2.0", id: request.id, result: {} });
			if (request.method === "notifications/initialized") throw new TypeError("fetch failed");
			return json({ jsonrpc: "2.0", id: request.id, result: toolText("page") });
		});
		assert.equal(await createHttpLearnDocsClient({ url: MCP, fetch: server.fetch }).fetch(`${LEARN}/x`), "page");
	});

	it("an unreachable server is named, with the cause", async () => {
		const unreachable = (async () => {
			throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND learn.microsoft.com") });
		}) as typeof fetch;
		await assert.rejects(createHttpLearnDocsClient({ url: MCP, fetch: unreachable }).search("q"), {
			message: "Couldn't reach Microsoft Learn: fetch failed (getaddrinfo ENOTFOUND learn.microsoft.com)",
		});
	});

	it("a request that outlasts the timeout fails with it, during initialize or during the call", async () => {
		await holdingTheLoop(async () => {
			const slowInit = fakeFetch(hangOn("initialize"));
			await assert.rejects(createHttpLearnDocsClient({ url: MCP, fetch: slowInit.fetch, timeoutMs: 50 }).search("q"), {
				message: "Microsoft Learn didn't answer within 50 ms.",
			});
			const slowCall = fakeFetch(hangOn("tools/call"));
			await assert.rejects(createHttpLearnDocsClient({ url: MCP, fetch: slowCall.fetch, timeoutMs: 50 }).fetch(`${LEARN}/x`), {
				message: "Microsoft Learn didn't answer within 50 ms.",
			});
		});
	});

	it("the caller's abort ends a call at once: during the call, during initialize, or before it starts", async () => {
		const duringCall = new AbortController();
		const callServer = fakeFetch(hangOn("tools/call", () => setImmediate(() => duringCall.abort())));
		await assert.rejects(createHttpLearnDocsClient({ url: MCP, fetch: callServer.fetch }).fetch(`${LEARN}/x`, duringCall.signal), {
			name: "AbortError",
			message: "Microsoft Learn request aborted",
		});

		// The caller stops waiting; the shared initialize runs on to its own end.
		const duringInit = new AbortController();
		const initServer = fakeFetch(hangOn("initialize", () => setImmediate(() => duringInit.abort())));
		await holdingTheLoop(() =>
			assert.rejects(createHttpLearnDocsClient({ url: MCP, fetch: initServer.fetch, timeoutMs: 100 }).search("q", duringInit.signal), {
				name: "AbortError",
			}),
		);
		assert.deepEqual(initServer.calls.map((call) => call.method), ["initialize"], "no tools/call after the abort");

		const idle = fakeFetch(learnServer(() => toolText("[]")));
		await assert.rejects(createHttpLearnDocsClient({ url: MCP, fetch: idle.fetch }).codeSamples("q", undefined, AbortSignal.abort()), {
			name: "AbortError",
		});
		assert.equal(idle.calls.length, 0, "an aborted call sends nothing");
	});

	it("the shared client never reaches the network under tests", async () => {
		const realFetch = globalThis.fetch;
		let fetched = 0;
		globalThis.fetch = (async () => {
			fetched++;
			return new Response("{}");
		}) as typeof fetch;
		try {
			await withEnv({ NODE_ENV: "test" }, async () => {
				for (const call of [
					() => learnDocsClient.search("q"),
					() => learnDocsClient.fetch(`${LEARN}/azure/`),
					() => learnDocsClient.codeSamples("q", "python"),
				]) {
					await assert.rejects(call(), { message: "Microsoft Learn is off under tests." });
				}
			});
		} finally {
			globalThis.fetch = realFetch;
		}
		assert.equal(fetched, 0);
	});
});

// ─── 3. the learn_* tools ────────────────────────────────────────────────────

const UNAVAILABLE =
	"Microsoft Learn is not available: it's switched off in Settings › Agent. Use web_search and web_fetch instead.";

interface FakeLearn extends LearnDocsClient {
	/** [method, ...arguments, whether a signal came along]. */
	seen: unknown[][];
}

function fakeLearn(answers: Partial<LearnDocsClient> = {}): FakeLearn {
	const seen: unknown[][] = [];
	return {
		seen,
		async search(query, signal) {
			seen.push(["search", query, signal instanceof AbortSignal]);
			return answers.search ? answers.search(query, signal) : [];
		},
		async fetch(url, signal) {
			seen.push(["fetch", url, signal instanceof AbortSignal]);
			return answers.fetch ? answers.fetch(url, signal) : "";
		},
		async codeSamples(query, language, signal) {
			seen.push(["codeSamples", query, language, signal instanceof AbortSignal]);
			return answers.codeSamples ? answers.codeSamples(query, language, signal) : [];
		},
	};
}

describe("the learn_* tools", () => {
	it("switched off, every tool says so — and learn_fetch turns other sites away first", async () => {
		const tools = createLearnTools(() => null);
		assert.deepEqual(Object.keys(tools), ["learn_search", "learn_fetch", "learn_code_samples"]);
		assert.equal((await tools.learn_search!.execute("c1", { query: "q" })).details, UNAVAILABLE);
		assert.equal((await tools.learn_code_samples!.execute("c2", { query: "q" })).details, UNAVAILABLE);
		assert.equal((await tools.learn_fetch!.execute("c3", { url: `${LEARN}/azure/` })).details, UNAVAILABLE);
		assert.equal(
			(await tools.learn_fetch!.execute("c4", { url: "https://example.com/page" })).details,
			"learn_fetch reads learn.microsoft.com pages only. Use web_fetch for https://example.com/page",
		);
	});

	it("learn_search returns title, url and a clipped excerpt: 5 by default, count caps it", async () => {
		const hits: LearnSearchHit[] = Array.from({ length: 7 }, (_, i) => ({
			title: `Page ${i}`,
			url: `${LEARN}/p${i}`,
			content: i === 0 ? "z".repeat(2000) : `excerpt ${i}`,
		}));
		const learn = fakeLearn({ search: async () => hits });
		const tools = createLearnTools(() => learn);
		const out = await tools.learn_search!.execute("c1", { query: "azure functions" });
		const results = out.details as { title: string; url: string; excerpt: string }[];
		assert.equal(results.length, 5);
		assert.equal(results[0]!.excerpt, `${"z".repeat(1500)}…`);
		assert.deepEqual(results[1], { title: "Page 1", url: `${LEARN}/p1`, excerpt: "excerpt 1" });
		assert.deepEqual(out.content, [{ type: "text", text: JSON.stringify(results) }]);
		assert.deepEqual(learn.seen, [["search", "azure functions", true]], "the query and the call's signal reach the client");
		const two = await tools.learn_search!.execute("c2", { query: "q", count: 2 });
		assert.equal((two.details as unknown[]).length, 2);
	});

	it("learn_search: nothing found and failures are strings, never thrown", async () => {
		const empty = createLearnTools(() => fakeLearn());
		assert.equal(
			(await empty.learn_search!.execute("c1", { query: "zzz" })).details,
			'learn_search found nothing for "zzz". Try other words, or web_search.',
		);
		const broken = createLearnTools(() =>
			fakeLearn({
				search: async () => {
					throw new Error("Microsoft Learn answered HTTP 503");
				},
			}),
		);
		assert.equal((await broken.learn_search!.execute("c2", { query: "q" })).details, "learn_search failed: Microsoft Learn answered HTTP 503");
	});

	it("learn_fetch returns the page under its source, truncated past 40,000 characters", async () => {
		const url = `${LEARN}/azure/azure-functions/functions-overview`;
		const short = createLearnTools(() => fakeLearn({ fetch: async () => "# Azure Functions\n\nServerless." }));
		assert.equal((await short.learn_fetch!.execute("c1", { url })).details, `Source: ${url}\n\n---\n\n# Azure Functions\n\nServerless.`);
		const long = createLearnTools(() => fakeLearn({ fetch: async () => "w".repeat(50_000) }));
		assert.equal(
			(await long.learn_fetch!.execute("c2", { url })).details,
			`Source: ${url}\n\n---\n\n${"w".repeat(40_000)}\n\n[Truncated at 40000 characters]`,
		);
		const blank = createLearnTools(() => fakeLearn({ fetch: async () => "  \n " }));
		assert.equal((await blank.learn_fetch!.execute("c3", { url })).details, `learn_fetch found no content at ${url}`);
		const broken = createLearnTools(() =>
			fakeLearn({
				fetch: async () => {
					throw new Error("Microsoft Learn didn't answer within 25 s.");
				},
			}),
		);
		assert.equal((await broken.learn_fetch!.execute("c4", { url })).details, "learn_fetch failed: Microsoft Learn didn't answer within 25 s.");
		const learn = fakeLearn();
		const http = await createLearnTools(() => learn).learn_fetch!.execute("c5", { url: "http://learn.microsoft.com/en-us/azure/" });
		assert.match(String(http.details), /^learn_fetch reads learn\.microsoft\.com pages only/);
		assert.equal(learn.seen.length, 0, "a non-Learn url never reaches the client");
	});

	it("learn_code_samples: at most 6, code and description clipped, a blank language is no filter", async () => {
		const samples: LearnCodeSample[] = Array.from({ length: 8 }, (_, i) => ({
			description: i === 0 ? "d".repeat(1600) : `sample ${i}`,
			code: i === 0 ? "c".repeat(3500) : `code ${i}`,
			url: `${LEARN}/s${i}`,
			...(i === 1 ? {} : { language: "python" }),
		}));
		const learn = fakeLearn({ codeSamples: async () => samples });
		const tools = createLearnTools(() => learn);
		const out = await tools.learn_code_samples!.execute("c1", { query: "upload a blob", language: "  python " });
		const results = out.details as Record<string, unknown>[];
		assert.equal(results.length, 6);
		assert.deepEqual(results[0], {
			description: `${"d".repeat(1500)}…`,
			language: "python",
			url: `${LEARN}/s0`,
			code: `${"c".repeat(3000)}…`,
		});
		assert.deepEqual(results[1], { description: "sample 1", url: `${LEARN}/s1`, code: "code 1" }, "no language key when the sample has none");
		await tools.learn_code_samples!.execute("c2", { query: "q", language: "   " });
		await tools.learn_code_samples!.execute("c3", { query: "q" });
		assert.deepEqual(
			learn.seen.map((call) => call.slice(0, 3)),
			[
				["codeSamples", "upload a blob", "python"],
				["codeSamples", "q", undefined],
				["codeSamples", "q", undefined],
			],
		);
		const empty = createLearnTools(() => fakeLearn());
		assert.equal((await empty.learn_code_samples!.execute("c4", { query: "zzz" })).details, 'learn_code_samples found nothing for "zzz".');
		const broken = createLearnTools(() =>
			fakeLearn({
				codeSamples: async () => {
					throw new Error("boom");
				},
			}),
		);
		assert.equal((await broken.learn_code_samples!.execute("c5", { query: "q" })).details, "learn_code_samples failed: boom");
	});
});

// ─── 4. the researcher ───────────────────────────────────────────────────────

describe("the researcher with Microsoft Learn", () => {
	it("researcherInstructions adds one paragraph, between the search fallback and the deliverable", () => {
		const off = researcherInstructions(false).split("\n\n");
		const on = researcherInstructions(true).split("\n\n");
		const at = on.findIndex((paragraph) => paragraph.startsWith("Microsoft documentation:"));
		assert.ok(at > 0);
		assert.deepEqual([...on.slice(0, at), ...on.slice(at + 1)], off);
		assert.ok(on[at - 1]!.startsWith("If web_search reports that search is unavailable"));
		assert.ok(on[at + 1]!.startsWith("Your FINAL assistant message"));
		assert.match(on[at]!, /call learn_search first, then learn_fetch/);
		assert.ok(!off.some((paragraph) => paragraph.includes("learn_")), "off, the prompt never names the learn tools");
	});

	it("a client adds the learn_* tools and the paragraph; the switch is read once per run", async () => {
		let resolved = 0;
		const learn = fakeLearn();
		const faux = createFauxCore({});
		faux.setResponses([
			(context) => {
				const system = context.messages.find((m) => m.role === "system");
				assert.ok(system && system.role === "system");
				const prompt = system.content as string;
				assert.ok(prompt.split("\n\n").some((paragraph) => paragraph.startsWith("Microsoft documentation:")));
				const names = system.toolsAdded?.map((tool) => tool.name) ?? [];
				for (const name of ["web_search", "web_fetch", "learn_search", "learn_fetch", "learn_code_samples"]) {
					assert.ok(names.includes(name), name);
				}
				return fauxAssistantMessage([fauxText("ok")]);
			},
		]);
		const brief = await runResearcherAgent("q", {
			engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			learnDocs: () => {
				resolved++;
				return learn;
			},
		});
		assert.equal(brief, "ok");
		assert.equal(resolved, 1);
	});

	it("without a client the researcher is as before: no learn tools, no paragraph", async () => {
		for (const learnDocs of [undefined, () => null]) {
			const faux = createFauxCore({});
			faux.setResponses([
				(context) => {
					const system = context.messages.find((m) => m.role === "system");
					assert.ok(system && system.role === "system");
					assert.ok(!(system.content as string).includes("learn_"), "no Learn paragraph");
					assert.ok(!system.toolsAdded?.some((tool) => tool.name.startsWith("learn_")), "no learn tools");
					return fauxAssistantMessage([fauxText("ok")]);
				},
			]);
			const brief = await runResearcherAgent("q", {
				engine: { model: faux.getModel(), streamFn: faux.streamSimple },
				...(learnDocs ? { learnDocs } : {}),
			});
			assert.equal(brief, "ok");
		}
	});

	// A scripted loop: it proves the tool mechanics, not a real model's choices.
	it("learn_search, then learn_fetch, then a brief citing the page", async () => {
		const url = `${LEARN}/azure/azure-functions/functions-overview`;
		const brief = `## Summary\nAzure Functions runs code on demand. [Azure Functions overview](${url})`;
		const learn = fakeLearn({
			search: async () => [{ title: "Azure Functions overview", url, content: "Run code on demand." }],
			fetch: async () => "# Azure Functions overview\n\nServerless compute.",
		});
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("learn_search", { query: "azure functions" }, { id: "ls1" })], { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "ls1");
				assert.ok(result && result.role === "toolResult");
				assert.equal(result.isError, false);
				assert.match(JSON.stringify(result.content), /functions-overview/);
				return fauxAssistantMessage([fauxToolCall("learn_fetch", { url }, { id: "lf1" })], { stopReason: "toolUse" });
			},
			(context) => {
				const result = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "lf1");
				assert.ok(result && result.role === "toolResult");
				assert.equal(result.isError, false);
				assert.match(JSON.stringify(result.content), /Serverless compute/);
				return fauxAssistantMessage([fauxText(brief)]);
			},
		]);
		const started: string[] = [];
		const out = await runResearcherAgent("What is Azure Functions?", {
			engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			learnDocs: () => learn,
			onToolStart: (name) => started.push(name),
		});
		assert.equal(out, brief);
		assert.deepEqual(started, ["learn_search", "learn_fetch"]);
		assert.deepEqual(
			learn.seen.map((call) => call.slice(0, 2)),
			[
				["search", "azure functions"],
				["fetch", url],
			],
		);
	});
});

// ─── 5. the Settings switch ──────────────────────────────────────────────────

describe("the Microsoft Learn switch in Settings", () => {
	it("the writer accepts only { enabled: boolean }", () => {
		assert.deepEqual(parseAgentSettingsBody({ learnDocs: { enabled: false } }), { ok: true, settings: { learnDocs: { enabled: false } } });
		assert.deepEqual(parseAgentSettingsBody({ learnDocs: {} }), { ok: true, settings: { learnDocs: {} } });
		assert.deepEqual(parseAgentSettingsBody({ learnDocs: false }), { ok: false, error: "learnDocs must be an object" });
		assert.deepEqual(parseAgentSettingsBody({ learnDocs: { enabled: "no" } }), {
			ok: false,
			error: "learnDocs.enabled must be a boolean",
		});
	});

	it("the reader keeps a well-formed switch and drops a broken one; Learn is on unless switched off", () => {
		const read = (learnDocs: unknown) => sanitizeUserSettings({ version: 1, agent: { learnDocs } });
		assert.deepEqual(read({ enabled: false })?.agent?.learnDocs, { enabled: false });
		assert.deepEqual(read({})?.agent?.learnDocs, {});
		assert.equal(read({ enabled: "no" })?.agent?.learnDocs, undefined);
		assert.equal(read([])?.agent?.learnDocs, undefined);
		assert.equal(learnDocsEnabled(resolveSettings(read({ enabled: false }))), false);
		assert.equal(learnDocsEnabled(resolveSettings(read({ enabled: true }))), true);
		assert.equal(learnDocsEnabled(resolveSettings(read({}))), true);
		assert.equal(learnDocsEnabled(resolveSettings(read({ enabled: "no" }))), true, "a broken switch falls back to on");
		assert.equal(learnDocsEnabled(resolveSettings(null)), true, "on by default");
	});

	it("the Agent section's row is on by default and writes its own key", () => {
		const render = (agent: AgentSettings | undefined) =>
			renderToStaticMarkup(
				<AgentSection
					agent={agent}
					models={undefined}
					graph={undefined}
					compaction={undefined}
					onSectionChange={() => {}}
					onModelsChange={() => {}}
					onCompactionChange={() => {}}
				/>,
			);
		const toggle = (html: string) => {
			const at = html.indexOf('data-testid="toggle-microsoft-learn"');
			assert.ok(at >= 0, "the Microsoft Learn toggle");
			return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
		};
		const html = render(undefined);
		// (the apostrophe in "Microsoft's" HTML-escapes — match up to it)
		assert.ok(html.includes("Lets research cite Microsoft"));
		assert.ok(toggle(html).includes('aria-checked="true"'), "absent = on");
		assert.ok(toggle(render({ learnDocs: {} })).includes('aria-checked="true"'));
		assert.ok(toggle(render({ learnDocs: { enabled: false } })).includes('aria-checked="false"'), "stored off renders off");
		assert.deepEqual(composeLearnDocs(undefined, false), { learnDocs: { enabled: false } });
		assert.deepEqual(composeLearnDocs({ graphTools: { enabled: true }, tools: { demo: false } }, true), {
			graphTools: { enabled: true },
			tools: { demo: false },
			learnDocs: { enabled: true },
		});
	});
});
