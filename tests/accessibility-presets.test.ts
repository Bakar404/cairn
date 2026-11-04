/**
 * Accessibility presets (M27, src/core/accessibility-presets.ts): turning
 * one on writes its values over the stored deltas and keeps everything
 * else, turning it off removes the values it wrote and keeps the rest, and
 * a preset shows as on exactly while its values are current. Reset turns
 * every preset off. Every write passes the settings routes' own parsers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ACCESSIBILITY_PRESETS,
	applyPreset,
	presetApplied,
	removePreset,
	resetAccessibilitySettings,
	type AccessibilityPresetId,
	type PresetSections,
	type PresetWrites,
} from "../src/core/index.ts";
import {
	parseAccessibilitySettingsBody,
	parseAppearanceSettingsBody,
	parseGraphSettingsBody,
} from "../src/server/settings-body.ts";

const NONE: PresetSections = { accessibility: undefined, appearance: undefined, graph: undefined };

function preset(id: AccessibilityPresetId) {
	const found = ACCESSIBILITY_PRESETS.find((p) => p.id === id);
	assert.ok(found, id);
	return found;
}

describe("accessibility presets", () => {
	it("no preset is applied over the defaults, and each is once its writes land", () => {
		for (const p of ACCESSIBILITY_PRESETS) {
			assert.equal(presetApplied(p, NONE), false, p.id);
			assert.equal(presetApplied(p, { ...NONE, ...applyPreset(p, NONE) }), true, p.id);
		}
	});

	it("keeps the fields a preset doesn't set, and writes only the sections it touches", () => {
		const current: PresetSections = {
			accessibility: { followSystem: false, contrast: "high" },
			appearance: { mode: "light", proseFontSize: 18 },
			graph: { enabled: false },
		};
		assert.deepEqual(applyPreset(preset("reading-comfort"), current), {
			accessibility: { followSystem: false, contrast: "high", lineHeight: 1.5, paragraphSpacing: 2.25, readingWidth: 80 },
		});
		const lowVision = applyPreset(preset("low-vision"), current);
		assert.deepEqual(lowVision.appearance, { mode: "light", proseFontSize: 20 });
		assert.equal(lowVision.graph, undefined);
		const screenReader = applyPreset(preset("screen-reader"), current);
		assert.deepEqual(screenReader.graph, { enabled: false, rendering: false });
		assert.equal(screenReader.appearance, undefined);
	});

	it("an unset field matches its default, and any other value breaks the match", () => {
		// Reading comfort writes a 1.5 line height, which is the default.
		const comfort = preset("reading-comfort");
		assert.equal(presetApplied(comfort, { ...NONE, accessibility: { paragraphSpacing: 2.25, readingWidth: 80 } }), true);
		assert.equal(presetApplied(comfort, { ...NONE, accessibility: { paragraphSpacing: 2.25, readingWidth: 85 } }), false);
		// Low vision's text size lives in appearance, where 16 px is the default.
		const lowVision = preset("low-vision");
		const accessibility = applyPreset(lowVision, NONE).accessibility;
		assert.equal(presetApplied(lowVision, { ...NONE, accessibility }), false);
		assert.equal(presetApplied(lowVision, { ...NONE, accessibility, appearance: { proseFontSize: 20 } }), true);
		// Screen reader's graph switch: rendering is on unless stored off.
		const screenReader = preset("screen-reader");
		const a11y = applyPreset(screenReader, NONE).accessibility;
		assert.equal(presetApplied(screenReader, { ...NONE, accessibility: a11y, graph: { enabled: true } }), false);
	});

	it("turning a preset off after turning it on gives back what was there", () => {
		const current: PresetSections = {
			accessibility: { followSystem: false },
			appearance: { mode: "light" },
			graph: { enabled: false },
		};
		for (const p of ACCESSIBILITY_PRESETS) {
			const on: PresetSections = { ...current, ...applyPreset(p, current) };
			const off = removePreset(p, on);
			assert.deepEqual(off.accessibility, current.accessibility, p.id);
			assert.deepEqual(off.appearance, p.appearance ? current.appearance : undefined, p.id);
			assert.deepEqual(off.graph, p.graph ? current.graph : undefined, p.id);
			assert.equal(off.zoom, p.zoom === undefined ? undefined : 1, p.id);
			assert.equal(presetApplied(p, { ...on, ...off }), false, p.id);
		}
	});

	it("turning a preset off returns its values to the defaults, and keeps values changed since", () => {
		// The defaults, not what the preset replaced: 80 characters
		// replaced 70, and off leaves the width unset.
		const comfort = preset("reading-comfort");
		const narrow: PresetSections = { ...NONE, accessibility: { readingWidth: 70 } };
		assert.deepEqual(removePreset(comfort, { ...narrow, ...applyPreset(comfort, narrow) }), { accessibility: {} });
		const lowVision = preset("low-vision");
		const changed: PresetSections = {
			...NONE,
			accessibility: { ...applyPreset(lowVision, NONE).accessibility, readingWidth: 85 },
			appearance: { proseFontSize: 18 },
		};
		assert.deepEqual(removePreset(lowVision, changed), {
			accessibility: { readingWidth: 85 },
			appearance: { proseFontSize: 18 },
		});
	});

	it("turning a preset off returns the zoom to 100% only while it's the preset's", () => {
		const lowVision = preset("low-vision");
		const on: PresetSections = { ...NONE, ...applyPreset(lowVision, NONE) };
		assert.equal(on.zoom, 1.25);
		// Chromium stores a zoom level, so the factor read back can be off
		// by a float's residue.
		assert.equal(removePreset(lowVision, { ...on, zoom: 1.2500000001 }).zoom, 1);
		assert.equal(removePreset(lowVision, { ...on, zoom: 1.5 }).zoom, undefined, "zoomed since");
		assert.equal(removePreset(lowVision, { ...on, zoom: undefined }).zoom, undefined, "the browser");
		assert.equal(removePreset(preset("reading-comfort"), { ...on, zoom: 1.25 }).zoom, undefined, "no zoom of its own");
	});

	it("Reset clears the section and turns every preset off, the text size, graph view and zoom included", () => {
		const everything: PresetSections = {
			accessibility: { followSystem: false, contrast: "high", lineHeight: 1.7 },
			appearance: { mode: "dark", proseFontSize: 20 },
			graph: { enabled: false, rendering: false },
			zoom: 1.25,
		};
		assert.deepEqual(resetAccessibilitySettings(everything), {
			accessibility: {},
			appearance: { mode: "dark" },
			graph: { enabled: false },
			zoom: 1,
		});
		// A text size and zoom no preset sets stay, and a section that
		// doesn't change isn't written.
		const own: PresetSections = { ...everything, appearance: { proseFontSize: 18 }, graph: { enabled: false }, zoom: 1.5 };
		assert.deepEqual(resetAccessibilitySettings(own), { accessibility: {} });
		assert.deepEqual(resetAccessibilitySettings(NONE), { accessibility: {} });
	});

	it("every write passes the settings routes' parsers unchanged", () => {
		const parses = (writes: PresetWrites, label: string) => {
			assert.deepEqual(parseAccessibilitySettingsBody(writes.accessibility), { ok: true, settings: writes.accessibility }, label);
			if (writes.appearance) {
				assert.deepEqual(parseAppearanceSettingsBody(writes.appearance), { ok: true, settings: writes.appearance }, label);
			}
			if (writes.graph) {
				assert.deepEqual(parseGraphSettingsBody(writes.graph), { ok: true, settings: writes.graph }, label);
			}
		};
		for (const p of ACCESSIBILITY_PRESETS) {
			const on = applyPreset(p, NONE);
			parses(on, `${p.id} on`);
			parses(removePreset(p, { ...NONE, ...on }), `${p.id} off`);
			parses(resetAccessibilitySettings({ ...NONE, ...on }), `${p.id} reset`);
		}
	});
});
