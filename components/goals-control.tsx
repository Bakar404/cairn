"use client";

/**
 * The Goals picker (M21): a learner starting a teach session can set a
 * learning goal first: a Microsoft certification, whose skills outline
 * comes from its Microsoft Learn study guide, or the stack of a repository
 * on this computer, whose technologies come from its dependency manifests.
 * A pill in the composer's action row opens a popover; the chosen goal
 * rides the new chat's creation (POST /api/chats) as its goal-context
 * marker, so the tutor measures and plans across all of it.
 *
 * Nothing here is saved: the reads only preview, and the goal lives in
 * the composer's state until the session starts.
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { FolderGit2Icon, GraduationCapIcon, TargetIcon } from "lucide-react";
import { GoalOutline, goalSummary } from "@/components/goal-context-card";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
	CERTIFICATION_SUGGESTIONS,
	GOAL_LIMITS,
	isLearnUrl,
	parseLearningGoal,
	proposedTechnologies,
	REPO_CATEGORY_LABELS,
	REPO_MANIFESTS,
	repoGoal,
	type LearningGoal,
	type LearningGoalKind,
	type RepoScan,
	type RepoTechnology,
} from "@/src/core";

// ─── Transport ───────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** POST a JSON body; the answer's fields when it says ok, else its error thrown. */
async function postGoalRequest(url: string, body: unknown, fetchLike: typeof fetch): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetchLike(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		throw new Error("Couldn't reach Cairn's server.");
	}
	const parsed: unknown = await response.json().catch(() => null);
	const result = isRecord(parsed) ? parsed : {};
	if (result.ok === true) return result;
	throw new Error(typeof result.error === "string" && result.error ? result.error : `The request failed (HTTP ${response.status}).`);
}

/** A certification's skills outline, read from its study guide (POST /api/goals/certification). */
export async function postCertificationGoal(code: string, fetchLike: typeof fetch = fetch): Promise<LearningGoal> {
	const result = await postGoalRequest("/api/goals/certification", { code }, fetchLike);
	const goal = parseLearningGoal(result.goal);
	if (!goal || goal.kind !== "certification") throw new Error("The study guide came back in a shape Cairn can't read.");
	return goal;
}

const CATEGORIES = new Set(Object.keys(REPO_CATEGORY_LABELS));

function parseRepoScan(raw: unknown): RepoScan | null {
	if (!isRecord(raw) || typeof raw.path !== "string" || typeof raw.name !== "string") return null;
	if (!Array.isArray(raw.technologies) || !Array.isArray(raw.manifests)) return null;
	const technologies: RepoTechnology[] = [];
	for (const t of raw.technologies) {
		if (!isRecord(t) || typeof t.name !== "string" || !t.name || typeof t.category !== "string") return null;
		if (!CATEGORIES.has(t.category) || !Array.isArray(t.evidence) || typeof t.count !== "number") return null;
		const evidence = t.evidence.filter((e): e is string => typeof e === "string");
		technologies.push({ name: t.name, category: t.category as RepoTechnology["category"], evidence, count: t.count });
	}
	return {
		path: raw.path,
		name: raw.name,
		technologies,
		manifests: raw.manifests.filter((m): m is string => typeof m === "string"),
		partial: raw.partial === true,
	};
}

/** The technologies a local repository is built with (POST /api/goals/repo). */
export async function postRepoScan(repoPath: string, fetchLike: typeof fetch = fetch): Promise<RepoScan> {
	const result = await postGoalRequest("/api/goals/repo", { repoPath }, fetchLike);
	const scan = parseRepoScan(result.scan);
	if (!scan) throw new Error("The scan came back in a shape Cairn can't read.");
	return scan;
}

/** One read at a time per tab: a newer read makes an older answer stale, and stale answers are dropped. */
export interface GoalRead<T> {
	pending: boolean;
	error: string | null;
	value: T | null;
}

const IDLE = { pending: false, error: null, value: null } as const;

