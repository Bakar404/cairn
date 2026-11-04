/**
 * Code changes as sources (M22). A learner imports a local commit range or
 * a GitHub pull request; the server reads it (src/server/code-change.ts)
 * and this module turns what it read into one text for the same
 * extraction pipeline a notes file goes through: the title, description
 * and commit messages first (the why), then the unified diff (the what).
 *
 * The diff is filtered before a model sees it: lock files, build output,
 * minified bundles, snapshots and binaries are skipped, and the rest is
 * capped so one huge change can't spend the learner's quota. Every file
 * left out is listed in the text, so nothing is dropped silently.
 *
 * Pure and browser-safe.
 */

/** The most diff text one import reads: about 50k tokens, or 13 extraction chunks. */
export const MAX_CHANGE_DIFF_CHARS = 200_000;
/** Commit messages listed for one change; the rest are counted. */
export const MAX_CHANGE_COMMITS = 100;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_COMMIT_BODY_CHARS = 800;

// ─── what the learner typed ──────────────────────────────────────────────────

export interface PullRequestRef {
	owner: string;
	repo: string;
	number: number;
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** A GitHub pull request from its link ("https://github.com/o/r/pull/12",
 *  with or without the scheme, any /files or #anchor tail) or the short
 *  form "o/r#12". Null for anything else. */
export function parsePullRequestRef(input: string): PullRequestRef | null {
	const raw = input.trim();
	const m =
		/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/pull\/(\d{1,9})(?:[/?#]\S*)?$/i.exec(raw) ??
		/^([^/\s#]+)\/([^/\s#]+)#(\d{1,9})$/.exec(raw);
	if (!m) return null;
	const owner = m[1]!;
	const repo = m[2]!;
	const number = Number(m[3]);
	if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
	return number >= 1 ? { owner, repo, number } : null;
}

export function pullRequestUrl(ref: PullRequestRef): string {
	return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

/** The pull request's source label: its identity on re-import and the
 *  provenance line the graph shows. */
export function pullRequestLabel(ref: PullRequestRef): string {
	return `github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

export interface RevisionRange {
	/** The range's start; absent for one commit (read against its parent). */
	from?: string;
	to: string;
	/** "A...B": from the merge base of A and B, the way a pull request diffs. */
	symmetric: boolean;
}

// Refs never start with "-" (an option) or "." and never contain "..";
// whether the revision exists is git's call.
const REVISION = /^(?![-.])[A-Za-z0-9._/~^@{}-]{1,200}$/;
const isRevision = (rev: string): boolean => REVISION.test(rev) && !rev.includes("..");

/** "HEAD~3..HEAD", "main...feature", "a1b2c3d" (one commit), "v1.2.." (up
 *  to HEAD), "..main" (from HEAD). Null for anything malformed. */
export function parseRevisionRange(input: string): RevisionRange | null {
	const raw = input.trim();
	const at = raw.indexOf("..");
	if (at < 0) return isRevision(raw) ? { to: raw, symmetric: false } : null;
	const symmetric = raw.startsWith("...", at);
	const left = raw.slice(0, at);
	const right = raw.slice(at + (symmetric ? 3 : 2));
	if (!left && !right) return null;
	const from = left || "HEAD";
	const to = right || "HEAD";
	return isRevision(from) && isRevision(to) ? { from, to, symmetric } : null;
}

export type CodeChangeRequest =
	| { kind: "git"; repoPath: string; range: RevisionRange }
	| { kind: "pr"; ref: PullRequestRef };

const PR_HINT = "That isn't a GitHub pull request link. Paste one like https://github.com/owner/repo/pull/123.";
const RANGE_HINT = "That isn't a commit range git understands. Try HEAD~3..HEAD, main..my-branch, or one commit's hash.";

/** The import route's body: {kind:"pr", url} or {kind:"git", repoPath,
 *  range}, where an empty range means the latest commit. Otherwise an
 *  error the learner can act on. */
export function parseCodeChangeRequest(body: unknown): { request: CodeChangeRequest } | { error: string } {
	const b = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
	if (b.kind === "pr") {
		const ref = typeof b.url === "string" ? parsePullRequestRef(b.url) : null;
		return ref ? { request: { kind: "pr", ref } } : { error: PR_HINT };
	}
	if (b.kind === "git") {
		// Explorer's "Copy as path" wraps the path in quotes.
		const repoPath = typeof b.repoPath === "string" ? b.repoPath.trim().replace(/^"(.*)"$/, "$1").trim() : "";
		if (!repoPath || repoPath.length > 1024 || /[\0\r\n]/.test(repoPath)) {
			return { error: "Enter the folder of a local git repository." };
		}
		const rangeText = typeof b.range === "string" && b.range.trim() ? b.range : "HEAD";
		const range = parseRevisionRange(rangeText);
		return range ? { request: { kind: "git", repoPath, range } } : { error: RANGE_HINT };
	}
	return { error: "Choose a pull request or local commits to import." };
}

// ─── the diff ────────────────────────────────────────────────────────────────

const ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Git's C-style path quoting undone: escapes, and octal bytes as UTF-8. */
function unquoteGitPath(quoted: string): string {
	const encoder = new TextEncoder();
	const bytes: number[] = [];
	for (let i = 0; i < quoted.length; ) {
		if (quoted[i] === "\\") {
			const octal = /^[0-7]{3}/.exec(quoted.slice(i + 1, i + 4));
			if (octal) {
				bytes.push(parseInt(octal[0], 8) & 0xff);
				i += 4;
				continue;
			}
			const code = ESCAPES[quoted[i + 1] ?? ""];
			if (code !== undefined) {
				bytes.push(code);
				i += 2;
				continue;
			}
		}
		const ch = String.fromCodePoint(quoted.codePointAt(i)!);
		bytes.push(...encoder.encode(ch));
		i += ch.length;
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The path a "diff --git" header names (the new one, for a rename),
 *  quoted names included. Undefined for any other line. */
export function diffHeaderPath(line: string): string | undefined {
	const m = /^diff --git (?:"a\/(?:[^"\\]|\\.)*"|a\/.*?) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.*))$/.exec(line);
	if (!m) return undefined;
	return m[1] !== undefined ? unquoteGitPath(m[1]) : m[2];
}

export interface DiffFile {
	/** The file's path (the new one, for a rename). */
	path: string;
	/** Its whole section: the "diff --git" header through its last hunk. */
	text: string;
	binary: boolean;
}

/** A unified diff in git's format, one section per file. Anything before
 *  the first "diff --git" line (a mail header) is dropped. */
export function splitDiff(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	let lines: string[] | undefined;
	let path = "";
	const flush = (): void => {
		if (!lines) return;
		const text = lines.join("\n").replace(/\n+$/, "");
		files.push({ path, text, binary: /^(?:Binary files .* differ|GIT binary patch)$/m.test(text) });
	};
	for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
		if (line.startsWith("diff --git ")) {
			flush();
			lines = [line];
			path = diffHeaderPath(line) ?? line.slice("diff --git ".length);
		} else {
			lines?.push(line);
		}
	}
	flush();
	return files;
}

const LOCK_FILES = new Set([
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	"deno.lock",
	"cargo.lock",
	"poetry.lock",
	"pipfile.lock",
	"uv.lock",
	"gemfile.lock",
	"composer.lock",
	"go.sum",
	"flake.lock",
	"packages.lock.json",
	"podfile.lock",
	"mix.lock",
	"pubspec.lock",
]);

/** Files a tool wrote, not a person: lock files, build output, vendored
 *  code, minified bundles, source maps and test snapshots. */
export function isGeneratedPath(path: string): boolean {
	const lower = path.toLowerCase();
	const base = lower.slice(lower.lastIndexOf("/") + 1);
	if (LOCK_FILES.has(base)) return true;
	if (/\.min\.(?:js|mjs|css)$/.test(base) || /\.(?:map|snap)$/.test(base)) return true;
	return /(?:^|\/)(?:dist|node_modules|\.next|coverage|vendor)\//.test(lower);
}

export interface TrimmedDiff {
	/** The diff a model reads: every kept file's section, in git's order. */
	diff: string;
	files: string[];
	/** Generated or binary files, left out unread. */
	skipped: string[];
	/** Files left out because the diff reached the size cap. */
	omitted: string[];
}

/** The diff minus generated and binary files, then whole files in order
 *  while they fit the cap; a smaller later file can still fit after a
 *  big one is left out. */
export function trimDiff(diff: string, maxChars: number = MAX_CHANGE_DIFF_CHARS): TrimmedDiff {
	const kept: string[] = [];
	const out: TrimmedDiff = { diff: "", files: [], skipped: [], omitted: [] };
	let size = 0;
	for (const file of splitDiff(diff)) {
		if (file.binary || isGeneratedPath(file.path)) {
			out.skipped.push(file.path);
		} else if (size + file.text.length + 1 > maxChars) {
			out.omitted.push(file.path);
		} else {
			kept.push(file.text);
			out.files.push(file.path);
			size += file.text.length + 1;
		}
	}
	out.diff = kept.join("\n");
	return out;
}

// ─── the text the extractor reads ────────────────────────────────────────────

export interface ChangeCommit {
	sha: string;
	subject: string;
	body?: string;
}

export interface CodeChangeParts {
	/** What the change is, e.g. "Pull request github.com/o/r/pull/12". */
	heading: string;
	title?: string;
	url?: string;
	description?: string;
	commits: ReadonlyArray<ChangeCommit>;
	/** Commits in the change beyond the listed ones. */
	unlistedCommits?: number;
	diff: TrimmedDiff;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max).trimEnd()} …` : text);
// Prose lines that look like diff structure get a leading space, so the
// hunk locator (core/quote-check.ts) only ever sees the real diff.
const prose = (text: string): string => text.replace(/\r\n/g, "\n").replace(/^(?=diff --git |@@)/gm, " ");

/** One text for the extractor: the why (title, description, commit
 *  messages), the files left out, then the what (the diff). */
export function codeChangeText(parts: CodeChangeParts): string {
	const out = [`# ${oneLine(parts.heading)}`];
	if (parts.title?.trim()) out.push(`Title: ${oneLine(parts.title)}`);
	if (parts.url) out.push(`URL: ${parts.url}`);
	const description = parts.description?.trim();
	if (description) out.push("", "## Description", prose(clip(description, MAX_DESCRIPTION_CHARS)));
	if (parts.commits.length > 0) {
		out.push("", "## Commits");
		for (const commit of parts.commits) {
			out.push(`- ${commit.sha.slice(0, 7)} ${oneLine(commit.subject)}`);
			const body = commit.body?.trim();
			if (body) out.push(prose(clip(body, MAX_COMMIT_BODY_CHARS)).replace(/^/gm, "  "));
		}
		const more = parts.unlistedCommits ?? 0;
		if (more > 0) out.push(`- … and ${more} more commit${more === 1 ? "" : "s"} not listed`);
	}
	const notShown = [
		...parts.diff.skipped.map((path) => `- ${oneLine(path)} (generated or binary)`),
		...parts.diff.omitted.map((path) => `- ${oneLine(path)} (over the size limit)`),
	];
	if (notShown.length > 0) out.push("", "## Files not shown", ...notShown);
	out.push("", "## Diff", parts.diff.diff);
	return out.join("\n");
}
