/**
 * Reading a code change (M22): a commit range from a local repository, or
 * a GitHub pull request. What comes back is one text for the extraction
 * pipeline (core/code-change.ts lays it out) and the label the source is
 * known by.
 *
 * Git runs without a shell, against resolved commit hashes only, with
 * the repository's external diff drivers, text conversions, pager and
 * filesystem monitor turned off. It only reads history; the working tree
 * is never touched. A pull request is read with the GitHub CLI when it's
 * signed in (private repositories work), else through GitHub's public
 * REST API.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	codeChangeText,
	MAX_CHANGE_COMMITS,
	pullRequestLabel,
	pullRequestUrl,
	trimDiff,
	type ChangeCommit,
	type CodeChangeRequest,
	type PullRequestRef,
	type RevisionRange,
} from "../core/code-change.ts";

/** A reason the change couldn't be read, worded for the learner. */
export class CodeChangeError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CodeChangeError";
	}
}

/** A program that ran and failed (or never started: code ENOENT). */
export class RunError extends Error {
	constructor(
		message: string,
		public readonly code: string | number | undefined,
		public readonly stderr: string,
		/** Killed by the timeout. */
		public readonly killed = false,
	) {
		super(message);
		this.name = "RunError";
	}
}

/** What reading a change needs from the outside world — swapped in tests. */
export interface CodeChangeRunners {
	/** Run a program, no shell; resolves its stdout or rejects a RunError. */
	run(file: string, args: readonly string[]): Promise<string>;
	fetch: typeof fetch;
	env: Readonly<Record<string, string | undefined>>;
}

export interface CodeChangeRead {
	/** The source's identity and provenance label: "github.com/o/r/pull/12"
	 *  or "repo@1a2b3c4..5d6e7f8". */
	label: string;
	text: string;
	files: string[];
	skipped: string[];
	omitted: string[];
}

function run(file: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			[...args],
			{
				encoding: "utf8",
				windowsHide: true,
				timeout: 60_000,
				maxBuffer: 64 * 1024 * 1024,
				env: {
					...process.env,
					GIT_TERMINAL_PROMPT: "0",
					GIT_PAGER: "cat",
					PAGER: "cat",
					GH_PROMPT_DISABLED: "1",
					GH_NO_UPDATE_NOTIFIER: "1",
					NO_COLOR: "1",
				},
			},
			(err, stdout, stderr) => {
				if (!err) return resolve(stdout);
				const code = (err as NodeJS.ErrnoException).code ?? undefined;
				const detail = stderr.trim() || err.message;
				reject(new RunError(detail, code, stderr, Boolean((err as { killed?: boolean }).killed)));
			},
		);
	});
}

const defaultRunners: CodeChangeRunners = { run, fetch: (...a) => fetch(...a), env: process.env };

/** Read one change. Throws CodeChangeError with a message for the learner. */
export async function readCodeChange(
	request: CodeChangeRequest,
	runners: CodeChangeRunners = defaultRunners,
): Promise<CodeChangeRead> {
	try {
		return request.kind === "pr"
			? await readPullRequest(request.ref, runners)
			: await readCommitRange(request.repoPath, request.range, runners);
	} catch (err) {
		if (!(err instanceof RunError)) throw err;
		if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
			throw new CodeChangeError("This change is too large to read. Try a smaller range of commits.", { cause: err });
		}
		if (err.killed) throw new CodeChangeError("Git took too long to read that change.", { cause: err });
		const firstLine = err.message.split("\n").find((line) => line.trim()) ?? "unknown error";
		throw new CodeChangeError(`Git couldn't read that change: ${firstLine.trim()}`, { cause: err });
	}
}

function finish(label: string, parts: Parameters<typeof codeChangeText>[0]): CodeChangeRead {
	const { diff } = parts;
	if (diff.files.length === 0) {
		if (diff.omitted.length > 0) {
			throw new CodeChangeError("This change is too large to import. Try a smaller range of commits.");
		}
		if (diff.skipped.length > 0) {
			throw new CodeChangeError("Every file in this change is generated or binary, so there's nothing to learn from it.");
		}
		throw new CodeChangeError("This change has no file changes to import.");
	}
	return { label, text: codeChangeText(parts), files: diff.files, skipped: diff.skipped, omitted: diff.omitted };
}

// ─── a local commit range ────────────────────────────────────────────────────

