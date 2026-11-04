"use client";
/**
 * The Accessibility section (M27). A write PUTs the whole section, and the
 * dialog hands the stored delta to the AccessibilityProvider, which applies
 * it at once.
 *
 * The page runs Presets, System, Display, Screen reader, Advanced, then
 * Reset. A preset is a switch: on writes its values, off returns them to
 * their defaults. Advanced starts collapsed over the reading sliders and
 * the WCAG text-spacing check. It's a button disclosure rather than
 * <details>: the dialog's Tab trap (use-dialog-focus.ts) would count the
 * content of a closed <details> as tabbable, and a hidden panel is out of
 * it. Reset stays outside it, where it can be found.
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMotionReduced } from "@/components/reduced-motion";
import { cn } from "@/lib/utils";
import {
	A11Y_RANGES,
	ACCESSIBILITY_PRESETS,
	applyPreset,
	presetApplied,
	removePreset,
	resetAccessibilitySettings,
	resolveAccessibility,
	snapToRange,
	type A11yRangeField,
	type AccessibilityPreset,
	type AccessibilitySettings,
	type AppearanceSettings,
	type ContrastPreference,
	type FocusIndicator,
	type GraphSettings,
	type MotionPreference,
	type PresetWrites,
} from "@/src/core";
import { useAccessibility } from "./accessibility.tsx";
import { SettingsGroup, SettingsRow, Slider, ThinSelect, Toggle } from "./controls.tsx";

const MOTION_HINTS: Record<Exclude<MotionPreference, "system">, string> = {
	reduced: "Stops animations, slides and smooth scrolling",
	full: "Animates even when your system asks for less motion",
};

/** The WCAG text-spacing preset is a check more than a way to read, so it
 *  sits under Advanced with the sliders it sets. */
const WCAG_PRESET_ID = "wcag-text-spacing";
const MAIN_PRESETS = ACCESSIBILITY_PRESETS.filter((preset) => preset.id !== WCAG_PRESET_ID);
const WCAG_PRESET = ACCESSIBILITY_PRESETS.find((preset) => preset.id === WCAG_PRESET_ID);

/** The reading width's last stop, one step past its range: no cap. */
const FULL_WIDTH = A11Y_RANGES.readingWidth.max + A11Y_RANGES.readingWidth.step;

/** 1.5 → "1.5", and a float's residue never shows. */
const decimal = (value: number) => String(Number(value.toFixed(2)));
const times = (value: number) => `${decimal(value)}×`;
const timesText = (value: number) => `${decimal(value)} times the text size`;

type Write<T> = (next: T) => void | Promise<void>;

