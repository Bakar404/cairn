import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { CONFIDENCE_STOPS } from "@/src/core";

/**
 * The confidence RAIL — the slider's paint, shared by two surfaces so they
 * can never drift apart (owner, 2026-10-01):
 *
 *   - the dock's live slider (question-dock) — a transparent range input
 *     rides on top of this paint, disc and all;
 *   - the ANSWERED card (owner round 6) — the same rail with NO disc,
 *     which itself communicates "this is a record, not a control".
 *
 * Geometry law: the rail spans the thumb-CENTER range (inset half a 16px
 * disc per side) so the dock's 0/100 stops sit flush at the very ends.
 * The static card has no thumb, but keeps the identical shape.
 *
 * Stack law: the page background as base, SOLID stop ticks
 * as background layers UNDER the fill, and the fill itself TRANSPARENT
 * past the value — so ticks show only on the empty side, never over the
 * color. Ticks skip 0 and 100 (the rail's ends already say those).
 */

/** The six-step ramp (owner ruling): 0 red → 100 green, indexed by stop.
 *  Design wave: built from the semantic tokens (danger → warning →
 *  success), so it is muted, warm, and correct in both modes. */
const mix = (a: string, b: string, pctA: number) => `color-mix(in oklab, var(${a}) ${pctA}%, var(${b}))`;
export const CONFIDENCE_COLORS: readonly string[] = [
	"var(--danger)", // 0
	mix("--danger", "--warning", 45), // 30
	"var(--warning)", // 50
	mix("--warning", "--success", 45), // 70
	"var(--success)", // 90
	mix("--success", "--viz-6", 65), // 100
];

const TICK = "color-mix(in oklab, var(--foreground) 30%, transparent)";

/** The rail's paint for a stop value (0–100). */
export function confidenceRailStyle(value: number): CSSProperties {
	const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(value)] ?? CONFIDENCE_COLORS[2]!;
	return {
		backgroundColor: "var(--background)",
		backgroundImage: [
			`linear-gradient(90deg, ${color} 0%, ${color} ${value}%, transparent ${value}%, transparent 100%)`,
			...[30, 50, 70, 90].map(() => `linear-gradient(90deg, ${TICK}, ${TICK})`),
		].join(", "),
		backgroundSize: ["100% 100%", "1px 100%", "1px 100%", "1px 100%", "1px 100%"].join(", "),
		backgroundPosition: ["0 0", ...[30, 50, 70, 90].map((p) => `${p}% 0`)].join(", "),
		backgroundRepeat: "no-repeat",
	};
}
/** The static rail — the slider's look, disc removed. */
export function ConfidenceRail({ value, className }: { value: number; className?: string }) {
	return (
		<div
			aria-hidden
			data-testid="confidence-rail"
			className={cn("h-1.5 w-full rounded-full border border-border", className)}
			style={confidenceRailStyle(value)}
		/>
	);
}
