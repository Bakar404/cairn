/**
 * Checked quotes (M25). An extractor reading an imported document may attach
 * a short verbatim quote to each proposition. The quote is a claim about the
 * source, so it's checked against the text the extractor actually read:
 * a match keeps the source's own words (never the model's copy), an
 * unmatched quote is dropped silently — extraction never fails over one.
 *
 * Matching is forgiving only where documents are noisy: Unicode
 * compatibility forms (PDF ligatures), case, runs of whitespace, curly
 * quotes, dashes, the ellipsis, and soft hyphens. Words must match exactly.
 *
 * The locator turns a match position into a place a learner can check:
 * the PDF page (from the importer's "--- Page N ---" markers) or the diff
 * hunk (from "diff --git" / "@@" headers in a code-change import).
 *
 * Pure and browser-safe.
 */
import type { SourceHunk } from "./contracts/graph.ts";
import { diffHeaderPath } from "./code-change.ts";

/** A quote shorter than this (after normalization) is too ambiguous to check. */
export const MIN_QUOTE_CHARS = 12;
/** A quote longer than this isn't a short quote — dropped, not truncated. */
export const MAX_QUOTE_CHARS = 600;
/** Lines of hunk context kept on each side of the quoted line. */
const HUNK_CONTEXT_LINES = 12;
/** A hunk excerpt never grows past this, whatever the line lengths. */
const HUNK_MAX_CHARS = 2400;

export interface CheckedQuote {
	/** The matched span as it appears in the source, whitespace collapsed. */
	quote: string;
	/** Offsets of the span in the searched text (end exclusive). */
	start: number;
	end: number;
}

interface Normalized {
	text: string;
	/** text index → source index of the code point it came from. */
	map: number[];
}

// NFKD (not NFKC) because folding runs per code point: decomposing is the
// form that agrees whether the source spells "é" precomposed or combining.
function foldCodePoint(raw: string): string {
	return raw
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "");
}

/** Normalize while remembering where every output char came from, so a
 *  match in normalized space maps back to an exact source span. Whitespace
 *  runs collapse to one space; leading/trailing whitespace drops. */
function normalize(source: string): Normalized {
	let text = "";
	const map: number[] = [];
	let spaceAt = -1;
	for (let i = 0; i < source.length; ) {
		const cp = source.codePointAt(i)!;
		const width = cp > 0xffff ? 2 : 1;
		for (const ch of foldCodePoint(source.slice(i, i + width))) {
			if (/\s/u.test(ch)) {
				if (text.length > 0 && spaceAt < 0) spaceAt = i;
				continue;
			}
			if (spaceAt >= 0) {
				text += " ";
				map.push(spaceAt);
				spaceAt = -1;
			}
			text += ch;
			map.push(i);
		}
		i += width;
	}
	return { text, map };
}

/** Quote marks and ellipses a model wraps around a quote aren't part of it;
 *  neither is the sentence's closing punctuation. */
