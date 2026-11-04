/**
 * THE GRAPH-CONTEXT MARKER (owner, 2026-10-04 late): a session started
 * with map picks gets its context as a SEPARATE custom message BEFORE
 * the learner's first user message — the picked propositions plus the
 * reasoning chains among them (formatChainLine lines), no more seed
 * text glued into the opening prompt. The model reads the marker's
 * content (toLlmMessages flattens it to a user message like every
 * marker); `details` feeds the transcript's collapsible
 * GraphContextCard (render-practice pins live in the render suite).
 *
 * The route pin drives POST /api/chats under an isolated LH_DATA_DIR
 * (the birth-stamp discipline): picks ride the CREATION, the marker
 * lands as message[0], and the chains derive from the live graph
 * snapshot.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-graph-context-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { newGraphContextMessage } = await import("../src/core/native-messages.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
import type { LhMessage } from "../src/core/native-messages.ts";
import type { GraphNode, NotesSource, ProvenancePoint } from "../src/core/contracts.ts";
const { graphContextEvidence, MAX_CONTEXT_EVIDENCE, MAX_CONTEXT_HUNK_CHARS } = await import("../src/core/graph.ts");
const { projectView } = await import("../src/core/view.ts");
const { POST } = await import("../app/api/chats/route.ts");
const { initialPromptOwed } = await import("../components/chat.tsx");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const PICKS = [
	{ id: "n_a", name: "Modus ponens", statement: "If P implies Q and P holds, Q holds." },
	{ id: "n_b", name: "Soundness", statement: "A valid argument from true premises has a true conclusion." },
];

// ── the pure marker ─────────────────────────────────────────────────────────

describe("newGraphContextMessage", () => {
	it("frames the context for the model: propositions listed, chains appended", () => {
		const m = newGraphContextMessage(PICKS, ["Modus ponens → Soundness"]);
		assert.equal(m.customType, "graph-context");
		assert.match(m.content, /\[Session context\] — picked from the learner's knowledge map/);
		// IDS FIRST (owner round 9): every pick carries its id — the problem
		// tool's target field references these; names alone no longer.
		assert.ok(m.content.includes(`- [${PICKS[0]!.id}] Modus ponens: If P implies Q and P holds, Q holds.`));
		assert.ok(m.content.includes("Reasoning chains among them"));
		assert.ok(m.content.includes("- Modus ponens → Soundness"));
		// the UI payload is the structured pick, not the flattened text
		assert.deepEqual(m.details, { propositions: PICKS, chains: ["Modus ponens → Soundness"] });
	});

	it("no chains: the chains section stays out entirely", () => {
		const m = newGraphContextMessage(PICKS, []);
		assert.ok(!m.content.includes("Reasoning chains"));
		assert.deepEqual(m.details, { propositions: PICKS, chains: [] });
	});

	it("toLlmMessages flattens it to a user message (the model's face)", () => {
		const m = newGraphContextMessage(PICKS, ["Modus ponens → Soundness"]);
		const wire = toLlmMessages([m as unknown as LhMessage] as never);
		assert.equal(wire.length, 1);
		assert.equal(wire[0]!.role, "user");
		assert.ok(String((wire[0]!.content as { text?: string }[])[0]!.text).includes("[Session context]"));
	});

	it("projectView: a user-side data part — never a text bubble", () => {
		const m = newGraphContextMessage(PICKS, []);
		const view = projectView([m as unknown as LhMessage] as never);
		assert.equal(view.length, 1);
		assert.equal(view[0]!.role, "user");
		const part = view[0]!.parts[0] as { type: string; data: unknown };
		assert.equal(part.type, "data-graph-context");
		assert.deepEqual(part.data, m.details);
	});
});

// ── the first-send gate (the dead first turn, owner report 2026-10-04) ──────

describe("initialPromptOwed", () => {
	it("a marker-only record still owes the prompt — scaffolding is not conversation", () => {
		const marker = newGraphContextMessage(PICKS, []);
		assert.equal(initialPromptOwed([marker as never], "drill me on logic"), true);
	});

	it("once a user or assistant message exists, the prompt is spent", () => {
		const marker = newGraphContextMessage(PICKS, []);
		const user = { role: "user" } as never;
		assert.equal(initialPromptOwed([marker as never, user], "drill me"), false);
		assert.equal(initialPromptOwed([{ role: "assistant" } as never], "drill me"), false);
	});

	it("no prompt → nothing owed (the empty-draft case)", () => {
		assert.equal(initialPromptOwed([], undefined), false);
	});
});

// ── the route (picks ride the creation) ─────────────────────────────────────

describe("POST /api/chats — graphContext becomes message[0]", () => {
	it("writes the marker before any user message; chains derive from the live graph", async () => {
		// Seed the map: two picked nodes joined by one chain.
		const node = (id: string, name: string, statement: string) => ({
			id, name, statement, aliases: [] as string[], createdAt: "2026-10-01T00:00:00.000Z", provenance: [],
		});
		graphStore.appendNode(node("n_a", "Modus ponens", "If P implies Q and P holds, Q holds."));
		graphStore.appendNode(node("n_b", "Soundness", "A valid argument from true premises has a true conclusion."));
		graphStore.appendChain({
			id: "arg_1", premises: ["n_a"], conclusion: "n_b",
			provenance: [], createdAt: "2026-10-01T00:00:00.000Z",
		});

		const res = await POST(new Request("http://test/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "drill me on logic",
				kind: "practice",
				graphContext: { propositions: PICKS },
			}),
		}));
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };

		const record = chatStore.getChat(id)!;
		assert.equal(record.messages.length, 1, "the marker is message[0], alone until the first turn");
		const m = record.messages[0] as { role: string; customType: string; content: string };
		assert.equal(m.role, "custom");
		assert.equal(m.customType, "graph-context");
		assert.ok(m.content.includes("- [n_a] Modus ponens: If P implies Q and P holds, Q holds."));
		// the chain AMONG the picks rides the marker (formatChainLine shape — names)
		assert.ok(m.content.includes("- Modus ponens → Soundness"));
	});

	it("no picks (or malformed) → no marker, an empty record as before", async () => {
		for (const body of [{ title: "t" }, { title: "t", graphContext: { propositions: "junk" } }]) {
			const res = await POST(new Request("http://test/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}));
			const { id } = (await res.json()) as { id: string };
			assert.equal(chatStore.getChat(id)!.messages.length, 0);
		}
	});
});

// ── source evidence (M22): a pick's checked quote, and its diff ─────────────

describe("source evidence (M22)", () => {
	const AT = "2026-10-01T00:00:00.000Z";
	const hunk = (text: string) => ({ file: "src/fetch.ts", header: "@@ -1,2 +1,3 @@", text });
	const node = (id: string, provenance: ProvenancePoint[]): GraphNode => ({
		id, name: id, statement: `${id}.`, aliases: [], createdAt: AT, provenance,
	});
	const SOURCES: NotesSource[] = [
		{ id: "src_pdf", filePath: "notes/logic.pdf", importedAt: AT, kind: "pdf" },
		{ id: "src_pr", filePath: "github.com/o/r/pull/12", importedAt: AT, kind: "change" },
	];

	it("one quote per pick, the one beside a diff first; none for chat-born or orphaned points", () => {
		const nodes = [
			node("n1", [
				{ chatId: "chat_1", messageId: "m1" },
				{ chatId: "src_pdf", messageId: "", quote: "Q follows from P.", page: 4 },
				{ chatId: "src_pr", messageId: "", quote: "retry on 5xx", hunk: hunk("+retry()") },
			]),
			node("n2", [{ chatId: "src_gone", messageId: "", quote: "orphaned" }]),
			node("n3", [{ chatId: "chat_1", messageId: "m2" }]),
			node("n4", [{ chatId: "src_pdf", messageId: "", quote: "Validity is form.", page: 2 }]),
		];
		assert.deepEqual(graphContextEvidence(nodes, SOURCES, ["n1", "n2", "n3", "n4", "n1", "n_missing"]), [
			{ id: "n1", source: "github.com/o/r/pull/12", quote: "retry on 5xx", hunk: hunk("+retry()") },
			{ id: "n4", source: "notes/logic.pdf", quote: "Validity is form.", page: 2 },
		]);
	});

	it("caps the picks with evidence; past the diff budget a pick keeps its quote, not its hunk", () => {
		const half = "+".repeat(MAX_CONTEXT_HUNK_CHARS / 2 - 20);
		const nodes = Array.from({ length: MAX_CONTEXT_EVIDENCE + 2 }, (_, i) =>
			node(`n${i}`, [{ chatId: "src_pr", messageId: "", quote: `q${i}`, hunk: hunk(half) }]),
		);
		const evidence = graphContextEvidence(nodes, SOURCES, nodes.map((n) => n.id));
		assert.equal(evidence.length, MAX_CONTEXT_EVIDENCE);
		assert.deepEqual(evidence.map((e) => e.hunk !== undefined), evidence.map((_, i) => i < 2));
		assert.equal(evidence[2]!.quote, "q2");
	});

	it("the marker quotes each source and fences each hunk past the backticks inside it", () => {
		const evidence = [
			{ id: "n_a", source: "notes/logic.pdf", quote: "Q follows from P.", page: 4 },
			{ id: "n_b", source: "github.com/o/r/pull/12", quote: "retry on 5xx", hunk: hunk("+const s = ```x```;") },
		];
		const m = newGraphContextMessage(PICKS, [], evidence);
		assert.ok(m.content.endsWith(
			"Source evidence (each imported source's own words for a proposition, checked against the source):\n" +
				'- [n_a] notes/logic.pdf, p. 4: "Q follows from P."\n' +
				'- [n_b] github.com/o/r/pull/12: "retry on 5xx"\n' +
				"  The diff in src/fetch.ts:\n````diff\n@@ -1,2 +1,3 @@\n+const s = ```x```;\n````",
		));
		assert.deepEqual(m.details, { propositions: PICKS, chains: [], evidence });
		assert.ok(!newGraphContextMessage(PICKS, []).content.includes("Source evidence"));
	});

	it("POST /api/chats: a pick imported from a code change brings its quote and diff", async () => {
		graphStore.upsertSource(SOURCES[1]!);
		graphStore.appendNode(node("n_retry", [
			{ chatId: "src_pr", messageId: "", quote: "retry on 5xx", hunk: hunk("+  if (res.status >= 500) return retry(url);") },
		]));
		const res = await POST(new Request("http://test/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "why retry",
				graphContext: { propositions: [{ id: "n_retry", name: "Retry", statement: "Retry server errors." }] },
			}),
		}));
		const { id } = (await res.json()) as { id: string };
		const m = chatStore.getChat(id)!.messages[0] as { content: string; details: { evidence?: unknown[] } };
		assert.ok(m.content.includes(
			'- [n_retry] github.com/o/r/pull/12: "retry on 5xx"\n  The diff in src/fetch.ts:\n```diff\n@@ -1,2 +1,3 @@\n+  if (res.status',
		));
		assert.equal(m.details.evidence?.length, 1);
	});
});
