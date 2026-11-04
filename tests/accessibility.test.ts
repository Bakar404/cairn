/**
 * Accessibility mode (M27), the pure half (src/core/accessibility.ts):
 * resolution against the defaults, the effective <html> attributes, the
 * desktop's native read and its merge with the media, the data-os-*
 * report, the reading variables, and the inline boot script, which must
 * paint what the AccessibilityProvider would from the same cache. Snapping
 * and range checks are covered through their callers in settings.test.ts
 * and settings-body.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
	A11Y_ATTRIBUTES,
	A11Y_BOOT_SCRIPT,
	A11Y_STORAGE_KEY,
	ACCESSIBILITY_DEFAULTS,
	FORCED_COLORS_QUERY,
	MORE_CONTRAST_QUERY,
	REDUCED_MOTION_QUERY,
	REDUCED_TRANSPARENCY_QUERY,
	accessibilityAttributes,
	accessibilityCache,
	accessibilityVars,
	osAccessibility,
	osAttributes,
	resolveAccessibility,
	systemAccessibility,
	type AccessibilityMedia,
	type MotionPreference,
	type OsAccessibility,
	type SystemAccessibility,
} from "../src/core/accessibility.ts";

/** Which media field answers each query. */
const QUERY_FIELDS: Record<string, keyof AccessibilityMedia> = {
	[REDUCED_MOTION_QUERY]: "reducedMotion",
	[MORE_CONTRAST_QUERY]: "moreContrast",
	[REDUCED_TRANSPARENCY_QUERY]: "reducedTransparency",
	[FORCED_COLORS_QUERY]: "forcedColors",
};

/** Every combination of the four media signals. */
const MEDIA: AccessibilityMedia[] = Array.from({ length: 16 }, (_, i) => ({
	reducedMotion: (i & 1) !== 0,
	moreContrast: (i & 2) !== 0,
	reducedTransparency: (i & 4) !== 0,
	forcedColors: (i & 8) !== 0,
}));

const NO_MEDIA: AccessibilityMedia = MEDIA[0]!;
const ALL_MEDIA: AccessibilityMedia = MEDIA[15]!;

const NO_SYSTEM: SystemAccessibility = {
	highContrast: false,
	forcedColors: false,
	invertedColors: false,
	reducedTransparency: false,
	differentiateWithoutColor: false,
};

describe("resolveAccessibility", () => {
	it("anything that isn't an object resolves to the defaults", () => {
		for (const junk of [undefined, null, "x", 3, [{ focus: "enhanced" }]]) {
			assert.deepEqual(resolveAccessibility(junk), ACCESSIBILITY_DEFAULTS, JSON.stringify(junk));
		}
	});

	it("each field stands alone: an invalid one takes its default, a number snaps into range", () => {
		assert.deepEqual(
			resolveAccessibility({
				focus: "enhanced",
				motion: "sideways",
				followSystem: "no",
				lineHeight: 3,
				readingWidth: "60",
				wordSpacing: 0.1 + 0.2,
			}),
			{ ...ACCESSIBILITY_DEFAULTS, focus: "enhanced", lineHeight: 2, wordSpacing: 0.3 },
		);
	});
});

describe("accessibilityAttributes", () => {
	it("motion: system follows the OS; reduced and full override it", () => {
		for (const media of MEDIA) {
			const motion = (motion: MotionPreference) => accessibilityAttributes(resolveAccessibility({ motion }), media).motion;
			assert.equal(motion("system"), media.reducedMotion ? "reduced" : "full", JSON.stringify(media));
			assert.equal(motion("reduced"), "reduced");
			assert.equal(motion("full"), "full");
		}
	});

	it("contrast: high when chosen, otherwise only when following the system and the OS asks for more", () => {
		for (const media of MEDIA) {
			const contrast = (delta: object) => accessibilityAttributes(resolveAccessibility(delta), media).contrast;
			assert.equal(contrast({ contrast: "high", followSystem: false }), "high");
			assert.equal(contrast({}), media.moreContrast ? "high" : "standard", JSON.stringify(media));
			assert.equal(contrast({ followSystem: false }), "standard");
		}
	});

	it("transparency: reduced only when following the system and the OS asks", () => {
		for (const media of MEDIA) {
			const transparency = (delta: object) => accessibilityAttributes(resolveAccessibility(delta), media).transparency;
			assert.equal(transparency({}), media.reducedTransparency ? "reduced" : "standard", JSON.stringify(media));
			assert.equal(transparency({ followSystem: false }), "standard");
		}
	});
});

