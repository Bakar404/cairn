/**
 * Work IQ (M10): Microsoft 365 Copilot's MCP server, asked once per session
 * by the prober which parts of a subject the learner's own work already
 * touches. The answer is a STARTING GUESS for where to probe first — never
 * evidence of what the learner knows. Opt-in and off by default (Settings ›
 * Agent › Tools). Browser-safe: constants, the question template, the
 * deterministic answer parser, and the client port; the stdio adapter
 * lives in src/server/workiq.ts.
 */

/** The pinned Work IQ CLI — bump it deliberately, never float. */
export const WORKIQ_PACKAGE = "@microsoft/workiq@1.0.1";

/** The one Work IQ tool Cairn calls (read-only; no write tool, ever). */
export const WORKIQ_ASK_TOOL = "ask";

/** Where the Work IQ license and docs live. */
export const WORKIQ_EULA_URL = "https://github.com/microsoft/work-iq";

export interface WorkIqSetupStep {
	title: string;
	/** A command the learner runs once in a terminal. */
	command?: string;
	note?: string;
}

/** The one-time setup the learner does themselves — Cairn never accepts
 *  the license or signs in on their behalf. */
export const WORKIQ_SETUP_STEPS: readonly WorkIqSetupStep[] = [
	{
		title: "Accept the Work IQ license",
		command: `npx -y ${WORKIQ_PACKAGE} accept-eula`,
	},
	{
		title: "Sign in with your work account",
		command: `npx -y ${WORKIQ_PACKAGE} auth login`,
	},
	{
		title: "Get admin consent",
		note: "Your Microsoft 365 admin may need to approve Work IQ for your organization once. Until then, sign-in works but questions fail.",
	},
];

/** The Settings test question: short, so the test costs as little as possible. */
export const WORKIQ_TEST_QUESTION = "Reply with the single word OK.";

/** At most this many topics reach the prober. */
export const WORK_CONTEXT_MAX_TOPICS = 12;
/** Longer lines are prose, not topics — dropped. */
export const WORK_CONTEXT_MAX_LINE = 120;
const WORK_TOPIC_MAX_CHARS = 200;

/** The subject as the prober named it, made safe to put in a question:
 *  no double quotes or backticks, one line, at most 200 characters. */
export function cleanWorkTopic(raw: string): string {
	return raw
		.replace(/["“”„`]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, WORK_TOPIC_MAX_CHARS)
		.trim();
}

/** The one question Work IQ is asked for a subject. */
export function workContextQuestion(topic: string): string {
	return [
		`I'm about to learn about: ${topic}.`,
		"From my own work in Microsoft 365 (my email, meetings, chats and documents), list the parts of this subject my work already touches.",
		`Answer with at most ${WORK_CONTEXT_MAX_TOPICS} lines, one per topic, each as "topic — kind of evidence" (for example "Kubernetes deployments — design docs I wrote").`,
		"Don't quote any content, and don't name people or customers.",
		'If my work doesn\'t touch this subject, answer only "none".',
	].join("\n");
}

const BULLET_RE = /^\s*(?:[-*•‣◦+]|\d{1,2}[.)])\s+/;
/** "topic — evidence": an em or en dash, or a hyphen with spaces around it
 *  (so "real-time" isn't one). */
const DASH_LINE_RE = /\S\s*[—–]\s*\S|\S\s+-\s+\S/;
const URL_RE = /https?:\/\/|\bwww\./i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const NONE_RE = /^(?:none|n\/a)(?:[\s.,;:!—–-]|$)/i;

/** Markdown and citation noise off one line, links kept as their text. */
function cleanTopicLine(text: string): string {
	return text
		.replace(/<sup>[\s\S]*?<\/sup>/gi, "")
		.replace(/【[^】]*】/g, "")
		.replace(/\[\^?\d+\](?:\([^)]*\))?/g, "")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]*>/g, "")
		.replace(/[<>]/g, "")
		.replace(/\*\*|__|~~|`/g, "")
		.replace(/\*/g, "")
		.replace(/^#{1,6}\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Work IQ's answer → at most 12 short topic lines (deterministic; the full
 * answer is never saved). Only list lines count — bullet or number markers,
 * or "topic — evidence" lines. Lead-ins ending in ":", "none", lines over
 * 120 characters, lines carrying a URL or an email address, table rows,
 * lines with no letter or digit, and duplicates are dropped.
 */
export function parseWorkContextTopics(answer: string): string[] {
	const topics: string[] = [];
	const seen = new Set<string>();
	for (const raw of answer.split(/\r?\n/)) {
		if (topics.length >= WORK_CONTEXT_MAX_TOPICS) break;
		if (raw.trimStart().startsWith("|")) continue;
		const bullet = BULLET_RE.test(raw);
		if (!bullet && !DASH_LINE_RE.test(raw)) continue;
		const line = cleanTopicLine(bullet ? raw.replace(BULLET_RE, "") : raw);
		if (!/[\p{L}\p{N}]/u.test(line) || line.endsWith(":") || NONE_RE.test(line)) continue;
		if (line.length > WORK_CONTEXT_MAX_LINE) continue;
		if (URL_RE.test(line) || EMAIL_RE.test(line)) continue;
		const key = line.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		topics.push(line);
	}
	return topics;
}

// ─── The client port ───────────────────────────────────────────────────────

export interface WorkIqAskRequest {
	question: string;
	abortSignal?: AbortSignal;
}

/** Asks Work IQ one question and resolves with its answer text. Rejects
 *  with a plain-worded error (or an AbortError when aborted). */
export interface WorkIqClient {
	ask(request: WorkIqAskRequest): Promise<string>;
}

/** The Settings "Test connection" outcome. */
export type WorkIqTestResult = { ok: true } | { ok: false; error: string };
