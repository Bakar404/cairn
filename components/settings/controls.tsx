"use client";
/**
 * Thin settings primitives (settings-app wave): the control kit the
 * settings dialog needs. Sections → groups → rows; everything SSRs clean
 * (render tests pin the sections' markup).
 *
 * The dependency graying (owner, 2026-09-20) follows the graph viewer's
 * render-panel convention: the WHOLE row dims (opacity-40, label and
 * control together) and the control itself locks — the row owns the dim.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A section block: pronounced mono heading + content. */
export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
	/** One quiet line under the header — only where it earns its place. */
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<section data-testid={testid} className="px-6 py-5">
			<h2 className="text-sm uppercase tracking-widest text-foreground">{title}</h2>
			{hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
			<div className="mt-4 flex flex-col gap-3">{children}</div>
		</section>
	);
}

/** A labeled sub-group inside a section (owner, 2026-09-20: clear
 *  separation — Models / Tools / Prompts read as three blocks). */
export function SettingsGroup({
	label,
	children,
	testid,
}: {
	label: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<div data-testid={testid} className="mt-5 border-t border-border/60 pt-4 first:mt-0 first:border-t-0 first:pt-0">
			<p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
			<div className="flex flex-col gap-2">{children}</div>
		</div>
	);
}

/** One label + one control. Label left (with optional muted hint), control
 *  right — the settings row shape. */
