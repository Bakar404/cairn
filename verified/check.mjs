// Proves Cairn's review rating, and checks that the app ships the proved
// rule. verified/README.md says what is proved and what is trusted.
//
//   node verified/check.mjs
//
// Five steps, and every one must pass:
//   1. Prove: Verus checks src/lib.rs against its spec.
//   2. Mutation check: one planted bug per clause, each rejected by Verus
//      on the clause it targets.
//   3. Build: cargo builds the crate to WebAssembly.
//   4. Test: review-rating.test.ts compares the app's reviewRating with the
//      module on every input class (D), and checks the review dates (T1, T2).
//   5. Negative control: D must fail against a mutant (M7) built the same way.
//
// VERUS is the verus binary (default: verus on PATH). RUSTUP_TOOLCHAIN
// defaults to rust-toolchain.toml's channel on this host. The receipt and
// the logs go to verified/target/, and in GitHub Actions the receipt is
// also the job summary.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const out = join(here, "target");
const logs = join(out, "logs");
const lib = join(here, "src", "lib.rs");
const source = readFileSync(lib, "utf8");
const verus = process.env.VERUS || "verus";
const tsx = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const testFile = join(here, "review-rating.test.ts");
const WASM_TARGET = "wasm32-unknown-unknown";
const wasm = join(out, "cairn_verified.wasm");
const m7Wasm = join(out, "cairn_verified_m7.wasm");

// One planted bug per requirement. Verus must reject each on its target clause.
const MUTANTS = [
	{
		id: "M1",
		target: "C1",
		bug: "a dismissed or unknown outcome counts as a miss",
		find: "return None;",
		replace: "return Some(Rating::Again);",
	},
	{
		id: "M2",
		target: "C2",
		bug: "an agreeing check still lowers the rating",
		find: "if !agrees {",
		replace: "if true {",
	},
	{
		id: "M3",
		target: "C3",
		bug: "the check keeps the better rating, so it can raise one",
		find: "if rank_of(&floor) < rank_of(&rating) {",
		replace: "if rank_of(&floor) > rank_of(&rating) {",
	},
	{
		id: "M4",
		target: "C4",
		bug: "a partial answer drops as far as a wrong one",
		find: "Judgment::Partial => Rating::Hard, _ => Rating::Again",
		replace: "Judgment::Partial => Rating::Again, _ => Rating::Again",
	},
	{
		id: "M5",
		target: "C5",
		bug: "a wrong or missing answer only drops to Hard",
		find: "Judgment::Partial => Rating::Hard, _ => Rating::Again",
		replace: "Judgment::Partial => Rating::Hard, _ => Rating::Hard",
	},
	{
		id: "M6",
		target: "C6",
		bug: "the careless-slip floor is forgotten",
		find: "if careless && rank_of(&rating) < rank_of(&Rating::Hard) {",
		replace: "if false && careless && rank_of(&rating) < rank_of(&Rating::Hard) {",
	},
	{
		id: "M7",
		target: "C7",
		bug: "the check is ignored when the tutor called the miss careless",
		find: "if !agrees {",
		replace: "if !agrees && !careless {",
	},
	{
		id: "M8",
		target: "C2",
		bug: "a solve at hint rung R2 counts as Good",
		// The code's arm, not the spec's: only the code is indented this deep.
		find: "                Rung::R2 => Rating::Hard,",
		replace: "                Rung::R2 => Rating::Good,",
	},
];

/** The source with one bug planted. The search text must occur exactly once. */
function mutate(text, mutant) {
	const normalized = text.replace(/\r\n/g, "\n");
	const first = normalized.indexOf(mutant.find);
	if (first < 0 || normalized.indexOf(mutant.find, first + 1) >= 0) {
		throw new Error(`${mutant.id}: its search text must occur exactly once in src/lib.rs: ${JSON.stringify(mutant.find)}`);
	}
	return normalized.slice(0, first) + mutant.replace + normalized.slice(first + mutant.find.length);
}

