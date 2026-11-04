/**
 * LEARNING GOALS (M21): what a learner sets out to learn before a session
 * starts — a Microsoft certification's skills measured, or the stack a
 * repository is built with. A goal is an outline: areas (a certification's
 * domains carry the exam's weights), the groups inside them, and the items
 * in each group. It rides a new session as a goal-context marker
 * (native-messages.ts), so the tutor measures and plans across all of it.
 *
 * Pure and browser-safe. The study-guide parser lives in learn-docs.ts and
 * the repository scan in repo-goals.ts; both hand their result to
 * parseLearningGoal, which also guards POST /api/chats.
 */

export type LearningGoalKind = "certification" | "repo";

export interface LearningGoalGroup {
	/** "" for items listed directly under an area. */
	name: string;
	items: string[];
}

export interface LearningGoalArea {
	name: string;
	/** A certification domain's share of the exam, e.g. "20–25%". */
	weight?: string;
	groups: LearningGoalGroup[];
}

export interface LearningGoal {
	kind: LearningGoalKind;
	/** "Exam AZ-104: Microsoft Azure Administrator", "The stack of cairn". */
	title: string;
	/** Where the outline came from: a study guide URL, or a repository's folder path. */
	source: string;
	/** A caveat shown with the goal, e.g. a retirement notice. */
	note?: string;
	areas: LearningGoalArea[];
}

/** Every goal is clamped to these: they keep the marker a bounded size. */
export const GOAL_LIMITS = { areas: 12, groups: 15, items: 15, text: 300, outline: 12_000 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One line of text: whitespace collapsed, capped, "" when absent. */
function cleanText(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > GOAL_LIMITS.text ? `${text.slice(0, GOAL_LIMITS.text - 1)}…` : text;
}

/**
 * A goal from untrusted input, or null when it isn't one: the kind, title,
 * source and at least one named area are required. Everything else is
 * cleaned and clamped to GOAL_LIMITS; malformed groups and items drop out.
 */
export function parseLearningGoal(raw: unknown): LearningGoal | null {
	if (!isRecord(raw)) return null;
	const kind = raw.kind;
	if (kind !== "certification" && kind !== "repo") return null;
	const title = cleanText(raw.title);
	const source = cleanText(raw.source);
	if (!title || !source || !Array.isArray(raw.areas)) return null;
	const areas: LearningGoalArea[] = [];
	for (const rawArea of raw.areas) {
		if (areas.length >= GOAL_LIMITS.areas) break;
		if (!isRecord(rawArea)) continue;
		const name = cleanText(rawArea.name);
		if (!name) continue;
		const groups: LearningGoalGroup[] = [];
		for (const rawGroup of Array.isArray(rawArea.groups) ? rawArea.groups : []) {
			if (groups.length >= GOAL_LIMITS.groups) break;
			if (!isRecord(rawGroup) || !Array.isArray(rawGroup.items)) continue;
			const items = rawGroup.items.map(cleanText).filter(Boolean).slice(0, GOAL_LIMITS.items);
			if (items.length > 0) groups.push({ name: cleanText(rawGroup.name), items });
		}
		const weight = cleanText(rawArea.weight);
		areas.push({ name, ...(weight ? { weight } : {}), groups });
	}
	if (areas.length === 0) return null;
	const note = cleanText(raw.note);
	return { kind, title, source, ...(note ? { note } : {}), areas };
}

/** The learner's first message when he starts a session from a goal alone. */
export function goalOpening(goal: LearningGoal): string {
	return goal.kind === "certification"
		? `Help me prepare for ${goal.title}.`
		: `Help me learn ${goal.title.replace(/^The\b/, "the")}.`;
}

/** How many items a goal lists in all — the card's and the picker's count. */
export function goalItemCount(goal: LearningGoal): number {
	return goal.areas.reduce((sum, area) => sum + area.groups.reduce((n, group) => n + group.items.length, 0), 0);
}

/**
 * The goal as the tutor reads it: title, kind, source, note, then each area
 * with its weight, groups and items. Capped at GOAL_LIMITS.outline
 * characters on a line boundary, with a count of what was cut.
 */
export function goalOutline(goal: LearningGoal): string {
	const lines = [
		`Goal: ${goal.title}`,
		goal.kind === "certification"
			? "Kind: a Microsoft certification — the skills its exam measures"
			: "Kind: a code repository — the technologies it is built with",
		`Source: ${goal.source}`,
	];
	if (goal.note) lines.push(`Note: ${goal.note}`);
	lines.push("", goal.kind === "certification" ? "Areas, with their share of the exam:" : "Areas:");
	goal.areas.forEach((area, index) => {
		lines.push(`${index + 1}. ${area.name}${area.weight ? ` (${area.weight})` : ""}`);
		for (const group of area.groups) {
			if (group.name) lines.push(`   ${group.name}:`);
			const indent = group.name ? "     " : "   ";
			for (const item of group.items) lines.push(`${indent}- ${item}`);
		}
	});
	const full = lines.join("\n");
	if (full.length <= GOAL_LIMITS.outline) return full;
	const kept: string[] = [];
	let length = 0;
	for (const line of lines) {
		if (length + line.length + 1 > GOAL_LIMITS.outline - 80) break;
		kept.push(line);
		length += line.length + 1;
	}
	return `${kept.join("\n")}\n[The outline is cut here: ${lines.length - kept.length} more lines]`;
}