function useGoalRead<T>(): [GoalRead<T>, (request: () => Promise<T>) => Promise<T | null>] {
	const [state, setState] = useState<GoalRead<T>>(IDLE);
	const latest = useRef(0);
	const run = useCallback(async (request: () => Promise<T>) => {
		const id = ++latest.current;
		setState({ pending: true, error: null, value: null });
		try {
			const value = await request();
			if (id !== latest.current) return null;
			setState({ pending: false, error: null, value });
			return value;
		} catch (error) {
			if (id === latest.current) {
				setState({ pending: false, error: error instanceof Error ? error.message : String(error), value: null });
			}
			return null;
		}
	}, []);
	return [state, run];
}

// ─── The panel ───────────────────────────────────────────────────────────

function ReadStatus({ read, pendingText }: { read: GoalRead<unknown>; pendingText: string }) {
	if (read.pending) {
		return (
			<p role="status" className="text-[11px] leading-snug text-muted-foreground">
				{pendingText}
			</p>
		);
	}
	if (read.error) {
		return (
			<p role="alert" data-testid="goal-error" className="whitespace-pre-wrap break-words text-xs leading-snug text-danger">
				{read.error}
			</p>
		);
	}
	return null;
}

function CertificationPreview({ goal, onUse }: { goal: LearningGoal; onUse: (goal: LearningGoal) => void }) {
	return (
		<div data-testid="goal-preview" className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border/70 p-2.5 text-xs">
			<div>
				<div className="font-medium leading-snug">{goal.title}</div>
				<div className="text-[11px] text-muted-foreground">{goalSummary(goal)}</div>
			</div>
			{goal.note ? <p className="leading-snug text-warning">{goal.note}</p> : null}
			<div
				role="region"
				aria-label="Skills measured"
				tabIndex={0}
				className="max-h-56 overflow-y-auto rounded-md pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
			>
				<GoalOutline goal={goal} />
			</div>
			<p className="truncate text-[11px] text-muted-foreground">
				From{" "}
				{isLearnUrl(goal.source) ? (
					<a href={goal.source} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
						the study guide on Microsoft Learn
					</a>
				) : (
					goal.source
				)}
			</p>
			<Button type="button" size="sm" onClick={() => onUse(goal)} data-testid="goal-use">
				Use this goal
			</Button>
		</div>
	);
}

function RepoChoices({
	scan,
	chosen,
	onChosen,
	onUse,
}: {
	scan: RepoScan;
	chosen: readonly string[];
	onChosen: (names: string[]) => void;
	onUse: (goal: LearningGoal) => void;
}) {
	if (scan.technologies.length === 0) {
		return (
			<p data-testid="goal-repo-empty" className="text-xs leading-snug text-muted-foreground">
				Cairn found nothing it knows in {scan.name}. It reads dependency manifests ({REPO_MANIFESTS.join(", ")}) and a
				few telling files, such as a Dockerfile.
			</p>
		);
	}
	const full = chosen.length >= GOAL_LIMITS.areas;
	const goal = repoGoal(scan, scan.technologies.filter((t) => chosen.includes(t.name)));
	return (
		<div data-testid="goal-repo-list" className="flex flex-col gap-1.5 text-xs">
			<fieldset className="min-w-0">
				<legend className="mb-1 font-medium">Technologies in {scan.name}</legend>
				<ul className="max-h-56 overflow-y-auto pr-1">
					{scan.technologies.map((t) => {
						const checked = chosen.includes(t.name);
						return (
							<li key={t.name}>
								<label
									className={cn(
										"flex items-start gap-2 rounded-md px-1.5 py-1",
										!checked && full ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent/60",
									)}
								>
									<input
										type="checkbox"
										checked={checked}
										disabled={!checked && full}
										onChange={(e) =>
											onChosen(e.target.checked ? [...chosen, t.name] : chosen.filter((name) => name !== t.name))
										}
										data-testid={`goal-tech-${t.name}`}
										className="mt-0.5 size-3.5 shrink-0 accent-primary"
									/>
									<span className="min-w-0 flex-1">
										<span className="text-foreground">{t.name}</span>
										<span className="text-muted-foreground"> · {REPO_CATEGORY_LABELS[t.category]}</span>
										<span className="block truncate text-[11px] text-muted-foreground">
											{t.evidence[0]}
											{t.count > 1 ? ` +${t.count - 1}` : ""}
										</span>
									</span>
								</label>
							</li>
						);
					})}
				</ul>
			</fieldset>
			{scan.partial ? (
				<p className="leading-snug text-warning">The folder is large, so Cairn read only part of it.</p>
			) : null}
			<div className="flex items-center justify-between gap-2">
				<span className="text-[11px] text-muted-foreground" aria-live="polite">
					{chosen.length} of {scan.technologies.length} chosen{full ? `, ${GOAL_LIMITS.areas} at most` : ""}
				</span>
				<Button type="button" size="sm" disabled={!goal} onClick={() => goal && onUse(goal)} data-testid="goal-use">
					Use this goal
				</Button>
			</div>
		</div>
	);
}

