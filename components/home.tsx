"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeftIcon, DumbbellIcon } from "lucide-react";
import { GraphView } from "@/components/graph-view";
import { MinimalHome } from "@/components/minimal-home";
import { SetupDialog } from "@/components/setup-dialog";
import { ComposerActions, NodePickerControl } from "@/components/composer-actions";
import { GoalsControl } from "@/components/goals-control";
import { ReviewQueueControl } from "@/components/review-queue-control";
import { useStrongKeyless, useZeroKeys, ZeroKeysPill } from "@/components/setup-cta";
import { useFieldCycle } from "@/components/field-cycle";
import { SidebarToggle } from "@/components/sidebar";
import { StatsBar } from "@/components/stats-bar";
import { goalOpening, type GraphContextPick, type LearningGoal, type TurnUsage } from "@/src/core";

/**
 * Home — the knowledge graph is the main view, full-bleed edge to edge
 * (owner, graph-view round 1): the canvas owns the whole column, running
 * under the header and the new-session dock, both of which float over it
 * with no gradient scrims. Sessions live in the toggleable sidebar.
 */
export function Home({
	initialConfigured,
	rendering = true,
}: {
	initialConfigured: boolean;
	/** GRAPH RENDERING off (owner, 2026-10-06): the home's main view is
	 * the chains view, not the canvas. Read server-side per navigation —
	 * changing the setting applies on the next visit home. */
	rendering?: boolean;
}) {
	const router = useRouter();
	const [topic, setTopic] = useState("");
	/* The topic MIRROR ("nothing gets lost" round, 2026-10-01 — same
	 * mechanics as the chat composer, owner's consistency ruling): begin()
	 * reads the ref, never a stale state closure. Kept current at every
	 * write. */
	const topicRef = useRef("");
	// First-run gate (model-slots wave, owner 2026-09-20): chats cannot
	// start until the user has picked all three slots — no defaults for
	// 33 providers. The dock shows the CTA while unconfigured; submitting
	// a topic opens the setup dialog WITH THE DRAFT PRESERVED (Save
	// stores the slots and the queued message sends).
	const [configured, setConfigured] = useState(initialConfigured);
	// The zero-keys truth (zero-keys wave): no provider key = the pill
	// takes precedence over the models CTA (keys come first in the chain).
	const zeroKeys = useZeroKeys();
	// The strong slot's keyless truth (pre-send key guards, owner interlude
	// 2026-09-25): keys may exist generally while the STRONG slot's pinned
	// provider has none — the same skip-everything treatment on send.
	const strongKeyless = useStrongKeyless();
	const [setupOpen, setSetupOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const topicInputRef = useRef<HTMLTextAreaElement>(null);
	// F6 navigates INTO the topic composer (the owner's 2026-10-06 Tab
	// cycle, on F6 since M27): the only text field on this surface — and home's
	// composer is its OWN textarea, not the shared Composer component,
	// so the chain is the ref itself (the smoke caught a selector that
	// matched nothing here).
	const cycleTopicField = useCallback(
		(): readonly HTMLElement[] => (topicInputRef.current ? [topicInputRef.current] : []),
		[],
	);
	useFieldCycle(cycleTopicField);

	/* PRACTICE MODE (owner, 2026-10-04): the graph composer's teach |
	 *  practice switch — practice creates a kind:"practice" session and
	 *  may carry proposition picks from the chain table (the chip above
	 *  the composer opens the picker; the picks seed the opening prompt).
	 *  Not enforcing any input format — the picks are a convenience. */
	const [mode, setMode] = useState<"teach" | "practice">("teach");
	const [practiceProps, setPracticeProps] = useState<{ id: string; name: string; statement: string }[]>([]);
	const [chainSelectOpen, setChainSelectOpen] = useState(false);
	// The chain table is CONTROLLED off this id set (the lifted pick).
	const pickedIds = useMemo(() => new Set(practiceProps.map((p) => p.id)), [practiceProps]);
	/* THE LEARNING GOAL (M21): teach mode only. A certification's skills
	 *  or a repository's stack, set from the Goals pill; it rides the
	 *  creation as the goal-context marker, and with the composer empty
	 *  the goal alone starts the session. */
	const [goal, setGoal] = useState<LearningGoal | null>(null);

	/* One creation path for every start (M20): the composer's begin() and
	 * the review queue's starts. The setup/key guards run first, so no
	 * start can leave an orphan chat behind. */
	const startSession = async ({
		kind,
		title,
		prompt,
		picks,
		goal: sessionGoal,
	}: {
		kind: "teach" | "practice";
		title: string;
		prompt: string;
		picks: readonly GraphContextPick[];
		goal: LearningGoal | null;
	}) => {
		if (busy) return;
		// Unconfigured: the send INTERCEPTS into the setup flow (the draft
		// stays in the textarea; the learner sends it after Save).
		if (!configured) {
			setSetupOpen(true);
			return;
		}
		// The pre-send KEY guards (owner interlude, no-orphan-chats): the
		// models case guards BEFORE creation; the key cases must too — a
		// refused first send would otherwise leave an orphan error-shell
		// chat in the sidebar (the 503 lands only after POST /api/chats
		// already created the record). Same skip-everything-and-open-setup
		// treatment; the server's 503 gate remains the belt for /chat/[id]
		// sessions.
		if (zeroKeys || strongKeyless) {
			setSetupOpen(true);
			return;
		}
		setBusy(true);
		try {
			// The map context (owner, 2026-10-04): picks in EITHER mode ride
			// the CREATION as graphContext — the server writes a
			// graph-context marker as message[0] (a separate custom message
			// before the learner's first user message, propositions + the
			// chains among them); the prompt stays the learner's own words.
			// A goal rides it too, its marker first.
			const res = await fetch("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title,
					...(kind === "practice" ? { kind: "practice" } : {}),
					...(picks.length > 0 ? { graphContext: { propositions: picks } } : {}),
					...(sessionGoal ? { goal: sessionGoal } : {}),
				}),
			});
			const { id } = (await res.json()) as { id: string };
			// No settings PUT on create (per-session models, owner
			// 2026-09-28): the SERVER stamps the newborn from the strong
			// slot — the same default this surface's model control edits.
			router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
		} catch {
			setBusy(false);
		}
	};

	/* begin() reads the REF mirror (not the state closure), so an
	 * intercepted draft is the complete one. A goal alone opens with
	 * goalOpening's line. */
	const begin = async () => {
		const t = topicRef.current.trim();
		const goalNow = mode === "teach" ? goal : null;
		if (!t && !goalNow) return;
		await startSession({
			kind: mode,
			title: t || (goalNow?.title ?? ""),
			prompt: t || (goalNow ? goalOpening(goalNow) : ""),
			picks: practiceProps,
			goal: goalNow,
		});
	};

	return (
		<div className="relative h-dvh">
			{/* Window-drag strip (merged chrome, owner 2026-09-17): a dedicated
			    mask element, deliberately FIRST in the DOM. Electron's app-region
			    mask resolves by DOM order — a no-drag element subtracts only drag
			    regions that came EARLIER in the tree — not by z-index, so the
			    header's old inline drag region (after <main>) re-added itself over
			    the graph chrome row's carve-out and the buttons dragged the window.
			    Placed first, every carved control (chrome row, node detail card,
			    the toggle) comes later and subtracts correctly. Pure mask: it
			    never needs to receive events — the mask routes the pixels. */}
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />

			{/* The main view — full-bleed (owner, graph-view round 1): no
			    padding on any side; it runs from the sidebar to the right edge
			    and from the bottom to the top, under everything else. With
			    rendering OFF (graph.rendering, owner 2026-10-06) it is the
			    MINIMAL HOME — a quiet knowledge-base summary + the graph
			    chrome's survivors; data, extraction, and the pick flow are
			    untouched, and the chain table stays behind its button. */}
			<main className="absolute inset-0">
				{rendering ? (
					<GraphView
						chainSelectOpen={chainSelectOpen}
						practiceSelection={pickedIds}
						onPracticeSelectionChange={setPracticeProps}
						onChainSelectClose={() => setChainSelectOpen(false)}
					/>
				) : (
					<MinimalHome
						chainSelectOpen={chainSelectOpen}
						practiceSelection={pickedIds}
						onPracticeSelectionChange={setPracticeProps}
						onChainSelectClose={() => setChainSelectOpen(false)}
					/>
				)}
			</main>

			{/* Header floats over the graph — pointer-events-none except the
			    toggle, so the canvas stays draggable/hoverable around it. Carries
			    no app-region of its own: the strip's drag comes from the mask
			    div above, and the toggle's lh-no-drag subtracts from it (it is
			    later in the tree, so the subtraction sticks). */}
			<header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>

			{/* New session — same floating blob as the chat composer, docked
			    OVER the graph (no gradient: the graph runs clean under it to the
			    bottom edge). Matches chat.tsx's DOCK geometry (max-w-[46rem]
			    px-4) so nothing shifts when a session starts (owner). */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 pb-5">
				<div className="pointer-events-auto mx-auto w-full max-w-[46rem] px-4">
					{/* The pick bar (owner vision, 2026-10-04): the chain
					    table's selection is PERSISTENT — picked
					    propositions show here as a count + Clear in EITHER
					    mode (it survives mode switches; only a practice
					    send consumes it). Practice mode with nothing picked
					    shows the pick HINT so the affordance is discoverable.
					    Teach mode leads with the Goals pill (M21). */}
					<ComposerActions
						picker={
							<>
								{mode === "teach" && (
									<GoalsControl
										goal={goal}
										onGoal={(next) => {
											setGoal(next);
											if (next) topicInputRef.current?.focus();
										}}
									/>
								)}
								{(practiceProps.length > 0 || mode === "practice") && (
									<NodePickerControl
										count={practiceProps.length}
										onOpen={() => setChainSelectOpen(true)}
										onClear={() => setPracticeProps([])}
									/>
								)}
								{/* The review queue (M20), in either mode: what FSRS
								    says is due. Its starts carry their own picks and
								    never the goal; the chain-table selection stays. */}
								<ReviewQueueControl
									busy={busy}
									onStart={(start) => void startSession({ ...start, goal: null })}
								/>
							</>
						}
						setup={zeroKeys ? (
							<ZeroKeysPill inline onOpen={() => setSetupOpen(true)} />
						) : (
							!configured && (
								<button
									type="button"
									data-testid="setup-cta"
									onClick={() => setSetupOpen(true)}
									className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
								>
									Set up your models
								</button>
							)
						)}
					/>
					<form
						className="flex items-end gap-1.5 rounded-2xl border bg-card p-1.5 shadow-lg"
					onSubmit={(e) => {
						e.preventDefault();
						void begin();
					}}
				>
					<textarea
						ref={topicInputRef}
						value={topic}
						onChange={(e) => {
							topicRef.current = e.target.value;
							setTopic(e.target.value);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void begin();
							}
						}}
						placeholder={
							mode === "practice"
								? "What do you want to practice?"
								: goal
									? "Anything to focus on? Or press Enter to start."
									: "What do you want to learn?"
						}
						autoFocus
						rows={1}
						className="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
					/>
					{/* No tooltip on the start square — the ↵ glyph is the
					    affordance (owner, subtlety round 2026-09-25). */}
					<button
						type="submit"
						aria-label="Start session"
						disabled={(!topic.trim() && !(mode === "teach" && goal)) || busy}
						className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-brand text-brand-foreground transition-colors hover:opacity-90 disabled:opacity-40"
					>
						<CornerDownLeftIcon className="size-5" />
					</button>
					</form>
					{/* Same as the chat view's under-composer stats bar (owner) — no
					    session yet, so the LEFT side renders nothing (wave 7 sweep)
					    while the RIGHT keeps the strong-slot control (fix wave: the
					    pills write /api/settings/models). */}
					<StatsBar
						turns={[] as TurnUsage[]}
						leadingSlot={
							<div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="home-mode-switch">
								{(["teach", "practice"] as const).map((m) => (
									<button
										key={m}
										type="button"
										data-testid={`home-mode-${m}`}
										aria-pressed={mode === m}
										onClick={() => setMode(m)}
										className={
											"flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors " +
											(mode === m
												? "bg-accent text-foreground"
												: "text-muted-foreground hover:text-foreground")
										}
									>
										{m === "practice" ? <DumbbellIcon aria-hidden="true" className="size-3" /> : null}
										{m === "teach" ? "Teach" : "Practice"}
									</button>
								))}
							</div>
						}
					/>
				</div>
			</div>

			{/* First-run setup (unconfigured): the CTA's target and the send
			    interception's landing surface — stage 1 is the self-contained
			    first-key screen (zero-keys wave); Save never sends — the
			    draft stays for the learner to send (owner 2026-10-09). */}
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					setConfigured(true);
					setSetupOpen(false);
					// Save only saves: the draft waits in the composer.
				}}
				/>
		</div>
	);
}
