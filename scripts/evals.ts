/**
 * The doctrine evals (M23): is the tutor still keeping its teaching laws?
 *
 * Grading mode, the default and the CI step, grades the recorded transcripts
 * in evals/transcripts/ with the doctrine graders (src/core/doctrine-graders.ts).
 * No model, no network, no data folder. Exits 1 when a transcript breaks a law.
 *
 *   npm run evals [-- --dir <folder>]
 *
 * Live mode plays each synthetic learner (src/core/synthetic-learners.ts)
 * through a practice session against real tutor models over GitHub Copilot,
 * then grades the sessions. It runs in a throwaway data folder, never the
 * learner's library, and spends Copilot requests.
 *
 *   npm run evals -- --live --model <id>[,<id>...] [--learners <kinds>]
 *       [--checker <id>] [--rubric] [--out <folder>] [--record]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RubricScores } from "../src/agent/subagents/tutor-rubric.ts";
import type { PracticeAssessment } from "../src/core/contracts/chat.ts";
import { gradeTranscript, transcriptOutline, transcriptPasses, type GraderResult } from "../src/core/doctrine-graders.ts";
import type { GraphContextPick, LhMessage } from "../src/core/native-messages.ts";
import type { UserSettings } from "../src/core/settings.ts";
import { LEARNER_KINDS, syntheticLearner, type LearnerKind } from "../src/core/synthetic-learners.ts";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TRANSCRIPTS_DIR = path.join(REPO_ROOT, "evals", "transcripts");
export const RECORD_VERSION = 1;

const USAGE = `usage:
  npm run evals [-- --dir <folder>]
      Grade the recorded transcripts (default evals/transcripts) with the doctrine graders.
  npm run evals -- --live --model <id>[,<id>...] [options]
      Play the synthetic learners against each tutor model over GitHub Copilot.
      Spends Copilot requests. Without --model, lists the models you can use.
      --learners <kinds>  ${LEARNER_KINDS.join(",")} (default: all)
      --checker <id>      the answer check's and the rubric's model (default: the first --model)
      --rubric            also score each session 1 to 5 on diagnosis, hints, feedback and pacing
      --out <folder>      where to write the session files (default: a new temporary folder)
      --record            also copy every session that finished into evals/transcripts`;

// ─── recorded transcripts ───────────────────────────────────────────────────

export interface RecordedModel {
	provider: string;
	id: string;
}

/** One session as evals/transcripts keeps it. */
export interface RecordedSession {
	version: typeof RECORD_VERSION;
	learner: LearnerKind;
	/** The tutor. */
	model: RecordedModel;
	/** The answer check's (and the rubric's) model. */
	checker?: RecordedModel;
	recordedAt: string;
	messages: LhMessage[];
	assessments: PracticeAssessment[];
	/** Why the live session did not finish cleanly. */
	error?: string;
	rubric?: { scores: RubricScores; summary: string; model?: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isModel = (v: unknown): v is RecordedModel => isRecord(v) && typeof v.provider === "string" && typeof v.id === "string";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Check one transcript file's shape. The graders read the messages. */
export function parseRecorded(text: string, file: string): { ok: true; session: RecordedSession } | { ok: false; error: string } {
	const bad = (why: string) => ({ ok: false as const, error: `${file}: ${why}` });
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return bad(`not JSON (${errorText(error)})`);
	}
	if (!isRecord(raw)) return bad("not a JSON object");
	if (raw.version !== RECORD_VERSION) return bad(`version must be ${RECORD_VERSION}`);
	if (typeof raw.learner !== "string" || !(LEARNER_KINDS as readonly string[]).includes(raw.learner)) {
		return bad(`learner must be one of ${LEARNER_KINDS.join(", ")}`);
	}
	if (!isModel(raw.model)) return bad("model must be { provider, id }");
	if (raw.checker !== undefined && !isModel(raw.checker)) return bad("checker must be { provider, id }");
	if (!Array.isArray(raw.messages)) return bad("messages must be an array");
	if (!raw.messages.every((m) => isRecord(m) && typeof m.role === "string")) return bad("every message needs a role");
	if (raw.assessments !== undefined && !Array.isArray(raw.assessments)) return bad("assessments must be an array");
	if (raw.error !== undefined && typeof raw.error !== "string") return bad("error must be a string");
	return { ok: true, session: { ...raw, assessments: raw.assessments ?? [] } as unknown as RecordedSession };
}

export interface GradedRecording {
	file: string;
	session: RecordedSession;
	results: GraderResult[];
}

/** Grade every *.json transcript in a folder, in name order. */
export function gradeRecordedDir(dir: string): { rows: GradedRecording[]; errors: string[] } {
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch (error) {
		return { rows: [], errors: [`cannot read ${dir}: ${errorText(error)}`] };
	}
	const rows: GradedRecording[] = [];
	const errors: string[] = [];
	for (const file of names) {
		let text: string;
		try {
			text = fs.readFileSync(path.join(dir, file), "utf8");
		} catch (error) {
			errors.push(`${file}: cannot read (${errorText(error)})`);
			continue;
		}
		const parsed = parseRecorded(text, file);
		if (!parsed.ok) {
			errors.push(parsed.error);
			continue;
		}
		try {
			const { messages, assessments } = parsed.session;
			rows.push({ file, session: parsed.session, results: gradeTranscript(messages, { assessments }) });
		} catch (error) {
			errors.push(`${file}: the graders could not read it (${errorText(error)})`);
		}
	}
	return { rows, errors };
}

// ─── the report ─────────────────────────────────────────────────────────────

/** Typographic characters in plain ASCII, so any terminal shows the report. */
export function ascii(text: string): string {
	return text
		.replace(/\u2026/g, "...")
		.replace(/[\u2018\u2019\u02BC]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/\u2014/g, "--")
		.replace(/[\u2013\u2212]/g, "-")
		.replace(/\u00A0/g, " ");
}

const verdictOf = (r: GraderResult) => (!r.pass ? "FAIL" : r.applicable ? "pass" : "n/a ");

/** Every transcript's graders, findings and notes, then the total. */
export function formatReport(rows: readonly GradedRecording[], errors: readonly string[]): string {
	const lines: string[] = [];
	for (const row of rows) {
		const { session } = row;
		lines.push(
			`${row.file}: ${session.learner} learner, tutor ${session.model.provider}/${session.model.id}: ${transcriptPasses(row.results) ? "PASS" : "FAIL"}`,
		);
		for (const result of row.results) {
			lines.push(`  ${verdictOf(result)}  ${result.title} (${result.id})`);
			for (const finding of result.findings) lines.push(`          [${finding.at}] ${finding.evidence}`);
		}
		if (session.error) lines.push(`  note: ${session.error}`);
		lines.push("");
	}
	for (const error of errors) lines.push(`error: ${error}`);
	if (errors.length > 0) lines.push("");
	const passed = rows.filter((row) => transcriptPasses(row.results)).length;
	const total = `${rows.length} transcript${rows.length === 1 ? "" : "s"}: ${passed} passed, ${rows.length - passed} failed`;
	lines.push(errors.length > 0 ? `${total}; ${errors.length} could not be graded.` : `${total}.`);
	return ascii(lines.join("\n"));
}

// ─── arguments ──────────────────────────────────────────────────────────────

export interface EvalArgs {
	help: boolean;
	live: boolean;
	/** Grading mode's folder. */
	dir?: string;
	/** Live mode's tutor models. */
	models: string[];
	learners: LearnerKind[];
	checker?: string;
	rubric: boolean;
	record: boolean;
	out?: string;
}

const VALUE_FLAGS = new Set(["--dir", "--model", "--models", "--learners", "--checker", "--out"]);
const SWITCHES = new Set(["--help", "-h", "--live", "--rubric", "--record"]);
const LIVE_ONLY = ["--model", "--models", "--learners", "--checker", "--rubric", "--record", "--out"];

const listOf = (value: string) => value.split(",").map((part) => part.trim()).filter(Boolean);

export function parseArgs(argv: readonly string[]): { ok: true; args: EvalArgs } | { ok: false; error: string } {
	const args: EvalArgs = { help: false, live: false, models: [], learners: [...LEARNER_KINDS], rubric: false, record: false };
	const seen = new Set<string>();
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index]!;
		const eq = token.startsWith("--") ? token.indexOf("=") : -1;
		const flag = eq > 0 ? token.slice(0, eq) : token;
		if (SWITCHES.has(flag)) {
			if (eq > 0) return { ok: false, error: `${flag} takes no value` };
			seen.add(flag);
			if (flag === "--help" || flag === "-h") args.help = true;
			else if (flag === "--live") args.live = true;
			else if (flag === "--rubric") args.rubric = true;
			else args.record = true;
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) {
			return { ok: false, error: flag.startsWith("-") ? `unknown option ${flag}` : `unexpected argument "${token}"` };
		}
		const value = eq > 0 ? token.slice(eq + 1) : argv[++index];
		if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) return { ok: false, error: `${flag} needs a value` };
		seen.add(flag);
		if (flag === "--dir") args.dir = value;
		else if (flag === "--out") args.out = value;
		else if (flag === "--checker") args.checker = value;
		else if (flag === "--model" || flag === "--models") args.models.push(...listOf(value));
		else {
			const kinds = listOf(value);
			const unknown = kinds.find((kind) => !(LEARNER_KINDS as readonly string[]).includes(kind));
			if (unknown !== undefined) return { ok: false, error: `unknown learner "${unknown}" (one of ${LEARNER_KINDS.join(", ")})` };
			if (kinds.length === 0) return { ok: false, error: "--learners needs at least one learner" };
			args.learners = [...new Set(kinds as LearnerKind[])];
		}
	}
	if (!args.live) {
		const liveOnly = LIVE_ONLY.find((flag) => seen.has(flag));
		if (liveOnly) return { ok: false, error: `${liveOnly} needs --live` };
	} else if (seen.has("--dir")) {
		return { ok: false, error: "--dir grades recorded transcripts; it cannot be combined with --live" };
	}
	args.models = [...new Set(args.models)];
	return { ok: true, args };
}