// Turned off for every call: quoted non-ASCII paths, the filesystem
// monitor (a repository can name any program there), and diff prefixes
// that would change the "diff --git a/… b/…" shape the locator reads.
const GIT_CONFIG = [
	"-c", "core.quotePath=false",
	"-c", "core.fsmonitor=false",
	"-c", "diff.noprefix=false",
	"-c", "diff.mnemonicPrefix=false",
	"--no-pager",
];
const DIFF_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "--src-prefix=a/", "--dst-prefix=b/"];
const LOG_FORMAT = "--format=%H%x1f%s%x1f%b%x1e";

async function readCommitRange(repoPath: string, range: RevisionRange, runners: CodeChangeRunners): Promise<CodeChangeRead> {
	if (!path.isAbsolute(repoPath)) throw new CodeChangeError("Enter the full path to the repository folder.");
	let isDirectory = false;
	try {
		isDirectory = fs.statSync(repoPath).isDirectory();
	} catch {
		/* missing — reported below */
	}
	if (!isDirectory) throw new CodeChangeError("That folder doesn't exist.");

	const git = (cwd: string, args: readonly string[]): Promise<string> =>
		runners.run("git", [...GIT_CONFIG, "-C", cwd, ...args]).catch((err: unknown) => {
			if (err instanceof RunError && err.code === "ENOENT") {
				throw new CodeChangeError("Git isn't installed, or isn't on the PATH.");
			}
			throw err;
		});

	let root: string;
	try {
		root = (await git(repoPath, ["rev-parse", "--show-toplevel"])).trim();
	} catch (err) {
		if (err instanceof CodeChangeError) throw err;
		const detail = err instanceof RunError ? err.message : "";
		throw new CodeChangeError(
			/dubious ownership/i.test(detail)
				? "Git refuses to read this folder because another user owns it (see git's safe.directory)."
				: "That folder isn't inside a git repository.",
		);
	}

	const resolve = async (rev: string): Promise<string> => {
		try {
			return (await git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim();
		} catch (err) {
			if (err instanceof CodeChangeError) throw err;
			throw new CodeChangeError(`Git can't find the commit "${rev}" in that repository.`);
		}
	};
	const commitsIn = async (revs: readonly string[], max: number): Promise<ChangeCommit[]> => {
		const out = await git(root, ["log", "--no-color", "--no-show-signature", `--max-count=${max}`, LOG_FORMAT, ...revs]);
		return out
			.split("\x1e")
			.map((record) => record.replace(/^\r?\n/, ""))
			.filter((record) => record.length > 0)
			.map((record) => {
				const [sha = "", subject = "", body = ""] = record.split("\x1f");
				return { sha, subject, ...(body.trim() ? { body } : {}) };
			})
			.reverse();
	};

	const name = path.basename(root);
	const to = await resolve(range.to);
	let label: string;
	let diff: string;
	let commits: ChangeCommit[];
	let unlistedCommits = 0;
	if (range.from === undefined) {
		label = `${name}@${to.slice(0, 7)}`;
		const [, parent] = (await git(root, ["rev-list", "--parents", "--max-count=1", to])).trim().split(/\s+/);
		diff = parent
			? await git(root, ["diff", ...DIFF_OPTIONS, parent, to])
			: await git(root, ["diff-tree", "-r", "-p", "--root", "--no-commit-id", ...DIFF_OPTIONS, to]);
		commits = await commitsIn([to], 1);
	} else {
		let from = await resolve(range.from);
		if (range.symmetric) {
			try {
				from = (await git(root, ["merge-base", from, to])).trim();
			} catch (err) {
				if (err instanceof CodeChangeError) throw err;
				throw new CodeChangeError(`"${range.from}" and "${range.to}" share no history.`);
			}
		}
		label = `${name}@${from.slice(0, 7)}..${to.slice(0, 7)}`;
		diff = await git(root, ["diff", ...DIFF_OPTIONS, from, to]);
		commits = await commitsIn([`${from}..${to}`], MAX_CHANGE_COMMITS);
		const total = Number((await git(root, ["rev-list", "--count", `${from}..${to}`])).trim());
		if (Number.isFinite(total)) unlistedCommits = Math.max(0, total - commits.length);
	}
	return finish(label, {
		heading: `Commits ${label}`,
		commits,
		unlistedCommits,
		diff: trimDiff(diff),
	});
}

// ─── a GitHub pull request ───────────────────────────────────────────────────

interface PullRequestData {
	title: string;
	body: string;
	commits: ChangeCommit[];
	commitCount: number;
	diff: string;
}

function splitMessage(sha: string, message: string): ChangeCommit {
	const [subject = "", ...rest] = message.replace(/\r\n/g, "\n").split("\n");
	const body = rest.join("\n").trim();
	return { sha, subject, ...(body ? { body } : {}) };
}

async function viaGh(ref: PullRequestRef, runners: CodeChangeRunners): Promise<PullRequestData> {
	const url = pullRequestUrl(ref);
	const view = JSON.parse(await runners.run("gh", ["pr", "view", url, "--json", "title,body,commits"])) as {
		title?: unknown;
		body?: unknown;
		commits?: Array<{ oid?: unknown; messageHeadline?: unknown; messageBody?: unknown }>;
	};
	const diff = await runners.run("gh", ["pr", "diff", url, "--color", "never"]);
	const commits = (Array.isArray(view.commits) ? view.commits : []).map((c) => {
		const body = typeof c.messageBody === "string" ? c.messageBody.trim() : "";
		return {
			sha: typeof c.oid === "string" ? c.oid : "",
			subject: typeof c.messageHeadline === "string" ? c.messageHeadline : "",
			...(body ? { body } : {}),
		};
	});
	return {
		title: typeof view.title === "string" ? view.title : "",
		body: typeof view.body === "string" ? view.body : "",
		commits,
		commitCount: commits.length,
		diff,
	};
}

async function viaRest(ref: PullRequestRef, runners: CodeChangeRunners): Promise<PullRequestData> {
	const base = `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
	const token = runners.env.GH_TOKEN || runners.env.GITHUB_TOKEN;
	const get = async (url: string, accept: string): Promise<Response> => {
		let response: Response;
		try {
			response = await runners.fetch(url, {
				headers: {
					accept,
					"user-agent": "cairn",
					"x-github-api-version": "2022-11-28",
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
				signal: AbortSignal.timeout(30_000),
			});
		} catch (err) {
			throw new CodeChangeError(`Couldn't reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (response.ok) return response;
		const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
		if (limited) {
			throw new CodeChangeError(
				"GitHub's limit for requests without sign-in is used up. Sign in with the GitHub CLI (gh auth login), or try again in an hour.",
			);
		}
		if (response.status === 404) {
			throw new CodeChangeError(
				"GitHub can't find that pull request. If the repository is private, sign in with the GitHub CLI (gh auth login) and try again.",
			);
		}
		if (response.status === 401) throw new CodeChangeError("GitHub rejected the token in GH_TOKEN or GITHUB_TOKEN.");
		if (response.status === 406 || response.status === 422) {
			throw new CodeChangeError(
				"GitHub won't send a diff this large. Clone the repository and import a smaller range of its commits instead.",
			);
		}
		throw new CodeChangeError(`GitHub answered ${response.status} for that pull request.`);
	};
	const pr = (await (await get(base, "application/vnd.github+json")).json()) as {
		title?: unknown;
		body?: unknown;
		commits?: unknown;
	};
	const listed = (await (await get(`${base}/commits?per_page=${MAX_CHANGE_COMMITS}`, "application/vnd.github+json")).json()) as Array<{
		sha?: unknown;
		commit?: { message?: unknown };
	}>;
	const diff = await (await get(base, "application/vnd.github.diff")).text();
	const commits = (Array.isArray(listed) ? listed : []).map((c) =>
		splitMessage(typeof c.sha === "string" ? c.sha : "", typeof c.commit?.message === "string" ? c.commit.message : ""),
	);
	return {
		title: typeof pr.title === "string" ? pr.title : "",
		body: typeof pr.body === "string" ? pr.body : "",
		commits,
		commitCount: typeof pr.commits === "number" ? pr.commits : commits.length,
		diff,
	};
}

async function readPullRequest(ref: PullRequestRef, runners: CodeChangeRunners): Promise<CodeChangeRead> {
	let data: PullRequestData;
	try {
		data = await viaGh(ref, runners);
	} catch {
		// Not installed, not signed in, or no access: the public API decides.
		data = await viaRest(ref, runners);
	}
	const label = pullRequestLabel(ref);
	const commits = data.commits.slice(0, MAX_CHANGE_COMMITS);
	return finish(label, {
		heading: `Pull request ${label}`,
		title: data.title,
		url: pullRequestUrl(ref),
		description: data.body,
		commits,
		unlistedCommits: Math.max(0, data.commitCount - commits.length),
		diff: trimDiff(data.diff),
	});
}