describe("systemAccessibility", () => {
	it("reads a flag as true only when it's exactly true; a payload that isn't an object is no bridge", () => {
		for (const junk of [undefined, null, "x", 3, true, [true]]) {
			assert.equal(systemAccessibility(junk), null, JSON.stringify(junk));
		}
		assert.deepEqual(systemAccessibility({}), NO_SYSTEM);
		assert.deepEqual(
			systemAccessibility({ highContrast: true, forcedColors: "true", invertedColors: 1, differentiateWithoutColor: true, x: true }),
			{ ...NO_SYSTEM, highContrast: true, differentiateWithoutColor: true },
		);
	});
});

describe("osAccessibility", () => {
	it("without the desktop's read, the media are the whole story", () => {
		for (const media of MEDIA) {
			const expected = { ...media, invertedColors: false, differentiateWithoutColor: false };
			assert.deepEqual(osAccessibility(media, null), expected, JSON.stringify(media));
			assert.deepEqual(osAccessibility(media, NO_SYSTEM), expected, JSON.stringify(media));
		}
	});

	it("either source asking is enough; motion is the media's alone, inverted and differentiate the desktop's alone", () => {
		const fields: [keyof SystemAccessibility, keyof OsAccessibility][] = [
			["highContrast", "moreContrast"],
			["forcedColors", "forcedColors"],
			["reducedTransparency", "reducedTransparency"],
			["invertedColors", "invertedColors"],
			["differentiateWithoutColor", "differentiateWithoutColor"],
		];
		for (const [native, merged] of fields) {
			const os = osAccessibility(NO_MEDIA, { ...NO_SYSTEM, [native]: true });
			assert.deepEqual(os, { ...osAccessibility(NO_MEDIA, null), [merged]: true }, native);
		}
	});
});

describe("osAttributes", () => {
	it("reports the OS in the media-feature vocabulary", () => {
		assert.deepEqual(osAttributes(osAccessibility(NO_MEDIA, null)), {
			contrast: "no-preference",
			transparency: "no-preference",
			forcedColors: "none",
			inverted: "none",
			differentiate: "no-preference",
		});
		const everything = { highContrast: true, forcedColors: true, invertedColors: true, reducedTransparency: true, differentiateWithoutColor: true };
		assert.deepEqual(osAttributes(osAccessibility(NO_MEDIA, everything)), {
			contrast: "more",
			transparency: "reduce",
			forcedColors: "active",
			inverted: "inverted",
			differentiate: "without-color",
		});
	});
});

describe("accessibilityVars", () => {
	it("always sets the line height; a number that isn't set leaves the stylesheet's value", () => {
		assert.deepEqual(accessibilityVars(resolveAccessibility({})), { "--lh-prose-leading": "1.5" });
		assert.deepEqual(
			accessibilityVars(
				resolveAccessibility({ lineHeight: 1.8, paragraphSpacing: 1, letterSpacing: 0.12, wordSpacing: 0.16, readingWidth: 70 }),
			),
			{
				"--lh-prose-leading": "1.8",
				"--lh-paragraph-spacing": "1em",
				"--lh-letter-spacing": "0.12em",
				"--lh-word-spacing": "0.16em",
				"--lh-reading-width": "70ch",
			},
		);
	});
});

/** Runs A11Y_BOOT_SCRIPT against a fake <html>. `stored` is what
 *  localStorage holds (an Error is thrown, as blocked storage does), and
 *  `media` answers the OS queries (null: matchMedia throws). */