function trimQuote(normalized: string): string {
	return normalized.replace(/^(?:["'\s]|\.\.\.)+/, "").replace(/(?:[\s.,;:!?"']|\.\.\.)+$/, "");
}

/**
 * A checker over one text: normalizes it once, then finds each quote in it.
 * Returns the source's own span (whitespace collapsed) or null when the
 * quote is missing, too short, too long, or absent from the text.
 */
export function quoteFinder(text: string): (quote: string | undefined) => CheckedQuote | null {
	let hay: Normalized | undefined;
	return (quote) => {
		if (typeof quote !== "string") return null;
		const needle = trimQuote(normalize(quote).text);
		if (needle.length < MIN_QUOTE_CHARS || needle.length > MAX_QUOTE_CHARS) return null;
		hay ??= normalize(text);
		const at = hay.text.indexOf(needle);
		if (at < 0) return null;
		const start = hay.map[at]!;
		const last = hay.map[at + needle.length - 1]!;
		const end = last + (text.codePointAt(last)! > 0xffff ? 2 : 1);
		return { quote: text.slice(start, end).replace(/\s+/g, " ").trim(), start, end };
	};
}

/** One-off form of quoteFinder. */
export function findQuote(text: string, quote: string | undefined): CheckedQuote | null {
	return quoteFinder(text)(quote);
}

export interface SourceLocator {
	/** The PDF page holding `pos` (the last page marker at or before it). */
	pageAt(pos: number): number | undefined;
	/** The diff hunk holding `pos`, as a short excerpt around that line. */
	hunkAt(pos: number): SourceHunk | undefined;
}

interface Mark<T> {
	at: number;
	value: T;
}

/** The last mark at or before `pos` (marks sorted by `at`). */
function lastMarkAt<T>(marks: ReadonlyArray<Mark<T>>, pos: number): Mark<T> | undefined {
	let lo = 0;
	let hi = marks.length - 1;
	let found: Mark<T> | undefined;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (marks[mid]!.at <= pos) {
			found = marks[mid];
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found;
}

/** Lines of `text` with their start offsets (CR kept out of the line). */
function linesOf(text: string): Array<{ at: number; line: string }> {
	const out: Array<{ at: number; line: string }> = [];
	let at = 0;
	for (const raw of text.split("\n")) {
		out.push({ at, line: raw.endsWith("\r") ? raw.slice(0, -1) : raw });
		at += raw.length + 1;
	}
	return out;
}

/** Where things are in one imported source's full text. Indexes build
 *  lazily, once per source, then answer each quote by binary search. */
export function sourceLocator(text: string): SourceLocator {
	let lines: Array<{ at: number; line: string }> | undefined;
	let pages: Mark<number>[] | undefined;
	let files: Mark<string>[] | undefined;
	let hunks: Mark<number>[] | undefined; // value = line index of the @@ header

	const allLines = () => (lines ??= linesOf(text));
	const lineIndexAt = (pos: number): number => {
		const ls = allLines();
		let lo = 0;
		let hi = ls.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (ls[mid]!.at <= pos) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};

	return {
		pageAt(pos) {
			if (!pages) {
				pages = [];
				for (const { at, line } of allLines()) {
					const m = /^--- Page (\d+) ---$/.exec(line);
					if (m) pages.push({ at, value: Number(m[1]) });
				}
			}
			const page = lastMarkAt(pages, pos)?.value;
			return page !== undefined && Number.isInteger(page) && page > 0 ? page : undefined;
		},
		hunkAt(pos) {
			if (!files || !hunks) {
				files = [];
				hunks = [];
				for (const [index, { at, line }] of allLines().entries()) {
					const file = diffHeaderPath(line);
					if (file !== undefined) files.push({ at, value: file });
					else if (line.startsWith("@@")) hunks.push({ at, value: index });
				}
			}
			const file = lastMarkAt(files, pos);
			const hunk = lastMarkAt(hunks, pos);
			// The quote must sit inside a hunk of the file it follows — the
			// commit message, the PR description and file headers have none.
			if (!file || !hunk || hunk.at < file.at) return undefined;
			const ls = allLines();
			const headerIndex = hunk.value;
			const quotedIndex = lineIndexAt(pos);
			if (quotedIndex === headerIndex) return undefined; // the quote is the @@ line itself
			let endIndex = headerIndex + 1;
			while (endIndex < ls.length) {
				const line = ls[endIndex]!.line;
				if (line.startsWith("@@") || line.startsWith("diff --git ")) break;
				endIndex++;
			}
			const from = Math.max(headerIndex + 1, quotedIndex - HUNK_CONTEXT_LINES);
			const to = Math.min(endIndex, quotedIndex + HUNK_CONTEXT_LINES + 1);
			let excerpt = ls.slice(from, to).map((l) => l.line).join("\n").replace(/\s+$/, "");
			if (excerpt.length > HUNK_MAX_CHARS) excerpt = `${excerpt.slice(0, HUNK_MAX_CHARS)}\n…`;
			return { file: file.value, header: ls[headerIndex]!.line, text: excerpt };
		},
	};
}
