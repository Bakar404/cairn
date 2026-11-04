import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeExamCode, parseStudyGuide, studyGuideUrl, type LearnDocsClient } from "../core/learn-docs.ts";
import type { LearningGoal } from "../core/learning-goals.ts";
import { detectRepoTechnologies, repoFileRole, type RepoFile, type RepoScan } from "../core/repo-goals.ts";
import { learnDocsEnabled } from "../core/settings-resolution.ts";
import { learnDocsClient } from "./learn-docs.ts";
import { effectiveSettings } from "./stores.ts";

/**
 * THE GOALS PICKER'S READS (M21): a certification's goal, read from its
 * study guide, and a repository's technologies, read from its manifests.
 * Both are shown in the picker; nothing is saved. The learner's first
 * message carries the chosen goal into the new chat (POST /api/chats),
 * where it becomes the goal-context marker both agents read.
 */

/** A goal that can't be read; status is the HTTP answer the route gives. */
export class GoalError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "GoalError";
	}
}

export interface CertificationGoalOptions {
	/** Default: the process's Microsoft Learn client. */
	client?: LearnDocsClient;
	/** Default: Settings › Agent › Microsoft Learn. */
	enabled?: () => boolean;
	signal?: AbortSignal;
}

/**
 * An exam code ("AZ-104", "az104") → the certification's goal, read from
 * its study guide on Microsoft Learn. GoalError 400 when the input isn't an
 * exam code, 409 when Microsoft Learn is switched off, 502 when the guide
 * can't be fetched, 404 when the page isn't a study guide with skills.
 */
export async function readCertificationGoal(input: string, options: CertificationGoalOptions = {}): Promise<LearningGoal> {
	const code = normalizeExamCode(input);
	if (!code) throw new GoalError("That isn't an exam code. Try one like AZ-104.", 400);
	const enabled = options.enabled ?? (() => learnDocsEnabled(effectiveSettings()));
	if (!enabled()) {
		throw new GoalError("Microsoft Learn is off. Turn it on in Settings › Agent to read study guides.", 409);
	}
	const url = studyGuideUrl(code);
	let page: string;
	try {
		page = await (options.client ?? learnDocsClient).fetch(url, options.signal);
	} catch (err) {
		throw new GoalError(`Couldn't read the study guide: ${err instanceof Error ? err.message : String(err)}`, 502);
	}
	const goal = parseStudyGuide(page, url);
	if (!goal) throw new GoalError(`Microsoft Learn has no study guide for ${code.toUpperCase()}.`, 404);
	return goal;
}

/** The repository walk's bounds. Past any of them the scan stops early and says so (partial). */
export const REPO_SCAN_LIMITS = {
	/** Folders below the repository's own, at most. Deeper ones are skipped,
	 *  like dependency folders: manifests sit near the top. */
	depth: 6,
	/** Files and folders looked at, in all. */
	entries: 20_000,
	manifests: 200,
	/** A larger manifest is listed but not read. */
	manifestBytes: 512 * 1024,
	signals: 500,
	ms: 5_000,
	/** The goal's source is the path, and a goal's text is capped at 300. */
	pathLength: 300,
} as const;

/** Folders that hold dependencies, builds or caches rather than the project's own files. */
const SKIPPED_DIRS = new Set([
	"node_modules",
	"vendor",
	"dist",
	"build",
	"out",
	"target",
	"bin",
	"obj",
	"venv",
	"__pycache__",
	"coverage",
	"site-packages",
]);

/** Hidden folders are skipped, except these that say how the project is built. */
const HIDDEN_DIRS_KEPT = new Set([".github", ".devcontainer"]);

export interface RepoScanOptions {
	signal?: AbortSignal;
	/** For tests: tighter bounds, and the walk's clock. */
	limits?: Partial<Record<keyof typeof REPO_SCAN_LIMITS, number>>;
	now?: () => number;
}

