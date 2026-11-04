"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { goalItemCount, type LearningGoal } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The goal-context card (M21): the session's learning goal, message[0] of a
 * session started with a goal from Home's Goals picker. Scaffolding, like
 * the graph-context card: muted and collapsed by default. Expanding it
 * shows the goal's note (a retirement notice), then each area with its
 * weight, groups and items. The tutor reads the same outline through the
 * marker's own text (toLlmMessages); this card is the learner's view of it.
 */

const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "7 areas · 36 skills" for a certification, "4 technologies" for a repo. */
export function goalSummary(goal: LearningGoal): string {
	return goal.kind === "certification"
		? `${noun(goal.areas.length, "area", "areas")} · ${noun(goalItemCount(goal), "skill", "skills")}`
		: noun(goal.areas.length, "technology", "technologies");
}

/** The goal's areas, groups and items — the card's body and the picker's preview. */
export function GoalOutline({ goal }: { goal: LearningGoal }) {
	return (
		<div className="space-y-2">
			{goal.areas.map((area, ai) => (
				<div key={ai} className="leading-relaxed">
					<div className="font-medium text-foreground/80">
						{area.name}
						{area.weight ? <span className="font-normal text-muted-foreground"> · {area.weight}</span> : null}
					</div>
					{area.groups.map((group, gi) => (
						<div key={gi} className={cn(group.name && "mt-0.5 ml-3")}>
							{group.name ? <div className="text-foreground/70">{group.name}</div> : null}
							<ul className="ml-3 list-disc pl-3 text-muted-foreground marker:text-border">
								{group.items.map((item, ii) => (
									<li key={ii}>{item}</li>
								))}
							</ul>
						</div>
					))}
				</div>
			))}
		</div>
	);
}

export function GoalContextCard({ data }: { data: LearningGoal }) {
	const [open, setOpen] = useState(false);
	if (!data?.areas) return null;
	return (
		<div data-testid="goal-context-card" className="my-1">
			<button
				type="button"
				data-testid="goal-context-toggle"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
				<span className="font-medium">Learning goal</span>
				<span className="min-w-0 flex-1 truncate">
					{data.title} · {goalSummary(data)}
				</span>
			</button>
			{open && (
				<div data-testid="goal-context-body" className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{data.note ? (
						<p data-testid="goal-context-note" className="leading-snug text-warning">
							{data.note}
						</p>
					) : null}
					<GoalOutline goal={data} />
					<p className="truncate text-[11px] text-muted-foreground">From {data.source}</p>
				</div>
			)}
		</div>
	);
}