export function SettingsRow({
	label,
	hint,
	children,
	testid,
	dimmed,
}: {
	label: string;
	hint?: ReactNode;
	children: React.ReactNode;
	testid?: string;
	/** Dependency graying, graph-view style: the whole row dims when the
	 *  control is inert (parent off, no file yet, …). */
	dimmed?: boolean;
}) {
	return (
		<div data-testid={testid} className={cn("flex items-center justify-between gap-4 py-1", dimmed && "opacity-40")}>
			<span className="min-w-0">
				<span className="block font-prose text-(length:--lh-prose-size)">{label}</span>
				{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
			</span>
			{children}
		</div>
	);
}

/** The on/off switch — a plain button in the switch role. */
export function Toggle({
	checked,
	disabled,
	onChange,
	label,
	discIcon,
	title,
	testid,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	/** Accessible name for the switch role. */
	label: string;
	/** Optional icon disc (owner round, 2026-10-07): the figure cards' invert
	 *  toggle renders the half-filled contrast circle AS the disc — the icon
	 *  carries the meaning; plain toggles keep the plain disc. */
	discIcon?: ReactNode;
	/** Optional native tooltip on the switch. */
	title?: string;
	/** Overrides the testid derived from the label. */
	testid?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			{...(title ? { title } : {})}
			disabled={disabled}
			data-testid={testid ?? `toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-4.5 w-8 shrink-0 rounded-full border border-border transition-colors",
				// Owner (2026-09-20): on is a gray track with a WHITE disc (a full-white
				// track was too loud); off stays the muted track.
				checked ? "bg-muted-foreground" : "bg-muted",
				disabled && "cursor-not-allowed",
			)}
		>
			{discIcon ? (
				// The icon IS the disc: same size, same slide, same state colors —
				// only the knob's face changes (the invert affordance).
				<span
					className={cn(
						"absolute left-0 top-0.5 flex size-3 items-center justify-center rounded-full motion-safe:transition-transform",
						checked ? "translate-x-4 text-foreground" : "translate-x-0.5 text-muted-foreground",
					)}
				>
					{discIcon}
				</span>
			) : (
				<span
					className={cn(
						"absolute left-0 top-0.5 size-3 rounded-full motion-safe:transition-transform",
						// 2px inset from each inner edge, both states (owner round: the on
						// disc used to touch the pill's right edge).
						checked ? "translate-x-4 bg-foreground" : "translate-x-0.5 bg-muted-foreground",
					)}
				/>
			)}
		</button>
	);
}

/** A thin select — native element, options as given. */
export function ThinSelect({
	value,
	onChange,
	children,
	ariaLabel,
	testid,
	disabled,
}: {
	value: string;
	onChange: (next: string) => void;
	children: React.ReactNode;
	ariaLabel: string;
	testid?: string;
	disabled?: boolean;
}) {
	return (
		<select
			value={value}
			aria-label={ariaLabel}
			data-testid={testid}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value)}
			className={cn(
				"h-7 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none",
				disabled && "cursor-not-allowed",
			)}
		>
			{children}
		</select>
	);
}

/** A thin hex/text input committing on blur + Enter (settings pace, not
 *  typing pace — every commit is a section PUT). */
export function CommitInput({
	value,
	placeholder,
	onCommit,
	ariaLabel,
	testid,
	type = "text",
}: {
	/** "" = unset (the factory default). Mirrors the STORED record —
	 *  after a clamped/normalized commit this flows back and the field
	 *  snaps to the stored truth (owner repro: a negative size kept
	 *  displaying "-5" while 12 was stored). */
	value: string;
	placeholder?: string;
	onCommit: (next: string) => void;
	ariaLabel: string;
	testid?: string;
	type?: "text" | "number";
}) {
	// The draft exists only while editing; a blur shows the record's value
	// again — commit-on-blur/Enter (owner ruling), the field honest about
	// what landed.
	const [draft, setDraft] = useState(value);
	const [editing, setEditing] = useState(false);
	return (
		<input
			type={type}
			value={editing ? draft : value}
			placeholder={placeholder}
			aria-label={ariaLabel}
			data-testid={testid}
			onChange={(e) => {
				setEditing(true);
				setDraft(e.target.value);
			}}
			onBlur={() => {
				if (!editing) return;
				setEditing(false);
				const next = draft.trim();
				if (next !== value) onCommit(next);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					setEditing(false);
					e.currentTarget.blur();
				}
			}}
			className="h-7 w-40 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
		/>
	);
}

/** How long a slider waits after its last change before it writes. */
const SLIDER_SETTLE_MS = 250;

/** A native range input with its value beside it (accessibility mode,
 *  M27). Moving the thumb only redraws: the write waits until the thumb
 *  settles (SLIDER_SETTLE_MS after the last change, or at once on blur or
 *  unmount), so a drag or a run of arrow keys is one section PUT. When
 *  the write fails, the stored value shows again. */
export function Slider({
	value,
	min,
	max,
	step,
	onCommit,
	ariaLabel,
	display,
	valueText,
	unsetLabel,
	onReset,
	testid,
}: {
	/** The stored value, or the thumb's resting place while it's unset. */
	value: number;
	min: number;
	max: number;
	step: number;
	onCommit: (next: number) => void | Promise<void>;
	ariaLabel: string;
	/** The visible value beside the track. */
	display: (value: number) => string;
	/** What assistive tech reads for a value (aria-valuetext). */
	valueText: (value: number) => string;
	/** Shown and read instead of the value while the field is unset and
	 *  the thumb hasn't moved. */
	unsetLabel?: string;
	/** Clears the field back to its default; absent while it's unset. */
	onReset?: () => void;
	testid?: string;
}) {
	const [draft, setDraft] = useState<number | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pending = useRef<number | null>(null);
	// The latest props, for a write that lands after a re-render (the
	// settings-signal pattern: refs written during render).
	const commitRef = useRef(onCommit);
	commitRef.current = onCommit;
	const valueRef = useRef(value);
	valueRef.current = value;

	const flush = useCallback(() => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		const next = pending.current;
		if (next === null) return;
		pending.current = null;
		if (next === valueRef.current) {
			setDraft(null);
			return;
		}
		const settle = () => setDraft((d) => (d === next ? null : d));
		void Promise.resolve()
			.then(() => commitRef.current(next))
			.then(settle, settle);
	}, []);

	// The native change event fires when a drag ends and on each key step;
	// React's onChange is the input event, which fires on every move.
	useEffect(() => {
		const input = inputRef.current;
		if (!input) return;
		const onChange = () => {
			pending.current = Number(input.value);
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = setTimeout(flush, SLIDER_SETTLE_MS);
		};
		input.addEventListener("change", onChange);
		return () => {
			input.removeEventListener("change", onChange);
			flush();
		};
	}, [flush]);

	const shown = draft ?? value;
	const unset = unsetLabel !== undefined && draft === null;
	return (
		<span className="flex items-center gap-2">
			<input
				ref={inputRef}
				type="range"
				min={min}
				max={max}
				step={step}
				value={shown}
				aria-label={ariaLabel}
				aria-valuetext={unset ? unsetLabel : valueText(shown)}
				data-testid={testid}
				onChange={(e) => setDraft(Number(e.target.value))}
				onBlur={flush}
				className="h-6 w-36 cursor-pointer accent-primary"
			/>
			<span aria-hidden className="w-14 text-right font-ui text-xs tabular-nums text-foreground">
				{unset ? unsetLabel : display(shown)}
			</span>
			{/* Focus moves to the slider first: this button hides once the
			    field is unset, and focus left on it would fall to the page. */}
			<button
				type="button"
				aria-label={`Reset ${ariaLabel.toLowerCase()}`}
				disabled={!onReset}
				onClick={() => {
					inputRef.current?.focus();
					onReset?.();
				}}
				data-testid={testid ? `${testid}-reset` : undefined}
				className={cn(
					"min-h-6 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
					!onReset && "invisible",
				)}
			>
				Reset
			</button>
		</span>
	);
}