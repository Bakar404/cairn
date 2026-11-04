/**
 * Code changes as sources (M22): the pure parsing and layout
 * (core/code-change.ts), the readers (server/code-change.ts) against
 * mocked runners and a real temporary git repository, and the import
 * route's envelope.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// The route loads the server barrel; keep its data out of the repo.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-code-change-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const {
	codeChangeText,
	diffHeaderPath,
	isGeneratedPath,
	parseCodeChangeRequest,
	parsePullRequestRef,
	parseRevisionRange,
	splitDiff,
	trimDiff,
} = await import("../src/core/code-change.ts");
const { sourceLocator } = await import("../src/core/quote-check.ts");
const { CodeChangeError, readCodeChange, RunError } = await import("../src/server/code-change.ts");
type Runners = import("../src/server/code-change.ts").CodeChangeRunners;
type Request = import("../src/core/code-change.ts").CodeChangeRequest;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function request(body: unknown): Request {
	const parsed = parseCodeChangeRequest(body);
	assert.ok("request" in parsed, JSON.stringify(parsed));
	return parsed.request;
}

// ─── what the learner typed ─────────────────────────────────────────────────

describe("parsing what the learner typed", () => {
	it("reads a pull request from its link, with or without a tail, or the short form", () => {
		const ref = { owner: "octo-org", repo: "hello.world", number: 12 };
		for (const input of [
			"https://github.com/octo-org/hello.world/pull/12",
			"  github.com/octo-org/hello.world/pull/12/files  ",
			"https://www.github.com/octo-org/hello.world/pull/12#discussion_r1",
			"octo-org/hello.world#12",
		]) {
			assert.deepEqual(parsePullRequestRef(input), ref, input);
		}
		for (const input of [
			"https://gitlab.com/o/r/pull/1",
			"https://github.com/o/r/issues/1",
			"https://github.com/o/r/pull/0",
			"https://github.com/-o/r/pull/1",
			"https://github.com/o/../pull/1",
			"o/r",
		]) {
			assert.equal(parsePullRequestRef(input), null, input);
		}
	});

	it("reads commit ranges git understands, and refuses option-like or malformed ones", () => {
		assert.deepEqual(parseRevisionRange("HEAD~3..HEAD"), { from: "HEAD~3", to: "HEAD", symmetric: false });
		assert.deepEqual(parseRevisionRange("main...my-branch"), { from: "main", to: "my-branch", symmetric: true });
		assert.deepEqual(parseRevisionRange(" a1b2c3d "), { to: "a1b2c3d", symmetric: false });
		assert.deepEqual(parseRevisionRange("v1.2.."), { from: "v1.2", to: "HEAD", symmetric: false });
		assert.deepEqual(parseRevisionRange("..main"), { from: "HEAD", to: "main", symmetric: false });
		for (const input of ["..", "", "a..b..c", "--output=x", "-p", ".hidden", "HEAD;rm", "a b"]) {
			assert.equal(parseRevisionRange(input), null, input);
		}
	});

	it("checks the route's body: an empty range is the latest commit, a quoted path is unwrapped", () => {
		assert.deepEqual(parseCodeChangeRequest({ kind: "git", repoPath: ' "C:\\code\\repo" ', range: "  " }), {
			request: { kind: "git", repoPath: "C:\\code\\repo", range: { to: "HEAD", symmetric: false } },
		});
		assert.match((parseCodeChangeRequest({ kind: "pr", url: "nope" }) as { error: string }).error, /pull request link/);
		assert.match((parseCodeChangeRequest({ kind: "git", repoPath: " " }) as { error: string }).error, /folder of a local git/);
		assert.match((parseCodeChangeRequest({ kind: "git", repoPath: "/r", range: "-x" }) as { error: string }).error, /commit range/);
		assert.match((parseCodeChangeRequest(null) as { error: string }).error, /Choose a pull request/);
	});
});

// ─── the diff ───────────────────────────────────────────────────────────────

describe("reading a diff", () => {
	it("names a header's file: the new path of a rename, git's quoted and octal-escaped names", () => {
		assert.equal(diffHeaderPath("diff --git a/src/a.ts b/src/a.ts"), "src/a.ts");
		assert.equal(diffHeaderPath("diff --git a/old.ts b/new.ts"), "new.ts");
		assert.equal(diffHeaderPath("diff --git a/my notes.md b/my notes.md"), "my notes.md");
		assert.equal(diffHeaderPath('diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"'), "café.md");
		assert.equal(diffHeaderPath('diff --git "a/say \\"hi\\".txt" "b/say \\"hi\\".txt"'), 'say "hi".txt');
		assert.equal(diffHeaderPath("+diff --git a/x b/x"), undefined);
		assert.equal(diffHeaderPath("diff --git a/x"), undefined);
	});

	it("splits per file, drops a mail header and CRs, and spots binaries", () => {
		const files = splitDiff(
			[
				"From abc Mon Sep 17 00:00:00 2001",
				"Subject: [PATCH] x",
				"",
				"diff --git a/a.ts b/a.ts\r",
				"--- a/a.ts\r",
				"+++ b/a.ts\r",
				"@@ -1 +1 @@\r",
				"-a\r",
				"+b\r",
				"diff --git a/logo.png b/logo.png",
				"new file mode 100644",
				"Binary files /dev/null and b/logo.png differ",
				"",
			].join("\n"),
		);
		assert.deepEqual(
			files.map((f) => [f.path, f.binary]),
			[["a.ts", false], ["logo.png", true]],
		);
		assert.equal(files[0]!.text, "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b");
	});

	it("knows the files a tool wrote", () => {
		for (const p of ["package-lock.json", "web/yarn.lock", "Cargo.lock", "dist/app.js", "packages/ui/dist/index.js",
			"src/app.min.js", "src/__snapshots__/a.test.ts.snap", "app.js.map", "node_modules/x/index.js"]) {
			assert.equal(isGeneratedPath(p), true, p);
		}
		for (const p of ["src/index.ts", "distribution/a.ts", "docs/vendor.md", "lock.json"]) {
			assert.equal(isGeneratedPath(p), false, p);
		}
	});

	it("keeps whole files while they fit, skips generated and binary ones, and says what it left out", () => {
		const section = (file: string, body: string) => `diff --git a/${file} b/${file}\n@@ -0,0 +1 @@\n+${body}`;
		const a = section("a.ts", "x".repeat(50));
		const big = section("big.ts", "y".repeat(500));
		const c = section("c.ts", "z".repeat(10));
		const lock = section("package-lock.json", "{}");
		const trimmed = trimDiff([a, big, lock, c].join("\n"), a.length + 1 + c.length + 1);
		assert.deepEqual(trimmed.files, ["a.ts", "c.ts"], "a smaller later file still fits");
		assert.deepEqual(trimmed.omitted, ["big.ts"]);
		assert.deepEqual(trimmed.skipped, ["package-lock.json"]);
		assert.equal(trimmed.diff, `${a}\n${c}`);
	});

	it("lays out the why before the what, and only the real diff has hunks", () => {
		const text = codeChangeText({
			heading: "Pull request github.com/o/r/pull/12",
			title: "Retry\ntransient   failures",
			url: "https://github.com/o/r/pull/12",
			description: "Why: gateways flake.\ndiff --git a/fake b/fake\n@@ -1 +1 @@",
			commits: [{ sha: "abcdef1234567", subject: "Retry on 5xx", body: "Only 5xx.\n@@ not a hunk" }],
			unlistedCommits: 1,
			diff: {
				diff: "diff --git a/src/f.ts b/src/f.ts\n@@ -1 +1 @@\n-a\n+b",
				files: ["src/f.ts"],
				skipped: ["package-lock.json"],
				omitted: ["big.ts"],
			},
		});
		assert.ok(text.startsWith(
			"# Pull request github.com/o/r/pull/12\nTitle: Retry transient failures\nURL: https://github.com/o/r/pull/12",
		));
		assert.ok(text.includes("## Description\nWhy: gateways flake.\n diff --git a/fake b/fake\n @@ -1 +1 @@"));
		assert.ok(text.includes("## Commits\n- abcdef1 Retry on 5xx\n  Only 5xx.\n   @@ not a hunk\n- … and 1 more commit not listed"));
		assert.ok(text.includes(
			"## Files not shown\n- package-lock.json (generated or binary)\n- big.ts (over the size limit)",
		));
		assert.ok(text.endsWith("## Diff\ndiff --git a/src/f.ts b/src/f.ts\n@@ -1 +1 @@\n-a\n+b"));
		const locate = sourceLocator(text);
		assert.equal(locate.hunkAt(text.indexOf("gateways flake")), undefined);
		assert.equal(locate.hunkAt(text.indexOf(" @@ -1 +1 @@")), undefined, "a description line is never a hunk");
		assert.equal(locate.hunkAt(text.lastIndexOf("+b"))?.file, "src/f.ts");
	});
});

// ─── reading a pull request (mocked gh and GitHub) ─────────────────────────

const PR_URL = "https://github.com/o/r/pull/12";
const PR_DIFF = [
	"diff --git a/src/fetch.ts b/src/fetch.ts",
	"--- a/src/fetch.ts",
	"+++ b/src/fetch.ts",
	"@@ -1,2 +1,3 @@",
	" export async function get(url) {",
	"+  if (res.status >= 500) return retry(url);",
	" }",
	'diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"',
	"@@ -0,0 +1 @@",
	"+Retries stop at three.",
	"diff --git a/package-lock.json b/package-lock.json",
	"@@ -1 +1 @@",
	"-{}",
	"+{ }",
	"diff --git a/logo.png b/logo.png",
	"Binary files a/logo.png and b/logo.png differ",
	"",
].join("\n");

const noFetch = (async () => {
	throw new Error("fetch must not run");
}) as unknown as typeof fetch;

function runners(overrides: Partial<Runners>): Runners {
	return {
		run: async (file) => {
			throw new RunError(`${file}: not found`, "ENOENT", "");
		},
		fetch: noFetch,
		env: {},
		...overrides,
	};
}

describe("reading a pull request", () => {
	it("uses the GitHub CLI when it's signed in: description, commits, and the filtered diff", async () => {
		const calls: string[][] = [];
		const read = await readCodeChange(
			request({ kind: "pr", url: PR_URL }),
			runners({
				run: async (file, args) => {
					calls.push([file, ...args]);
					if (args[1] === "view") {
						return JSON.stringify({
							title: "Retry transient failures",
							body: "A 503 from the gateway is temporary.\ndiff --git a/fake b/fake",
							commits: [{ oid: "abc1234def5678", messageHeadline: "Retry on 5xx", messageBody: "Not on 4xx.\n" }],
						});
					}
					return PR_DIFF;
				},
			}),
		);
		assert.deepEqual(calls, [
			["gh", "pr", "view", PR_URL, "--json", "title,body,commits"],
			["gh", "pr", "diff", PR_URL, "--color", "never"],
		]);
		assert.equal(read.label, "github.com/o/r/pull/12");
		assert.deepEqual(read.files, ["src/fetch.ts", "docs/café.md"]);
		assert.deepEqual(read.skipped, ["package-lock.json", "logo.png"]);
		assert.deepEqual(read.omitted, []);
		assert.ok(read.text.includes("Title: Retry transient failures"));
		assert.ok(read.text.includes(`URL: ${PR_URL}`));
		assert.ok(read.text.includes("- abc1234 Retry on 5xx\n  Not on 4xx."));
		const locate = sourceLocator(read.text);
		assert.equal(locate.hunkAt(read.text.indexOf("A 503 from the gateway")), undefined);
		const hunk = locate.hunkAt(read.text.indexOf("if (res.status >= 500)"));
		assert.equal(hunk?.file, "src/fetch.ts");
		assert.equal(hunk?.header, "@@ -1,2 +1,3 @@");
		assert.equal(locate.hunkAt(read.text.indexOf("Retries stop at three"))?.file, "docs/café.md");
	});

	it("falls back to GitHub's REST API without the CLI, counting commits it didn't list", async () => {
		const seen: Array<{ url: string; accept: string; auth: string | undefined }> = [];
		const fetchMock = (async (url: string, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>;
			seen.push({ url, accept: headers.accept!, auth: headers.authorization });
			if (url.endsWith("/commits?per_page=100")) {
				return Response.json([{ sha: "abc1234def5678", commit: { message: "Retry on 5xx\r\n\r\nNot on 4xx." } }]);
			}
			if (headers.accept === "application/vnd.github.diff") return new Response(PR_DIFF);
			return Response.json({ title: "Retry transient failures", body: null, commits: 3 });
		}) as unknown as typeof fetch;
		const read = await readCodeChange(request({ kind: "pr", url: PR_URL }), runners({ fetch: fetchMock }));
		assert.equal(seen.length, 3);
		assert.ok(seen.every((s) => s.url.startsWith("https://api.github.com/repos/o/r/pulls/12") && s.auth === undefined));
		assert.ok(read.text.includes("- abc1234 Retry on 5xx\n  Not on 4xx.\n- … and 2 more commits not listed"));
		assert.ok(!read.text.includes("## Description"), "a PR without a description has none");
		assert.deepEqual(read.files, ["src/fetch.ts", "docs/café.md"]);

		seen.length = 0;
		await readCodeChange(request({ kind: "pr", url: PR_URL }), runners({ fetch: fetchMock, env: { GH_TOKEN: "test-token" } }));
		assert.ok(seen.every((s) => s.auth === "Bearer test-token"), "a token in the environment signs the requests");
	});

	it("words GitHub's refusals for the learner", async () => {
		const answer = (status: number, headers: Record<string, string> = {}) =>
			(async () => new Response("{}", { status, headers })) as unknown as typeof fetch;
		const cases: Array<[typeof fetch, RegExp]> = [
			[answer(404), /can't find that pull request.*gh auth login/],
			[answer(401), /rejected the token/],
			[answer(403, { "x-ratelimit-remaining": "0" }), /limit for requests without sign-in/],
			[answer(429), /limit for requests without sign-in/],
			[answer(406), /won't send a diff this large/],
			[answer(403), /answered 403/],
			[answer(500), /answered 500/],
			[(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, /Couldn't reach GitHub: fetch failed/],
		];
		for (const [fetchMock, message] of cases) {
			await assert.rejects(
				readCodeChange(request({ kind: "pr", url: PR_URL }), runners({ fetch: fetchMock })),
				(err: unknown) => err instanceof CodeChangeError && message.test(err.message),
				String(message),
			);
		}
	});

	it("refuses a change with nothing a person wrote, or nothing under the size cap", async () => {
		const only = (diff: string) => runners({
			run: async (_file, args) => (args[1] === "view" ? JSON.stringify({ title: "t", body: "", commits: [] }) : diff),
		});
		await assert.rejects(
			readCodeChange(request({ kind: "pr", url: PR_URL }), only("diff --git a/yarn.lock b/yarn.lock\n@@ -1 +1 @@\n+x")),
			/generated or binary/,
		);
		await assert.rejects(
			readCodeChange(request({ kind: "pr", url: PR_URL }), only(`diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n+${"x".repeat(200_001)}`)),
			/too large to import/,
		);
		await assert.rejects(readCodeChange(request({ kind: "pr", url: PR_URL }), only("")), /no file changes/);
	});
});

// ─── reading local commits ──────────────────────────────────────────────────

describe("reading local commits (git errors, mocked)", () => {
	const exists = path.join(TMP, "exists");
	before(() => fs.mkdirSync(exists, { recursive: true }));
	const sha = "a".repeat(40);
	/** A git that finds the repo and its commits, then fails the diff. */
	const failingDiff = (err: Error) => runners({
		run: async (_file, args) => {
			if (args.includes("--show-toplevel")) return `${exists}\n`;
			if (args.includes("--verify")) return `${sha}\n`;
			if (args.includes("--parents")) return `${sha} ${"b".repeat(40)}\n`;
			throw err;
		},
	});
	const git = () => request({ kind: "git", repoPath: exists, range: "" });

	it("maps a run that failed into words: too large, too slow, git's own message", async () => {
		await assert.rejects(
			readCodeChange(git(), failingDiff(new RunError("stdout maxBuffer length exceeded", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", ""))),
			(err: unknown) => err instanceof CodeChangeError && /too large to read/.test(err.message),
		);
		await assert.rejects(
			readCodeChange(git(), failingDiff(new RunError("", undefined, "", true))),
			/took too long/,
		);
		await assert.rejects(
			readCodeChange(git(), failingDiff(new RunError("\nfatal: bad object\nmore", 128, "fatal: bad object"))),
			{ message: "Git couldn't read that change: fatal: bad object" },
		);
	});

	it("says when git is missing or refuses the folder", async () => {
		await assert.rejects(readCodeChange(git(), runners({})), /Git isn't installed/);
		const dubious = runners({
			run: async () => {
				throw new RunError("fatal: detected dubious ownership in repository", 128, "");
			},
		});
		await assert.rejects(readCodeChange(git(), dubious), /safe\.directory/);
	});

	it("checks the folder before running anything", async () => {
		await assert.rejects(readCodeChange(request({ kind: "git", repoPath: "relative/repo" }), runners({})), /full path/);
		await assert.rejects(
			readCodeChange(request({ kind: "git", repoPath: path.join(TMP, "missing") }), runners({})),
			/doesn't exist/,
		);
	});
});

describe("reading local commits (a real repository)", () => {
	const repo = path.join(TMP, "demo");
	const hooks = path.join(TMP, "no-hooks");
	const sh: Record<string, string> = {};
	const g = (...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=Cairn Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
				"-c", "core.autocrlf=false", "-c", `core.hooksPath=${hooks}`, "-C", repo, ...args],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
	const write = (file: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		fs.writeFileSync(path.join(repo, file), text);
	};
	const commit = (name: string, message: string) => {
		g("add", "-A");
		g("commit", "-q", "--no-verify", "-m", message);
		sh[name] = g("rev-parse", "HEAD");
	};
	const short = (name: string) => sh[name]!.slice(0, 7);
	const read = (range: string, repoPath = repo) => readCodeChange(request({ kind: "git", repoPath, range }));

	before(() => {
		fs.mkdirSync(repo, { recursive: true });
		fs.mkdirSync(hooks, { recursive: true });
		g("init", "-q", "-b", "main");
		write("notes.md", "# Notes\n\nRetry only on server errors.\n");
		write("package-lock.json", "{}\n");
		commit("c1", "Start the notes");
		write("notes.md", "# Notes\n\nRetry only on server errors.\nStop after three tries.\n");
		write("src/fetch.ts", "export const retries = 3;\n");
		commit("c2", "Retry transient failures\n\nA 503 from the gateway is temporary; a 404 isn't.");
		write("café notes.md", "Accents survive.\n");
		commit("c3", "Add café notes");
		g("switch", "-q", "-c", "feature", sh.c2!);
		write("src/retry.ts", "export const backoffMs = 200;\n");
		commit("c4", "Back off between tries");
		g("switch", "-q", "--orphan", "other");
		write("other.md", "Unrelated.\n");
		commit("c5", "Unrelated root");
		g("switch", "-q", "main");
	});

	it("reads the root commit (no parent) with generated files left out", async () => {
		const change = await read(sh.c1!);
		assert.equal(change.label, `demo@${short("c1")}`);
		assert.deepEqual(change.files, ["notes.md"]);
		assert.deepEqual(change.skipped, ["package-lock.json"]);
		assert.ok(change.text.includes(`## Commits\n- ${short("c1")} Start the notes`));
		assert.ok(change.text.includes("diff --git a/notes.md b/notes.md\nnew file mode"));
		assert.ok(change.text.includes("+Retry only on server errors."));
	});

	it("reads the latest commit when the range is empty, from a subfolder too, accents intact", async () => {
		const change = await read("", path.join(repo, "src"));
		assert.equal(change.label, `demo@${short("c3")}`);
		assert.deepEqual(change.files, ["café notes.md"]);
		assert.ok(change.text.includes("diff --git a/café notes.md b/café notes.md"));
	});

	it("reads a range: commits oldest first with their bodies, every file changed", async () => {
		const change = await read("HEAD~2..HEAD");
		assert.equal(change.label, `demo@${short("c1")}..${short("c3")}`);
		assert.deepEqual([...change.files].sort(), ["café notes.md", "notes.md", "src/fetch.ts"]);
		const commits = change.text.slice(change.text.indexOf("## Commits"), change.text.indexOf("## Diff"));
		assert.ok(commits.indexOf(`- ${short("c2")} Retry transient failures`) < commits.indexOf(`- ${short("c3")} Add café notes`));
		assert.ok(commits.includes("  A 503 from the gateway is temporary; a 404 isn't."));
		assert.ok(!commits.includes("more commit"));
		const locate = sourceLocator(change.text);
		assert.equal(locate.hunkAt(change.text.indexOf("+Stop after three tries."))?.file, "notes.md");
	});

	it("reads a branch the way a pull request diffs it: from the merge base", async () => {
		const change = await read("main...feature");
		assert.equal(change.label, `demo@${short("c2")}..${short("c4")}`);
		assert.deepEqual(change.files, ["src/retry.ts"]);
		assert.ok(change.text.includes(`- ${short("c4")} Back off between tries`));
		assert.ok(!change.text.includes("Add café notes"));
	});

	it("says what's wrong: unrelated branches, unknown commits, an empty range, no repository", async () => {
		await assert.rejects(read("main...other"), { message: '"main" and "other" share no history.' });
		await assert.rejects(read("nope..HEAD"), { message: 'Git can\'t find the commit "nope" in that repository.' });
		await assert.rejects(read("HEAD..HEAD"), /no file changes/);
		const plain = path.join(TMP, "plain");
		fs.mkdirSync(plain, { recursive: true });
		const ceiling = process.env.GIT_CEILING_DIRECTORIES;
		process.env.GIT_CEILING_DIRECTORIES = TMP;
		try {
			await assert.rejects(read("", plain), /isn't inside a git repository/);
		} finally {
			if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
			else process.env.GIT_CEILING_DIRECTORIES = ceiling;
		}
	});

	describe("POST /api/graph/import/change", () => {
		type Route = typeof import("../app/api/graph/import/change/route.ts");
		type Server = typeof import("../src/server/index.ts");
		let POST: Route["POST"];
		let extraction: Server["extraction"];
		let original: Server["extraction"]["importNotes"];
		before(async () => {
			({ POST } = await import("../app/api/graph/import/change/route.ts"));
			({ extraction } = await import("../src/server/index.ts"));
			original = extraction.importNotes;
		});
		after(() => {
			extraction.importNotes = original;
		});
		const post = (body: unknown, headers: Record<string, string> = {}) =>
			POST(new Request("http://localhost/api/graph/import/change", {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: typeof body === "string" ? body : JSON.stringify(body),
			}));

		it("refuses cross-site requests, non-JSON bodies, and bodies it can't read", async () => {
			extraction.importNotes = async () => assert.fail("nothing is imported");
			const cross = await post({ kind: "git", repoPath: repo }, { "sec-fetch-site": "cross-site" });
			assert.equal(cross.status, 403);
			const plain = await post("kind=git", { "content-type": "text/plain" });
			assert.equal(plain.status, 415);
			const bad = await post({ kind: "pr", url: "https://example.com" });
			assert.equal(bad.status, 400);
			assert.match((await bad.json()).error, /pull request link/);
		});

		it("answers a change it can't read with ok:false and the reason", async () => {
			extraction.importNotes = async () => assert.fail("nothing is imported");
			const response = await post({ kind: "git", repoPath: path.join(TMP, "missing") }, { "sec-fetch-site": "same-origin" });
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { ok: false, outcome: "failed", error: "That folder doesn't exist." });
		});

		it("imports the change as a code-change source", async () => {
			let input: { filePath: string; text: string; kind?: string } | undefined;
			extraction.importNotes = async (got) => {
				input = got;
				return { nodes: 3, chains: 1 };
			};
			const response = await post({ kind: "git", repoPath: repo, range: "HEAD~1..HEAD" });
			const body = await response.json();
			assert.deepEqual(body, {
				ok: true,
				outcome: "completed",
				filePath: `demo@${short("c2")}..${short("c3")}`,
				files: ["café notes.md"],
				skipped: [],
				omitted: [],
				stats: { nodes: 3, chains: 1 },
			});
			assert.equal(input?.kind, "change");
			assert.equal(input?.filePath, body.filePath);
			assert.ok(input?.text.includes("## Diff\ndiff --git a/café notes.md b/café notes.md"));
		});

		it("passes the pipeline's refusals through: models missing, a busy source", async () => {
			const { ModelsNotConfiguredError } = await import("../src/core/settings.ts");
			const { NotesImportError } = await import("../src/agent/subagents/extraction.ts");
			extraction.importNotes = async () => {
				throw new ModelsNotConfiguredError(["cheap"]);
			};
			const models = await (await post({ kind: "git", repoPath: repo })).json();
			assert.equal(models.ok, false);
			assert.equal(models.code, "models_not_configured");
			assert.deepEqual(models.missing, ["cheap"]);
			assert.deepEqual(models.files, ["café notes.md"]);
			extraction.importNotes = async () => {
				throw new NotesImportError("busy", { nodes: 0, chains: 0 }, "This file is already being imported.");
			};
			const busy = await (await post({ kind: "git", repoPath: repo })).json();
			assert.equal(busy.outcome, "busy");
			assert.deepEqual(busy.stats, { nodes: 0, chains: 0 });
		});
	});
});