export function AccessibilitySection({
	accessibility,
	appearance,
	graph,
	onSectionChange,
	onAppearanceChange,
	onGraphChange,
}: {
	/** The record's accessibility delta (absent = the defaults). */
	accessibility: AccessibilitySettings | undefined;
	/** The appearance and graph deltas, which two presets also write. */
	appearance: AppearanceSettings | undefined;
	graph: GraphSettings | undefined;
	/** PUT the whole accessibility section. */
	onSectionChange: Write<AccessibilitySettings>;
	onAppearanceChange: Write<AppearanceSettings>;
	onGraphChange: Write<GraphSettings>;
}) {
	const resolved = resolveAccessibility(accessibility);
	const motionNow = useMotionReduced() ? "reduced" : "full";
	const { os } = useAccessibility();
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const current = { accessibility, appearance, graph };
	const contrastHint =
		resolved.contrast === "standard" && resolved.followSystem && os.moreContrast
			? "High for now: your system asks for more contrast"
			: "High raises text to 7:1 and firms up edges, over the standard background";

	// One section at a time, so each PUT carries the record as it stands.
	// Zoom isn't stored: it's set last, and only in the desktop app.
	const write = async (writes: PresetWrites) => {
		if (writes.appearance) await onAppearanceChange(writes.appearance);
		if (writes.graph) await onGraphChange(writes.graph);
		await onSectionChange(writes.accessibility);
		if (writes.zoom !== undefined) window.lh?.setZoom?.(writes.zoom);
	};
	/** The desktop zoom, which turning a preset off may undo. Undefined in
	 *  the browser. */
	const zoomNow = async () => {
		try {
			return await window.lh?.getZoom?.();
		} catch {
			return undefined;
		}
	};
	const setPreset = async (preset: AccessibilityPreset, on: boolean) =>
		write(on ? applyPreset(preset, current) : removePreset(preset, { ...current, zoom: await zoomNow() }));
	const reset = async () => write(resetAccessibilitySettings({ ...current, zoom: await zoomNow() }));

	/** Sets one reading field, or removes it (the default) when `next` is
	 *  undefined. */
	const setReading = (field: A11yRangeField, next: number | undefined) => {
		const rest: AccessibilitySettings = { ...accessibility };
		delete rest[field];
		return onSectionChange(next === undefined ? rest : { ...rest, [field]: snapToRange(field, next) });
	};
	const resetOf = (field: A11yRangeField) =>
		accessibility?.[field] === undefined ? undefined : () => void setReading(field, undefined);

	// A switch, like the page's other on/off settings: on while every value
	// the preset writes is current.
	const presetRow = (preset: AccessibilityPreset) => (
		<SettingsRow key={preset.id} label={preset.name} hint={preset.hint} testid={`row-preset-${preset.id}`}>
			<Toggle
				checked={presetApplied(preset, current)}
				label={preset.name}
				testid={`preset-${preset.id}`}
				onChange={(on) => void setPreset(preset, on)}
			/>
		</SettingsRow>
	);

	return (
		<>
			<SettingsGroup label="Presets" testid="group-a11y-presets">
				{MAIN_PRESETS.map(presetRow)}
			</SettingsGroup>
			<SettingsGroup label="System" testid="group-a11y-system">
				<SettingsRow
					label="Follow system accessibility settings"
					hint="Raises contrast and reduces transparency when your system asks"
					testid="row-follow-system"
				>
					<Toggle
						checked={resolved.followSystem}
						label="Follow system accessibility settings"
						onChange={(on) => onSectionChange({ ...accessibility, followSystem: on })}
					/>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Display" testid="group-a11y-display">
				<SettingsRow label="Contrast" hint={contrastHint} testid="row-contrast">
					<ThinSelect
						value={resolved.contrast}
						ariaLabel="Contrast"
						testid="select-contrast"
						onChange={(v) => onSectionChange({ ...accessibility, contrast: v as ContrastPreference })}
					>
						<option value="standard">Standard</option>
						<option value="high">High</option>
					</ThinSelect>
				</SettingsRow>
				<SettingsRow
					label="Focus indicator"
					hint="Enhanced draws a thicker outline around keyboard focus"
					testid="row-focus"
				>
					<ThinSelect
						value={resolved.focus}
						ariaLabel="Focus indicator"
						testid="select-focus"
						onChange={(v) => onSectionChange({ ...accessibility, focus: v as FocusIndicator })}
					>
						<option value="standard">Standard</option>
						<option value="enhanced">Enhanced</option>
					</ThinSelect>
				</SettingsRow>
				<SettingsRow
					label="Motion"
					hint={resolved.motion === "system" ? `Follows your system (${motionNow} now)` : MOTION_HINTS[resolved.motion]}
					testid="row-motion"
				>
					<ThinSelect
						value={resolved.motion}
						ariaLabel="Motion"
						testid="select-motion"
						onChange={(v) => onSectionChange({ ...accessibility, motion: v as MotionPreference })}
					>
						<option value="system">System</option>
						<option value="reduced">Reduced</option>
						<option value="full">Full</option>
					</ThinSelect>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Screen reader" testid="group-a11y-screen-reader">
				<SettingsRow
					label="Expand figure descriptions"
					hint="Figure descriptions and animation transcripts start open"
					testid="row-expand-descriptions"
				>
					<Toggle
						checked={resolved.expandDescriptions}
						label="Expand figure descriptions"
						onChange={(on) => onSectionChange({ ...accessibility, expandDescriptions: on })}
					/>
				</SettingsRow>
				<SettingsRow
					label="Announce tool steps"
					hint="Names a tool step that is still running after 5 seconds"
					testid="row-announce-steps"
				>
					<Toggle
						checked={resolved.announceToolSteps}
						label="Announce tool steps"
						onChange={(on) => onSectionChange({ ...accessibility, announceToolSteps: on })}
					/>
				</SettingsRow>
			</SettingsGroup>
			<div data-testid="group-a11y-advanced" className="mt-5 border-t border-border/60 pt-4">
				<button
					type="button"
					aria-expanded={advancedOpen}
					aria-controls="a11y-advanced-panel"
					data-testid="a11y-advanced-toggle"
					onClick={() => setAdvancedOpen((open) => !open)}
					className="flex cursor-pointer items-center gap-1 rounded-sm text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
				>
					Advanced
					<ChevronRight
						aria-hidden
						className={cn("size-3 shrink-0 motion-safe:transition-transform", advancedOpen && "rotate-90")}
					/>
				</button>
				{/* `hidden` takes the panel out of the Tab order and the
				    accessibility tree; its layout lives on the inner div so no
				    display utility competes with it. */}
				<div id="a11y-advanced-panel" hidden={!advancedOpen}>
					<div className="mt-2 flex flex-col gap-2">
						<SettingsRow label="Line height" testid="row-line-height">
							<Slider
								{...A11Y_RANGES.lineHeight}
								value={resolved.lineHeight}
								ariaLabel="Line height"
								display={times}
								valueText={timesText}
								onCommit={(v) => setReading("lineHeight", v)}
								onReset={resetOf("lineHeight")}
								testid="slider-line-height"
							/>
						</SettingsRow>
						<SettingsRow label="Paragraph spacing" hint="The space after each paragraph" testid="row-paragraph-spacing">
							<Slider
								{...A11Y_RANGES.paragraphSpacing}
								value={resolved.paragraphSpacing ?? 1}
								unsetLabel={resolved.paragraphSpacing === null ? "Default" : undefined}
								ariaLabel="Paragraph spacing"
								display={times}
								valueText={timesText}
								onCommit={(v) => setReading("paragraphSpacing", v)}
								onReset={resetOf("paragraphSpacing")}
								testid="slider-paragraph-spacing"
							/>
						</SettingsRow>
						<SettingsRow label="Letter spacing" testid="row-letter-spacing">
							<Slider
								{...A11Y_RANGES.letterSpacing}
								value={resolved.letterSpacing ?? 0}
								unsetLabel={resolved.letterSpacing === null ? "Default" : undefined}
								ariaLabel="Letter spacing"
								display={times}
								valueText={timesText}
								onCommit={(v) => setReading("letterSpacing", v)}
								onReset={resetOf("letterSpacing")}
								testid="slider-letter-spacing"
							/>
						</SettingsRow>
						<SettingsRow label="Word spacing" testid="row-word-spacing">
							<Slider
								{...A11Y_RANGES.wordSpacing}
								value={resolved.wordSpacing ?? 0}
								unsetLabel={resolved.wordSpacing === null ? "Default" : undefined}
								ariaLabel="Word spacing"
								display={times}
								valueText={timesText}
								onCommit={(v) => setReading("wordSpacing", v)}
								onReset={resetOf("wordSpacing")}
								testid="slider-word-spacing"
							/>
						</SettingsRow>
						<SettingsRow
							label="Reading width"
							hint="The most characters a line of text holds"
							testid="row-reading-width"
						>
							<Slider
								min={A11Y_RANGES.readingWidth.min}
								max={FULL_WIDTH}
								step={A11Y_RANGES.readingWidth.step}
								value={resolved.readingWidth ?? FULL_WIDTH}
								ariaLabel="Reading width"
								display={(v) => (v === FULL_WIDTH ? "Full" : `${v} ch`)}
								valueText={(v) => (v === FULL_WIDTH ? "Full width" : `${v} characters`)}
								onCommit={(v) => setReading("readingWidth", v === FULL_WIDTH ? undefined : v)}
								onReset={resetOf("readingWidth")}
								testid="slider-reading-width"
							/>
						</SettingsRow>
						{WCAG_PRESET && presetRow(WCAG_PRESET)}
					</div>
				</div>
			</div>
			<div data-testid="group-a11y-reset" className="mt-5 border-t border-border/60 pt-4">
				{/* Always enabled, like the Keyboard page's Reset all: a button
				    that disabled itself would drop keyboard focus to the page. */}
				<SettingsRow
					label="Reset accessibility settings"
					hint="Turns every preset off and returns this page to its defaults"
					testid="row-a11y-reset"
				>
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="min-w-20 cursor-pointer"
						aria-label="Reset accessibility settings"
						data-testid="a11y-reset"
						onClick={() => void reset()}
					>
						Reset
					</Button>
				</SettingsRow>
			</div>
		</>
	);
}
