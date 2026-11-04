import { parseLearningGoal, type LearningGoal } from "./learning-goals.ts";

/**
 * MICROSOFT LEARN (M21): the port the researcher reads Microsoft's official
 * documentation through — the Microsoft Learn MCP server, public and
 * sign-in free — plus the pure parsers for its answers and for a
 * certification's study guide. The HTTP adapter lives in
 * src/server/learn-docs.ts; the researcher's tools in
 * src/agent/tools/learn.ts.
 */

export const LEARN_MCP_URL = "https://learn.microsoft.com/api/mcp";
export const LEARN_SEARCH_TOOL = "microsoft_docs_search";
export const LEARN_FETCH_TOOL = "microsoft_docs_fetch";
export const LEARN_CODE_SAMPLES_TOOL = "microsoft_code_sample_search";

/** One documentation excerpt a search found. */
export interface LearnSearchHit {
	title: string;
	url: string;
	/** The excerpt's text (a chunk of the page, not the whole page). */
	content: string;
}

/** One official code sample. */
export interface LearnCodeSample {
	description: string;
	code: string;
	url: string;
	language?: string;
}

export interface LearnDocsClient {
	search(query: string, signal?: AbortSignal): Promise<LearnSearchHit[]>;
	/** A learn.microsoft.com page as markdown. */
	fetch(url: string, signal?: AbortSignal): Promise<string>;
	codeSamples(query: string, language?: string, signal?: AbortSignal): Promise<LearnCodeSample[]>;
}

/** An https page on learn.microsoft.com — the only pages the fetch tool reads. */
export function isLearnUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" && parsed.hostname === "learn.microsoft.com";
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** A tool answer's JSON entries: a bare array, or {results: [...]}. */
function jsonEntries(answer: string, what: string): unknown[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(answer);
	} catch {
		throw new Error(`${what} sent an answer that isn't JSON.`);
	}
	if (Array.isArray(parsed)) return parsed;
	if (isRecord(parsed) && Array.isArray(parsed.results)) return parsed.results;
	throw new Error(`${what} sent an answer in a shape Cairn doesn't know.`);
}

/** microsoft_docs_search's answer: {"results": [{title, content, contentUrl}]}. */
export function parseLearnSearch(answer: string): LearnSearchHit[] {
	const hits: LearnSearchHit[] = [];
	for (const entry of jsonEntries(answer, "Microsoft Learn search")) {
		if (!isRecord(entry)) continue;
		const url = text(entry.contentUrl) || text(entry.url);
		const title = text(entry.title);
		if (url && title) hits.push({ title, url, content: text(entry.content) });
	}
	return hits;
}

/** microsoft_code_sample_search's answer: [{description, codeSnippet, link, language}]. */
export function parseLearnCodeSamples(answer: string): LearnCodeSample[] {
	const samples: LearnCodeSample[] = [];
	for (const entry of jsonEntries(answer, "Microsoft Learn code samples")) {
		if (!isRecord(entry)) continue;
		const code = text(entry.codeSnippet) || text(entry.code);
		const url = text(entry.link) || text(entry.url);
		if (!code || !url) continue;
		const language = text(entry.language);
		samples.push({ description: text(entry.description), code, url, ...(language ? { language } : {}) });
	}
	return samples;
}

// ─── Certification study guides ──────────────────────────────────────────

/** Certifications the Goals picker suggests (each checked live as current,
 *  2026-11). Any other exam code works too. */
export const CERTIFICATION_SUGGESTIONS: readonly { code: string; title: string }[] = [
	{ code: "az-900", title: "Azure Fundamentals" },
	{ code: "ai-901", title: "Azure AI Fundamentals" },
	{ code: "az-104", title: "Azure Administrator" },
	{ code: "gh-300", title: "GitHub Copilot" },
	{ code: "dp-900", title: "Azure Data Fundamentals" },
	{ code: "sc-900", title: "Security, Compliance, and Identity Fundamentals" },
	{ code: "pl-300", title: "Power BI Data Analyst" },
];

/** "AZ-104", "az104", "Exam AZ 104" → "az-104"; null when it isn't an exam code. */
export function normalizeExamCode(input: string): string | null {
	const match = /^(?:exam\s+)?([a-z]{2,3})[\s-]?(\d{3})$/i.exec(input.trim());
	return match ? `${match[1]!.toLowerCase()}-${match[2]}` : null;
}

/** The study guide page for a normalized exam code. */
export function studyGuideUrl(code: string): string {
	return `https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/${encodeURIComponent(code)}`;
}

