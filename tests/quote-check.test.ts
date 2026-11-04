import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findQuote, quoteFinder, sourceLocator } from "../src/core/quote-check.ts";

describe("checked quotes (M25)", () => {
	const notes = "Vim always starts in\n   Normal mode — keys are commands, not text.";

	it("finds a quote across line breaks and returns the source's own words", () => {
		const match = findQuote(notes, "vim always starts in normal mode");
		assert.ok(match);
		assert.equal(match.quote, "Vim always starts in Normal mode");
		assert.equal(notes.slice(match.start, match.end).replace(/\s+/g, " "), "Vim always starts in Normal mode");
	});

	it("forgives typography — dashes, curly quotes, ligatures, ellipses, wrapping quote marks", () => {
		assert.equal(findQuote(notes, "Normal mode - keys are commands")?.quote, "Normal mode — keys are commands");
		assert.equal(findQuote(notes, "\u2026keys are commands, not text.\"")?.quote, "keys are commands, not text");
		const pdf = "The \u201C\uFB01rst\u201D principle governs everything.";
		assert.equal(findQuote(pdf, '"first" principle governs')?.quote, "\uFB01rst\u201D principle governs");
	});

	it("drops a quote that is missing, too short, too long, or not in the text", () => {
		assert.equal(findQuote(notes, undefined), null);
		assert.equal(findQuote(notes, "Normal mode"), null, "under 12 characters is too ambiguous");
		assert.equal(findQuote(notes, "x".repeat(601)), null);
		assert.equal(findQuote(notes, "Vim always starts in Insert mode"), null, "words must match exactly");
	});

	it("normalizes the text once per finder", () => {
		const find = quoteFinder(notes);
		assert.equal(find("keys are commands")?.quote, "keys are commands");
		assert.equal(find("always starts in normal")?.quote, "always starts in Normal");
	});

	it("places a position on its PDF page", () => {
		const text = "front matter\n--- Page 1 ---\nfirst page\n\n--- Page 2 ---\nsecond page text";
		const locate = sourceLocator(text);
		assert.equal(locate.pageAt(0), undefined, "before any marker there is no page");
		assert.equal(locate.pageAt(text.indexOf("first page")), 1);
		assert.equal(locate.pageAt(text.indexOf("second page")), 2);
	});

	it("places a position in its diff hunk, and nowhere outside one", () => {
		const text = [
			"# Retry transient failures",
			"",
			"## Diff",
			"diff --git a/src/fetch.ts b/src/fetch.ts",
			"--- a/src/fetch.ts",
			"+++ b/src/fetch.ts",
			"@@ -1,3 +1,6 @@ export async function get(url) {",
			" export async function get(url) {",
			"-  return fetch(url);",
			"+  for (let attempt = 0; attempt < 3; attempt++) {",
			"+    const res = await fetch(url);",
			"+    if (res.status < 500) return res;",
			"+  }",
			" }",
			"diff --git a/README.md b/README.md",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");
		const locate = sourceLocator(text);
		const hunk = locate.hunkAt(text.indexOf("if (res.status < 500)"));
		assert.ok(hunk);
		assert.equal(hunk.file, "src/fetch.ts");
		assert.equal(hunk.header, "@@ -1,3 +1,6 @@ export async function get(url) {");
		assert.ok(hunk.text.startsWith(" export async function get(url) {"));
		assert.ok(hunk.text.endsWith(" }"), "the excerpt stops at the next file");
		assert.equal(locate.hunkAt(text.indexOf("Retry transient")), undefined, "the description has no hunk");
		assert.equal(locate.hunkAt(text.indexOf("@@ -1,3")), undefined, "the @@ line itself is not a hunk line");
		assert.equal(locate.hunkAt(text.indexOf("+new"))?.file, "README.md");
	});

	it("keeps a hunk excerpt short around the quoted line", () => {
		const body = Array.from({ length: 100 }, (_, i) => `+line ${i}`);
		const text = ["diff --git a/a.ts b/a.ts", "@@ -0,0 +1,100 @@", ...body].join("\n");
		const hunk = sourceLocator(text).hunkAt(text.indexOf("+line 50"));
		assert.ok(hunk);
		const lines = hunk.text.split("\n");
		assert.equal(lines.length, 25, "12 lines each side of the quoted line");
		assert.equal(lines[12], "+line 50");
	});
});