/** The popover's body: pure props in, markup out (the SSR tests render it). */
export function GoalsPanel({
	tab,
	onTab,
	code,
	onCode,
	certification,
	onRead,
	repoPath,
	onRepoPath,
	repo,
	onScan,
	chosen,
	onChosen,
	onUse,
	firstFieldRef,
}: {
	tab: LearningGoalKind;
	onTab: (tab: LearningGoalKind) => void;
	code: string;
	onCode: (code: string) => void;
	certification: GoalRead<LearningGoal>;
	onRead: (code: string) => void;
	repoPath: string;
	onRepoPath: (path: string) => void;
	repo: GoalRead<RepoScan>;
	onScan: (path: string) => void;
	chosen: readonly string[];
	onChosen: (names: string[]) => void;
	onUse: (goal: LearningGoal) => void;
	firstFieldRef?: RefObject<HTMLInputElement | null>;
}) {
	const id = useId();
	const read = (e: FormEvent) => {
		e.preventDefault();
		if (code.trim() && !certification.pending) onRead(code.trim());
	};
	const scan = (e: FormEvent) => {
		e.preventDefault();
		if (repoPath.trim() && !repo.pending) onScan(repoPath.trim());
	};
	const tabButton = (value: LearningGoalKind, label: string) => (
		<button
			type="button"
			aria-pressed={tab === value}
			onClick={() => onTab(value)}
			data-testid={`goal-tab-${value}`}
			className={cn(
				"h-7 flex-1 rounded-md px-2 text-xs transition-colors",
				tab === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
			)}
		>
			{label}
		</button>
	);
	return (
		<div role="dialog" aria-label="Set a learning goal" data-testid="goals-panel" className="flex flex-col gap-2.5">
			<div className="flex gap-1 rounded-lg border p-0.5">
				{tabButton("certification", "Certification")}
				{tabButton("repo", "This repo")}
			</div>
			{tab === "certification" ? (
				<>
					<form onSubmit={read} className="flex flex-col gap-1">
						<label htmlFor={`${id}-code`} className="text-xs font-medium">
							Exam code
						</label>
						<div className="flex gap-1.5">
							<Input
								id={`${id}-code`}
								ref={firstFieldRef}
								value={code}
								onChange={(e) => onCode(e.target.value)}
								placeholder="AZ-104"
								aria-describedby={`${id}-code-hint`}
								spellCheck={false}
								autoComplete="off"
								className="h-8 font-mono text-xs md:text-xs"
							/>
							<Button type="submit" size="sm" disabled={!code.trim() || certification.pending} data-testid="goal-read">
								{certification.pending ? "Reading…" : "Read"}
							</Button>
						</div>
						<p id={`${id}-code-hint`} className="text-[11px] leading-snug text-muted-foreground">
							Any Microsoft certification with a study guide on Microsoft Learn.
						</p>
					</form>
					<div role="group" aria-label="Suggested certifications" className="flex flex-wrap gap-1">
						{CERTIFICATION_SUGGESTIONS.map((s) => (
							<Hint key={s.code} label={s.title}>
								<button
									type="button"
									aria-label={`${s.code.toUpperCase()}: ${s.title}`}
									disabled={certification.pending}
									onClick={() => {
										onCode(s.code.toUpperCase());
										onRead(s.code);
									}}
									className="cursor-pointer rounded-full border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
								>
									{s.code.toUpperCase()}
								</button>
							</Hint>
						))}
					</div>
					<ReadStatus read={certification} pendingText="Reading the study guide on Microsoft Learn…" />
					{certification.value ? <CertificationPreview goal={certification.value} onUse={onUse} /> : null}
				</>
			) : (
				<>
					<form onSubmit={scan} className="flex flex-col gap-1">
						<label htmlFor={`${id}-repo`} className="text-xs font-medium">
							Repository folder
						</label>
						<div className="flex gap-1.5">
							<Input
								id={`${id}-repo`}
								ref={firstFieldRef}
								value={repoPath}
								onChange={(e) => onRepoPath(e.target.value)}
								placeholder="Full path to a folder on this computer"
								aria-describedby={`${id}-repo-hint`}
								spellCheck={false}
								autoComplete="off"
								className="h-8 text-xs md:text-xs"
							/>
							<Button type="submit" size="sm" disabled={!repoPath.trim() || repo.pending} data-testid="goal-scan">
								{repo.pending ? "Scanning…" : "Scan"}
							</Button>
						</div>
						<p id={`${id}-repo-hint`} className="text-[11px] leading-snug text-muted-foreground">
							Cairn reads its dependency manifests and file names here, on this computer. Only the technologies you
							choose go to the tutor.
						</p>
					</form>
					<ReadStatus read={repo} pendingText="Reading the project's manifests…" />
					{repo.value ? <RepoChoices scan={repo.value} chosen={chosen} onChosen={onChosen} onUse={onUse} /> : null}
				</>
			)}
		</div>
	);
}