// ─── live mode ──────────────────────────────────────────────────────────────

/** The propositions every live session practices: quantitative, so the
 *  tutor has numbers to pose problems with. */
const EVAL_PICKS: readonly GraphContextPick[] = [
	{
		id: "n_eval_bayes",
		name: "Bayes' theorem",
		statement:
			"The probability of a hypothesis given evidence is the probability of the evidence given the hypothesis, times the prior probability of the hypothesis, divided by the overall probability of the evidence.",
	},
	{
		id: "n_eval_pigeonhole",
		name: "Pigeonhole principle",
		statement: "If N items go into k boxes, some box holds at least the ceiling of N divided by k items; so with more items than boxes, some box holds two or more.",
	},
	{
		id: "n_eval_inclusion_exclusion",
		name: "Inclusion-exclusion principle",
		statement:
			"The size of a union of finite sets is the sum of their sizes, minus the sizes of every pairwise intersection, plus the sizes of every triple intersection, and so on with alternating signs.",
	},
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const sessionFileName = (learner: LearnerKind, modelId: string) =>
	`${learner}-${modelId.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;

/** The tutor's own tokens: every model reply, not the app's synthetic ones. */
function tutorTokens(messages: readonly LhMessage[]): { input: number; output: number } {
	let input = 0;
	let output = 0;
	for (const m of messages) {
		const reply = m as { role?: string; provider?: string; usage?: { input?: unknown; output?: unknown } };
		if (reply.role !== "assistant" || reply.provider === "synthetic") continue;
		if (typeof reply.usage?.input === "number") input += reply.usage.input;
		if (typeof reply.usage?.output === "number") output += reply.usage.output;
	}
	return { input, output };
}

async function live(args: EvalArgs): Promise<number> {
	if (process.env.NODE_ENV === "test") {
		console.error("evals --live does not run under NODE_ENV=test: it spends real Copilot requests");
		return 2;
	}
	// Before anything reads config.ts: every record this run makes lands in
	// a throwaway folder, never the learner's library.
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-evals-data-"));
	process.env.LH_DATA_DIR = dataDir;
	let stopRuntime: (() => Promise<void>) | undefined;
	try {
		const { PATHS } = await import("../config.ts");
		if (path.resolve(PATHS.data) !== path.resolve(dataDir) || path.resolve(PATHS.library) !== path.resolve(dataDir)) {
			console.error(`refusing to run: the data folder resolved to ${PATHS.library}, not the throwaway ${dataDir}`);
			return 1;
		}
		const { copilotModels, copilotRuntime, refreshCopilot } = await import("../src/agent/copilot/runtime.ts");
		const { COPILOT_PROVIDER } = await import("../src/agent/copilot/catalog.ts");
		const { CURRENT_SETTINGS_VERSION } = await import("../src/core/settings.ts");
		const { resolveRoleSpec } = await import("../src/core/settings-resolution.ts");
		const { piEngineForSpec } = await import("../src/agent/models.ts");
		const { stores } = await import("../src/server/stores.ts");
		const { runEvalSession } = await import("../src/server/practice-evals.ts");
		const { runTutorRubric, RUBRIC_CRITERIA } = await import("../src/agent/subagents/tutor-rubric.ts");

		console.log("Starting GitHub Copilot...");
		const status = await refreshCopilot({ force: true });
		if (status.state !== "unavailable") stopRuntime = async () => (await copilotRuntime()).stop();
		if (status.state !== "signed-in") {
			console.error(`GitHub Copilot is ${status.state}${"message" in status && status.message ? `: ${status.message}` : ""}.`);
			console.error("Sign in with the Copilot CLI, or set COPILOT_GITHUB_TOKEN to a token with Copilot access.");
			return 1;
		}
		const available = copilotModels().map((m) => m.id);
		const unknown = args.models.filter((id) => !available.includes(id));
		if (args.checker !== undefined && !available.includes(args.checker)) unknown.push(args.checker);
		if (args.models.length === 0 || unknown.length > 0) {
			if (unknown.length > 0) console.error(`Not in your Copilot models: ${unknown.join(", ")}`);
			else console.error("Name the tutor model(s) with --model.");
			console.error(`Your models: ${available.join(", ") || "(none)"}`);
			return 2;
		}
		const checker = args.checker ?? args.models[0]!;
		const copilot = (id: string) => ({ provider: COPILOT_PROVIDER, id });

		const outDir = args.out ? path.resolve(args.out) : fs.mkdtempSync(path.join(os.tmpdir(), "cairn-evals-"));
		fs.mkdirSync(outDir, { recursive: true });
		const createdAt = new Date().toISOString();
		for (const pick of EVAL_PICKS) stores.graphStore.appendNode({ ...pick, aliases: [], createdAt, provenance: [] });

		const rows: GradedRecording[] = [];
		const summary: string[] = [];
		let clean = true;
		for (const tutor of args.models) {
			const settings: UserSettings = {
				version: CURRENT_SETTINGS_VERSION,
				models: { strong: { model: copilot(tutor) }, cheap: { model: copilot(checker) }, vision: { model: copilot(tutor) } },
			};
			stores.settingsStore.writeSettings(settings);
			console.log(`Tutor ${tutor} (checker ${checker})`);
			const sums = { sessions: 0, passed: 0, errors: 0, findings: 0, input: 0, output: 0 };
			const rubricTotals = new Map<string, number>();
			let rubrics = 0;
			for (const kind of args.learners) {
				const started = Date.now();
				const session = await runEvalSession({
					learner: syntheticLearner(kind),
					model: copilot(tutor),
					picks: EVAL_PICKS,
					title: `Eval: ${kind} learner, ${tutor}`,
				});
				const passes = transcriptPasses(session.results);
				const findings = session.results.reduce((n, r) => n + r.findings.length, 0);
				const failing = session.results.filter((r) => !r.pass).map((r) => r.id);
				const seconds = Math.round((Date.now() - started) / 1000);
				console.log(
					ascii(
						`  ${kind} learner: ${passes ? "PASS" : `FAIL (${failing.join(", ")})`}${session.error ? `; error: ${session.error}` : ""} [${seconds}s]`,
					),
				);
				const recorded: RecordedSession = {
					version: RECORD_VERSION,
					learner: kind,
					model: copilot(tutor),
					checker: copilot(checker),
					recordedAt: new Date().toISOString(),
					messages: session.messages,
					assessments: session.assessments,
					...(session.error ? { error: session.error } : {}),
				};
				if (args.rubric) {
					try {
						const spec = resolveRoleSpec("assessor", stores.settingsStore.readSettings());
						if (!spec) throw new Error("no checker model is configured");
						const judged = await runTutorRubric(transcriptOutline(session.messages), {
							engine: piEngineForSpec(spec),
							chatId: session.chatId,
						});
						recorded.rubric = { scores: judged.scores, summary: judged.summary, ...(judged.model ? { model: judged.model } : {}) };
						rubrics++;
						for (const criterion of RUBRIC_CRITERIA) {
							rubricTotals.set(criterion, (rubricTotals.get(criterion) ?? 0) + judged.scores[criterion]);
						}
						console.log(ascii(`    rubric: ${RUBRIC_CRITERIA.map((c) => `${c} ${judged.scores[c]}`).join(", ")}. ${judged.summary}`));
					} catch (error) {
						console.log(ascii(`    rubric: not scored (${errorText(error)})`));
					}
				}
				const file = sessionFileName(kind, tutor);
				const text = `${JSON.stringify(recorded, null, "\t")}\n`;
				fs.writeFileSync(path.join(outDir, file), text);
				if (args.record && !session.error) {
					fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
					fs.writeFileSync(path.join(TRANSCRIPTS_DIR, file), text);
					if (!passes) console.log(`    recorded ${file}, which fails: npm run evals (and CI) fail until it is fixed or removed`);
				}
				rows.push({ file, session: recorded, results: session.results });
				const tokens = tutorTokens(session.messages);
				sums.sessions++;
				if (passes) sums.passed++;
				if (session.error) sums.errors++;
				sums.findings += findings;
				sums.input += tokens.input;
				sums.output += tokens.output;
				if (!passes || session.error) clean = false;
			}
			const means = rubrics > 0
				? `; rubric means ${RUBRIC_CRITERIA.map((c) => `${c} ${((rubricTotals.get(c) ?? 0) / rubrics).toFixed(1)}`).join(", ")}`
				: "";
			summary.push(
				`  ${tutor}: ${sums.sessions} sessions, ${sums.passed} passed, ${sums.sessions - sums.passed} failed, ${sums.errors} with errors; ${sums.findings} findings; tutor tokens ${sums.input.toLocaleString("en-US")} in, ${sums.output.toLocaleString("en-US")} out${means}`,
			);
		}

		console.log("");
		console.log(formatReport(rows, []));
		console.log("");
		console.log("Summary");
		for (const line of summary) console.log(line);
		console.log(`Session files: ${outDir}`);
		if (args.record) console.log(`Recorded into: ${TRANSCRIPTS_DIR}`);
		return clean ? 0 : 1;
	} finally {
		if (stopRuntime) await Promise.race([stopRuntime().catch(() => undefined), sleep(10_000)]);
		try {
			fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch {
			console.error(`Could not remove the throwaway data folder ${dataDir}; delete it by hand.`);
		}
	}
}

// ─── entry ──────────────────────────────────────────────────────────────────

export async function main(argv: readonly string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		console.error(parsed.error);
		console.error(USAGE);
		return 2;
	}
	const { args } = parsed;
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	if (args.live) return live(args);
	const dir = path.resolve(args.dir ?? TRANSCRIPTS_DIR);
	const { rows, errors } = gradeRecordedDir(dir);
	if (rows.length === 0 && errors.length === 0) errors.push(`no transcripts (*.json) in ${dir}`);
	console.log(`Doctrine evals: ${path.relative(process.cwd(), dir) || "."}\n`);
	console.log(formatReport(rows, errors));
	return errors.length === 0 && rows.every((row) => transcriptPasses(row.results)) ? 0 : 1;
}

const invokedAsCli = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsCli) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
			// A live run's Copilot child process and server timers can hold the
			// event loop open after the work is done.
			setTimeout(() => process.exit(code), 2_000).unref();
		},
		(error: unknown) => {
			console.error(error);
			process.exit(1);
		},
	);
}
