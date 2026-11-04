"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useAccessibility } from "@/components/settings/accessibility";
import { beatTime, type AnimationBeat } from "@/src/core";

/**
 * Text alternatives (M27): the words under a figure or an animation, for
 * learners who can't see it. The makers write them (describe_figure,
 * describe_animation). Each is a disclosure that starts open when
 * Settings → Accessibility → "Expand figure descriptions" is on; a
 * learner's own toggle stands until that setting changes.
 */
function TextDisclosure({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
	const { accessibility } = useAccessibility();
	return (
		<details open={accessibility.expandDescriptions} data-testid={testId} className="group mt-1.5 w-0 min-w-full">
			{/* w-0 min-w-full: the open text wraps to the figure's width
			    instead of widening a natural-size figure's card. */}
			<summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
				<span className="font-medium uppercase tracking-wide">{label}</span>
				<ChevronRight aria-hidden className="size-3 shrink-0 motion-safe:transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-1.5 space-y-2 text-sm leading-relaxed text-foreground">{children}</div>
		</details>
	);
}

/** "Describe": a figure's description. */
export function FigureDescription({ description }: { description: string }) {
	return (
		<TextDisclosure label="Describe" testId="figure-description">
			<p>{description}</p>
		</TextDisclosure>
	);
}

/** "Transcript": an animation's description, then what is on screen at
 *  each beat ("0:03 — text"). */
export function AnimationTranscript({ description, beats }: { description?: string; beats: readonly AnimationBeat[] }) {
	return (
		<TextDisclosure label="Transcript" testId="animation-transcript">
			{description && <p>{description}</p>}
			{beats.length > 0 && (
				<ol className="space-y-1">
					{beats.map((beat, i) => (
						<li key={`${i}-${beat.atSec}`}>
							<span className="tabular-nums text-muted-foreground">{beatTime(beat.atSec)}</span> — {beat.text}
						</li>
					))}
				</ol>
			)}
		</TextDisclosure>
	);
}