/** The learner's text → an absolute folder path; "~" is his home folder. */
function repositoryPath(input: string): string {
	let text = input.trim();
	if (text.length >= 2 && /^(["']).*\1$/s.test(text)) text = text.slice(1, -1).trim();
	if (text === "~" || /^~[\\/]/.test(text)) text = path.join(os.homedir(), text.slice(1));
	if (!text || /[\0\r\n]/.test(text) || !path.isAbsolute(text)) {
		throw new GoalError("Enter the full path to a folder.", 400);
	}
	const resolved = path.resolve(text);
	if (resolved.length > REPO_SCAN_LIMITS.pathLength) {
		throw new GoalError(`That path is too long for a goal: ${REPO_SCAN_LIMITS.pathLength} characters at most.`, 400);
	}
	return resolved;
}

function folderError(err: unknown): GoalError {
	const code = (err as NodeJS.ErrnoException | null)?.code;
	if (code === "EACCES" || code === "EPERM") return new GoalError("Cairn isn't allowed to read that folder.", 403);
	return new GoalError("There's no folder at that path.", 404);
}

/** A manifest's text; null when it's over the size bound, "" when it can't be read. */
async function readManifest(file: string, maxBytes: number): Promise<string | null> {
	try {
		if ((await stat(file)).size > maxBytes) return null;
		return await readFile(file, "utf8");
	} catch {
		return "";
	}
}

/**
 * A folder on the learner's machine → the technologies its manifests and
 * telling files show (repo-goals.ts), for the Goals picker to list. The walk
 * is breadth-first, so a bound cuts the deepest folders first; it skips
 * dependency, build and hidden folders, never follows links, and reads
 * manifests only. GoalError 400 when the input isn't a full path, 404 when
 * there's no folder there, 403 when it can't be read.
 */
export async function scanRepository(input: string, options: RepoScanOptions = {}): Promise<RepoScan> {
	const root = repositoryPath(input);
	const limits = { ...REPO_SCAN_LIMITS, ...options.limits };
	const now = options.now ?? Date.now;
	try {
		if (!(await stat(root)).isDirectory()) throw new GoalError("There's no folder at that path.", 404);
	} catch (err) {
		throw err instanceof GoalError ? err : folderError(err);
	}
	const deadline = now() + limits.ms;
	const files: RepoFile[] = [];
	const manifests: string[] = [];
	let signals = 0;
	let entries = 0;
	let partial = false;
	const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: "", depth: 0 }];
	walk: for (let next = 0; next < queue.length; next++) {
		if (options.signal?.aborted || now() > deadline) {
			partial = true;
			break;
		}
		const { dir, rel, depth } = queue[next]!;
		let listing: Dirent[];
		try {
			listing = await readdir(dir, { withFileTypes: true });
		} catch (err) {
			if (depth === 0) throw folderError(err);
			continue;
		}
		listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of listing) {
			if (++entries > limits.entries) {
				partial = true;
				break walk;
			}
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				const name = entry.name.toLowerCase();
				if (SKIPPED_DIRS.has(name) || (name.startsWith(".") && !HIDDEN_DIRS_KEPT.has(name))) continue;
				if (depth < limits.depth) queue.push({ dir: path.join(dir, entry.name), rel: relPath, depth: depth + 1 });
				continue;
			}
			if (!entry.isFile()) continue;
			const role = repoFileRole(relPath);
			if (role === "signal") {
				if (signals >= limits.signals) partial = true;
				else {
					signals += 1;
					files.push({ path: relPath });
				}
			} else if (role === "manifest") {
				if (manifests.length >= limits.manifests) {
					partial = true;
					continue;
				}
				const content = await readManifest(path.join(dir, entry.name), limits.manifestBytes);
				if (content === null) partial = true;
				manifests.push(relPath);
				files.push({ path: relPath, content: content ?? "" });
			}
		}
	}
	return { path: root, name: path.basename(root) || root, technologies: detectRepoTechnologies(files), manifests, partial };
}