function boot(stored: string | null | Error, media: AccessibilityMedia | null) {
	const attributes: Record<string, string> = {};
	const vars: Record<string, string> = {};
	const keys: string[] = [];
	const queries: string[] = [];
	vm.runInNewContext(A11Y_BOOT_SCRIPT, {
		localStorage: {
			getItem(key: string) {
				keys.push(key);
				if (stored instanceof Error) throw stored;
				return stored;
			},
		},
		matchMedia(query: string) {
			queries.push(query);
			if (!media) throw new Error("matchMedia is unavailable");
			const field = QUERY_FIELDS[query];
			return { matches: field ? media[field] : false };
		},
		document: {
			documentElement: {
				setAttribute(name: string, value: string) {
					attributes[name] = value;
				},
				style: {
					setProperty(name: string, value: string) {
						vars[name] = value;
					},
				},
			},
		},
	});
	assert.deepEqual(keys, [A11Y_STORAGE_KEY]);
	for (const query of queries) assert.ok(query in QUERY_FIELDS, query);
	return { attributes, vars };
}

/** What the AccessibilityProvider puts on <html> for a section: every
 *  effective attribute and the variables. */
function provider(delta: unknown, media: AccessibilityMedia) {
	const resolved = resolveAccessibility(delta);
	const a = accessibilityAttributes(resolved, media);
	const keys = Object.keys(A11Y_ATTRIBUTES) as (keyof typeof A11Y_ATTRIBUTES)[];
	return {
		attributes: Object.fromEntries(keys.map((key) => [A11Y_ATTRIBUTES[key], a[key]])),
		vars: accessibilityVars(resolved),
	};
}

describe("A11Y_BOOT_SCRIPT", () => {
	it("paints what the provider would from the cache the provider writes, under every OS setting", () => {
		const deltas = [
			{},
			{ contrast: "high" },
			{ motion: "full", followSystem: false },
			{
				focus: "enhanced",
				motion: "reduced",
				contrast: "high",
				followSystem: false,
				lineHeight: 1.8,
				paragraphSpacing: 1,
				letterSpacing: 0.12,
				wordSpacing: 0.16,
				readingWidth: 70,
			},
		];
		for (const delta of deltas) {
			const cache = JSON.stringify(accessibilityCache(resolveAccessibility(delta)));
			for (const media of MEDIA) {
				assert.deepEqual(boot(cache, media), provider(delta, media), `${cache} ${JSON.stringify(media)}`);
			}
		}
	});

	it("with no cache or a broken one, sets each attribute's default and no variables", () => {
		for (const stored of [null, "", "{not json", "[1,2]", "42", '"enhanced"', "null"]) {
			for (const media of MEDIA) {
				assert.deepEqual(boot(stored, media), { attributes: provider({}, media).attributes, vars: {} }, `${stored}`);
			}
		}
	});

	it("reads a partial or hand-edited cache field by field, and applies only known string variables", () => {
		const cache = {
			focus: "enhanced",
			followSystem: "no",
			motion: "sideways",
			vars: { "--lh-reading-width": "60ch", "--lh-word-spacing": 0.2, "--evil": "url(x)", "--lh-prose-leading": null },
		};
		for (const media of MEDIA) {
			assert.deepEqual(boot(JSON.stringify(cache), media), {
				attributes: provider(cache, media).attributes,
				vars: { "--lh-reading-width": "60ch" },
			});
		}
	});

	it("blocked storage or a missing matchMedia falls back without throwing", () => {
		assert.deepEqual(boot(new Error("SecurityError"), ALL_MEDIA), { attributes: provider({}, ALL_MEDIA).attributes, vars: {} });
		const enhanced = JSON.stringify(accessibilityCache(resolveAccessibility({ focus: "enhanced" })));
		assert.deepEqual(boot(enhanced, null), provider({ focus: "enhanced" }, NO_MEDIA));
	});
});