function run(log, command, args, { cwd = repo, env = {} } = {}) {
	const started = performance.now();
	const result = spawnSync(command, args, {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
	if (log) writeFileSync(join(logs, `${log}.log`), output);
	return { status: result.error ? null : result.status, output, seconds: (performance.now() - started) / 1000 };
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function sha256(file) {
	return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
}

function tail(text, lines) {
	return text.trimEnd().split(/\r?\n/).slice(-lines).map((line) => `        ${line}`).join("\n");
}

/** The toolchain Verus and cargo run on: rust-toolchain.toml's channel, for this host. */
function toolchain() {
	if (process.env.RUSTUP_TOOLCHAIN) return process.env.RUSTUP_TOOLCHAIN;
	const channel = readFileSync(join(here, "rust-toolchain.toml"), "utf8").match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
	const host = run(null, "rustup", ["show"]).output.match(/^Default host:\s*(\S+)/m)?.[1];
	if (!channel || !host) throw new Error("Couldn't work out the Rust toolchain. Install rustup, then run again.");
	return `${channel}-${host}`;
}

if (!existsSync(tsx)) {
	console.error("tsx isn't installed. Run npm ci first.");
	process.exit(1);
}
rmSync(logs, { recursive: true, force: true });
mkdirSync(logs, { recursive: true });
for (const stale of ["receipt.json", "test.json", "negative-control.json", "cairn_verified.wasm", "cairn_verified_m7.wasm"]) {
	rmSync(join(out, stale), { force: true });
}

const rust = { RUSTUP_TOOLCHAIN: toolchain() };
const steps = [];
function record(id, label, ok, detail, seconds, output) {
	steps.push({ id, label, ok, detail, seconds: Number(seconds.toFixed(1)) });
	console.log(`${ok ? "ok    " : "FAILED"}  ${label.padEnd(17)} ${seconds.toFixed(1).padStart(5)} s  ${detail}`);
	if (!ok && output) console.log(`${tail(output, 60)}\n        (full log: verified/target/logs/${id}.log)`);
}

const prove = (log, file, extra = []) => run(log, verus, [file, "--crate-type=lib", "--edition=2021", ...extra], { env: rust });
const scratch = mkdtempSync(join(tmpdir(), "cairn-verified-"));
const facts = {};
try {
	// ─── 1. Prove ────────────────────────────────────────────────────────
	const proof = prove("prove", lib);
	const summary = proof.output.match(/verification results:: (\d+) verified, (\d+) errors/);
	record(
		"prove",
		"Prove",
		proof.status === 0 && summary?.[2] === "0",
		summary ? `${summary[1]} verified, ${summary[2]} errors` : `no verification summary${proof.status === null ? ` (is VERUS set? tried ${verus})` : ""}`,
		proof.seconds,
		proof.output,
	);

	// ─── 2. Mutation check ───────────────────────────────────────────────
	const mutants = [];
	let seconds = 0;
	let mutationLog = "";
	for (const mutant of MUTANTS) {
		const text = mutate(source, mutant);
		const file = join(scratch, mutant.id, "lib.rs");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
		const result = prove(null, file, ["--multiple-errors", "20"]);
		seconds += result.seconds;
		// rustc shortens long source lines, so map each reported location
		// back to the clause tag on that line of the file Verus read.
		const lines = text.split("\n");
		const caughtBy = [
			...new Set(
				[...result.output.matchAll(/-->\s+.*lib\.rs:(\d+):\d+/g)]
					.map((m) => lines[Number(m[1]) - 1]?.match(/\/\/ (C\d+)\s*$/)?.[1])
					.filter(Boolean),
			),
		].sort();
		const ok = result.status !== null && result.status !== 0 && caughtBy.includes(mutant.target);
		mutants.push({ id: mutant.id, target: mutant.target, bug: mutant.bug, rejected: result.status !== 0, caughtBy, ok });
		mutationLog += `── ${mutant.id} (${mutant.bug}): ${ok ? "rejected" : "NOT CAUGHT"} by ${caughtBy.join(", ") || "nothing"}\n${result.output}\n`;
	}
	writeFileSync(join(logs, "mutation.log"), mutationLog);
	facts.mutants = mutants;
	const caught = mutants.filter((m) => m.ok).length;
	const missed = mutants.filter((m) => !m.ok).map((m) => `${m.id} -> ${m.target} (caught by ${m.caughtBy.join(", ") || "nothing"})`);
	record(
		"mutation",
		"Mutation check",
		caught === MUTANTS.length,
		`${caught} of ${MUTANTS.length} planted bugs rejected on their clause`,
		seconds,
		missed.join("\n"),
	);

	// ─── 3. Build to WebAssembly ─────────────────────────────────────────
	const build = run("build", "cargo", ["build", "--release", "--locked", "--target", WASM_TARGET], {
		cwd: here,
		env: { ...rust, CARGO_TARGET_DIR: out },
	});
	const built = join(out, WASM_TARGET, "release", "cairn_verified.wasm");
	const builtOk = build.status === 0 && existsSync(built);
	if (builtOk) copyFileSync(built, wasm);
	record("build", "Build to WASM", builtOk, builtOk ? `${readFileSync(wasm).length} bytes` : "the build failed", build.seconds, build.output);

	// ─── 4. Test D, T1, T2 against this checkout ─────────────────────────
	const testEnv = (wasmFile, resultsFile) => ({ NODE_ENV: "test", CAIRN_VERIFIED_WASM: wasmFile, CAIRN_VERIFIED_RESULTS: resultsFile });
	if (builtOk) {
		const test = run("test", process.execPath, [tsx, "--test", testFile], { env: testEnv(wasm, join(out, "test.json")) });
		const { differential: d, t1, t2 } = readJson(join(out, "test.json")) ?? {};
		Object.assign(facts, { differential: d, t1, t2 });
		const ok = test.status === 0 && d?.mismatches === 0 && t1?.violations === 0 && t2?.later === 0;
		const detail = [
			d ? `D: ${d.mismatches} of ${d.cases} inputs differ (${d.codeTuplesCovered} of ${d.codeDomain} classes)` : "D: no result",
			t1 ? `T1: ${t1.comparisons} comparisons, none later` : "T1: failed",
			t2 ? `T2: ${t2.later} of ${t2.pairs} later` : "T2: no result",
		].join("; ");
		record("test", "Test D, T1, T2", ok, detail, test.seconds, test.output);
	} else {
		record("test", "Test D, T1, T2", false, "skipped: no module to test", 0);
	}

	// ─── 5. Negative control: D must fail against M7 ─────────────────────
	// The mutant is its own crate (another name, so its module can't
	// overwrite the real one) and shares the build cache.
	const m7 = MUTANTS.find((m) => m.id === "M7");
	const m7Dir = join(scratch, "negative-control");
	mkdirSync(join(m7Dir, "src"), { recursive: true });
	const manifest = readFileSync(join(here, "Cargo.toml"), "utf8");
	const renamed = manifest.replace(/^name = "cairn-verified"(?=\r?$)/m, 'name = "cairn-verified-m7"');
	if (renamed === manifest) throw new Error('Cargo.toml must declare name = "cairn-verified"');
	writeFileSync(join(m7Dir, "Cargo.toml"), renamed);
	copyFileSync(join(here, "Cargo.lock"), join(m7Dir, "Cargo.lock"));
	writeFileSync(join(m7Dir, "src", "lib.rs"), mutate(source, m7));
	const m7Build = run("negative-control-build", "cargo", ["build", "--release", "--target", WASM_TARGET], {
		cwd: m7Dir,
		env: { ...rust, CARGO_TARGET_DIR: out },
	});
	const m7Built = join(out, WASM_TARGET, "release", "cairn_verified_m7.wasm");
	if (m7Build.status === 0 && existsSync(m7Built)) {
		copyFileSync(m7Built, m7Wasm);
		const control = run("negative-control", process.execPath, [tsx, "--test", "--test-name-pattern", "^D: ", testFile], {
			env: testEnv(m7Wasm, join(out, "negative-control.json")),
		});
		const d = readJson(join(out, "negative-control.json"))?.differential;
		facts.negativeControl = d ? { mismatches: d.mismatches, cases: d.cases } : null;
		const ok = control.status !== 0 && (d?.mismatches ?? 0) > 0;
		record(
			"negative-control",
			"Negative control",
			ok,
			ok ? `D failed against M7, as it must: ${d.mismatches} of ${d.cases} inputs differ` : "D did NOT fail against M7",
			m7Build.seconds + control.seconds,
			control.output,
		);
	} else {
		record("negative-control", "Negative control", false, "the M7 build failed", m7Build.seconds, m7Build.output);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

// ─── The receipt ─────────────────────────────────────────────────────────
const ok = steps.length === 5 && steps.every((s) => s.ok);
const receipt = {
	ok,
	finishedAt: new Date().toISOString(),
	commit: run(null, "git", ["rev-parse", "HEAD"]).output.trim().split("\n")[0] || null,
	tools: {
		verus: run(null, verus, ["--version"], { env: rust }).output.match(/Version:\s*(\S+)/)?.[1] ?? "unknown",
		rustc: run(null, "rustc", ["--version"], { env: rust }).output.trim() || "unknown",
		node: process.version,
		tsFsrs: readJson(join(repo, "node_modules", "ts-fsrs", "package.json"))?.version ?? "unknown",
	},
	sha256: {
		"verified/src/lib.rs": sha256(lib),
		"src/core/review-schedule.ts": sha256(join(repo, "src", "core", "review-schedule.ts")),
		"cairn_verified.wasm": sha256(wasm),
	},
	steps,
	...facts,
};
writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, "\t")}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
	const rows = steps.map((s) => `| ${s.ok ? "pass" : "**FAIL**"} | ${s.label} | ${s.detail} | ${s.seconds} s |`);
	const tools = receipt.tools;
	appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		[
			`### The review rating: ${ok ? "proved and checked" : "FAILED"}`,
			"",
			"| | Step | Result | Time |",
			"| --- | --- | --- | --- |",
			...rows,
			"",
			`Verus ${tools.verus}, ${tools.rustc}, Node ${tools.node}, ts-fsrs ${tools.tsFsrs}.`,
			`SHA-256: lib.rs \`${receipt.sha256["verified/src/lib.rs"]}\`, review-schedule.ts \`${receipt.sha256["src/core/review-schedule.ts"]}\`, WASM \`${receipt.sha256["cairn_verified.wasm"]}\`.`,
			"",
		].join("\n"),
	);
}

console.log(ok ? "\nPASS: the review rating is proved, and the app ships the proved rule." : "\nFAIL: see the steps above and verified/target/logs.");
process.exitCode = ok ? 0 : 1;