// ─── The pill ────────────────────────────────────────────────────────────

const KIND_ICONS = { certification: GraduationCapIcon, repo: FolderGit2Icon } as const;

/** The composer row's goal pill and its popover. The goal itself lives with the composer. */
export function GoalsControl({
	goal,
	onGoal,
}: {
	goal: LearningGoal | null;
	onGoal: (goal: LearningGoal | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<LearningGoalKind>("certification");
	const [code, setCode] = useState("");
	const [repoPath, setRepoPath] = useState("");
	const [certification, readCertification] = useGoalRead<LearningGoal>();
	const [repo, readRepo] = useGoalRead<RepoScan>();
	const [chosen, setChosen] = useState<string[]>([]);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const firstFieldRef = useRef<HTMLInputElement>(null);
	const close = useCallback(() => {
		// Focus returns to the pill only when it was inside the panel; a
		// click elsewhere keeps its own focus.
		if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
		setOpen(false);
	}, []);
	usePopoverDismiss(rootRef, open, close);
	useEffect(() => {
		if (open) firstFieldRef.current?.focus();
	}, [open, tab]);
	const toggle = () => {
		if (!open && goal) setTab(goal.kind);
		setOpen((o) => !o);
	};
	const scan = async (path: string) => {
		const result = await readRepo(() => postRepoScan(path));
		if (result) setChosen(proposedTechnologies(result.technologies));
	};
	const use = (next: LearningGoal) => {
		// The composer takes focus (onGoal); the panel closes under it.
		setOpen(false);
		onGoal(next);
	};
	const Icon = goal ? KIND_ICONS[goal.kind] : TargetIcon;
	return (
		<div ref={rootRef} className="relative flex min-w-0 items-center gap-1.5">
			<button
				ref={triggerRef}
				type="button"
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={goal ? `Learning goal: ${goal.title}` : undefined}
				onClick={toggle}
				data-testid="goal-chip"
				className={cn(
					"flex min-w-0 max-w-[18rem] cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors",
					goal
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
				)}
			>
				<Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate">{goal ? goal.title : "Set a goal"}</span>
			</button>
			{goal && (
				<button
					type="button"
					data-testid="goal-clear"
					aria-label="Clear the goal"
					onClick={() => {
						onGoal(null);
						triggerRef.current?.focus();
					}}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
			{open && (
				<div className="absolute bottom-full left-0 z-20 mb-2 max-h-[min(36rem,calc(100dvh-12rem))] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card/95 p-2.5 shadow-lg backdrop-blur">
					<GoalsPanel
						tab={tab}
						onTab={setTab}
						code={code}
						onCode={setCode}
						certification={certification}
						onRead={(value) => void readCertification(() => postCertificationGoal(value))}
						repoPath={repoPath}
						onRepoPath={setRepoPath}
						repo={repo}
						onScan={(path) => void scan(path)}
						chosen={chosen}
						onChosen={setChosen}
						onUse={use}
						firstFieldRef={firstFieldRef}
					/>
				</div>
			)}
		</div>
	);
}
