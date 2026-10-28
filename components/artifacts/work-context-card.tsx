"use client";

import { BriefcaseBusinessIcon, CircleX } from "lucide-react";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import type { ArtifactPartProps, WorkContextResult } from "@/src/core";

/**
 * The Work IQ lookup (M10). The tool part's output is the dispatch ack, so
 * the box is the DispatchCard ("Work IQ", live status from the jobs feed).
 * A call refused as a repeat dispatched nothing and renders nothing. The
 * topics ride the steer message and render there (WorkContextOutputCard).
 */
export function WorkContextCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	if (!/^Dispatched \(job /.test(outputText(part.output))) return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="work_context" />;
}

function outputText(output: unknown): string {
	if (typeof output === "string") return output;
	const text = (output as { text?: unknown } | null)?.text;
	return typeof text === "string" ? text : "";
}

/**
 * What Work IQ found: a quiet one-liner that expands to the topics. They
 * are framed as where the probe starts — the learner sees they don't count
 * as things they know.
 */
export function WorkContextOutputCard({ output }: { output: unknown }) {
	const result = output as WorkContextResult | undefined;
	if (!result || !Array.isArray(result.topics)) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Work IQ answered, but the result could not be displayed.
			</div>
		);
	}
	if (typeof result.failure === "string") {
		return (
			<div data-testid="work-context-failed" className="flex items-start gap-2 text-xs text-muted-foreground">
				<CircleX className="mt-px size-3.5 shrink-0" />
				<span className="font-medium uppercase tracking-wide">Work IQ</span>
				<span>
					lookup failed: {result.failure.replace(/[.\s]+$/, "")}. Check Settings › Providers › Work IQ.
				</span>
			</div>
		);
	}
	if (result.topics.length === 0) {
		return (
			<div data-testid="work-context-empty" className="flex items-center gap-2 text-xs text-muted-foreground">
				<BriefcaseBusinessIcon className="size-3.5" />
				<span className="font-medium uppercase tracking-wide">Work IQ</span>
				<span>found nothing in your work for this subject</span>
			</div>
		);
	}
	const n = result.topics.length;
	return (
		<details data-testid="work-context-card" className="group w-full text-xs text-muted-foreground">
			<summary className="flex cursor-pointer select-none list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
				<BriefcaseBusinessIcon className="size-3.5" />
				<span className="font-medium uppercase tracking-wide">Work IQ</span>
				<span>
					{n} topic{n === 1 ? "" : "s"} from your work
				</span>
				<span className="ml-1 text-xs text-muted-foreground/70 group-open:hidden">view</span>
				<span className="ml-1 hidden text-xs text-muted-foreground/70 group-open:inline">hide</span>
			</summary>
			<div className="mt-2 rounded-xl border bg-card p-4 text-card-foreground">
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Work IQ · starting guess
				</div>
				<p className="text-sm text-muted-foreground">
					Where your tutor starts probing. None of these count as things you know until you show it.
				</p>
				<ul className="mt-2 list-disc pl-5 text-sm" data-testid="work-context-topics">
					{result.topics.map((topic) => (
						<li key={topic}>{topic}</li>
					))}
				</ul>
				{result.question && (
					<details className="mt-3 border-t pt-2">
						<summary className="cursor-pointer select-none text-xs text-muted-foreground">
							The question Work IQ was asked
						</summary>
						<p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{result.question}</p>
					</details>
				)}
			</div>
		</details>
	);
}