/** A domain heading's weight: "(20–25%)", "(20-25%)", "(15%)". */
const WEIGHT = /\(\s*(\d{1,3}(?:\s*[–—-]\s*\d{1,3})?)\s*%\s*\)\s*$/;
/** Where a guide's skills begin: "## Skills measured as of …", or "## Domains" on some guides (GH-900). */
const SKILLS_START = /^#{1,2}[ \t]+(?:skills measured|domains)\b/im;
/** Top-level headings that close the skills: the previous version's skills, the study resources, the change log. */
const SKILLS_END = /^(?:skills measured|domains|(?:study )?resources|change ?log|useful links|next steps)\b/i;
/** Headings inside the skills section that aren't domains ("Skills at a glance as of January 2026" too). */
const NOT_A_DOMAIN = /^(?:audience profile|skills at a glance)\b/i;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.+?)[ \t]*$/;

/** Markdown inline syntax off: links keep their text, emphasis and code marks go. */
function plain(markdown: string): string {
	return markdown
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|`)/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The guide's retirement notice, from the text above the skills. Live pages
 * put it under "## Purpose of this document" after a bare "Warning" label;
 * a "> [!IMPORTANT]" callout works too. Headings and the useful-links table
 * are skipped, and the trailing "Learn more" link goes. "" when there's none.
 */
function retirementNote(intro: string): string {
	for (const raw of intro.split("\n")) {
		const line = raw.replace(/^[\s>]*(?:\[![a-z]+\][\s>]*)?/i, "");
		if (!line || line.startsWith("#") || line.startsWith("|")) continue;
		if (!/\bretir(?:e|ed|es|ing)\b/i.test(line) || !/\b(?:exam|certification)\b/i.test(line)) continue;
		return plain(line).replace(/\s*Learn more\.?$/i, "");
	}
	return "";
}

/**
 * A study guide (microsoft_docs_fetch's markdown) as a certification goal:
 * the title from "# Study guide for …", the areas from the FIRST skills
 * section ("## Skills measured …", or "## Domains"; a guide may also keep
 * the previous version's skills below it). Domains are "### Domain (weight)"
 * — a weighted "#" or "##" heading counts too — groups are "#### Group", and
 * skills are "- bullets". Live guides aren't all tidy: GH-900 writes some
 * groups as "##" headings, so a top-level heading with bullets under it,
 * inside a domain, is a group; any other top-level heading (the study
 * resources, the change log) closes the skills. The audience profile and
 * the at-a-glance list are skipped. A retirement notice above the skills
 * becomes the goal's note. Null when the page isn't a study guide or lists
 * no skills.
 */
export function parseStudyGuide(markdown: string, source: string): LearningGoal | null {
	const page = markdown.replace(/\r\n?/g, "\n");
	const titleMatch = /^#[ \t]+Study guide for[ \t]+(.+?)[ \t]*$/im.exec(page);
	if (!titleMatch) return null;
	const skillsAt = page.search(SKILLS_START);
	if (skillsAt < 0) return null;
	const note = retirementNote(page.slice(0, skillsAt));
	const bodyAt = page.indexOf("\n", skillsAt);
	if (bodyAt < 0) return null;
	const lines = page.slice(bodyAt + 1).split("\n");
	const bulletsFollow = (from: number): boolean => {
		const next = lines.slice(from).find((line) => line.trim());
		return next !== undefined && BULLET.test(next);
	};

	const areas: { name: string; weight?: string; groups: { name: string; items: string[] }[] }[] = [];
	let area: (typeof areas)[number] | null = null;
	let group: { name: string; items: string[] } | null = null;
	for (const [index, line] of lines.entries()) {
		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1]!.length;
			const text = plain(heading[2]!);
			group = null;
			const weight = level <= 3 ? WEIGHT.exec(text) : null;
			if (weight) {
				area = { name: text.slice(0, weight.index).trim(), weight: `${weight[1]!.replace(/\s*[–—-]\s*/, "–")}%`, groups: [] };
				areas.push(area);
			} else if (level <= 2) {
				if (SKILLS_END.test(text) || !area || !bulletsFollow(index + 1)) break;
				group = { name: text, items: [] };
				area.groups.push(group);
			} else if (level === 3) {
				area = NOT_A_DOMAIN.test(text) ? null : { name: text, groups: [] };
				if (area) areas.push(area);
			} else if (area) {
				group = { name: text, items: [] };
				area.groups.push(group);
			}
			continue;
		}
		const bullet = BULLET.exec(line);
		if (bullet && area) {
			if (!group) {
				group = { name: "", items: [] };
				area.groups.push(group);
			}
			const item = plain(bullet[1]!);
			if (item) group.items.push(item);
		}
	}
	const withSkills = areas
		.map((a) => ({ ...a, groups: a.groups.filter((g) => g.items.length > 0) }))
		.filter((a) => a.groups.length > 0);
	if (withSkills.length === 0) return null;
	return parseLearningGoal({
		kind: "certification",
		title: plain(titleMatch[1]!),
		source,
		...(note ? { note } : {}),
		areas: withSkills,
	});
}
