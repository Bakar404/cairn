import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { FIGURE, LEGACY_FIGURE, STONE_FIGURE, themeFigureSvg, type FigurePalette } from "../src/core/figure-theme.ts";

const { light: L, dark: D } = FIGURE;
const OPEN = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"';
const svg = (body: string, attrs = "") => `<svg ${OPEN}${attrs}>${body}</svg>`;
/** The output for a root without fill/color: the target ink is injected. */
const themed = (body: string, ink: string) => `<svg fill="${ink}" color="${ink}" ${OPEN}>${body}</svg>`;
const lum = (hex: string) => [1, 3, 5].reduce((sum, i) => sum + Number.parseInt(hex.slice(i, i + 2), 16), 0);

describe("themeFigureSvg", () => {
	it("maps a house figure role by role between schemes, and back", () => {
		const body = (p: FigurePalette) =>
			`<rect fill="${p.paper}"/><path stroke="${p.ink}"/><text fill="${p.muted}">a</text><line stroke="${p.faint}"/><circle fill="${p.accent}" stroke="${p.accent2}"/>`;
		const dark = themeFigureSvg(svg(body(L)), D);
		assert.equal(dark, themed(body(D), D.ink));
		assert.equal(themeFigureSvg(dark!, L), themed(body(L), L.ink));
	});

	it("brings the legacy palette and white/black into the house palette, keeping quote style", () => {
		const out = themeFigureSvg(svg(`<rect fill="#FFFFFF" stroke='${LEGACY_FIGURE.accent}'/><path fill="white" stroke="#000"/><path stroke=${LEGACY_FIGURE.accent2} fill="#FFF"/>`), L);
		assert.equal(out, themed(`<rect fill="${L.paper}" stroke='${L.accent}'/><path fill="${L.paper}" stroke="${L.ink}"/><path stroke="${L.accent2}" fill="${L.paper}"/>`, L.ink));
	});

	it("re-colors figures drawn with the previous (warm-stone) house palette, both schemes", () => {
		const body = (p: FigurePalette) =>
			`<rect fill="${p.paper}"/><path stroke="${p.ink}"/><text fill="${p.muted}">a</text><line stroke="${p.faint}"/><circle fill="${p.accent}" stroke="${p.accent2}"/>`;
		assert.equal(themeFigureSvg(svg(body(STONE_FIGURE.light)), D), themed(body(D), D.ink));
		assert.equal(themeFigureSvg(svg(body(STONE_FIGURE.dark)), L), themed(body(L), L.ink));
	});

	it("keeps the relative depth of pure greys between the target's paper and ink", () => {
		const out = themeFigureSvg(svg(`<rect fill="#eeeeee"/><rect fill="gray"/><rect fill="#333"/>`), D)!;
		const [light, mid, dark] = [...out.matchAll(/<rect fill="(#[0-9a-f]{6})"\/>/g)].map((m) => lum(m[1]!));
		assert.ok(lum(D.paper) < light! && light! < mid! && mid! < dark! && dark! < lum(D.ink), out);
	});

	it("themes the golden visual fixture (greys plus the legacy accent)", () => {
		const job = JSON.parse(readFileSync(new URL("./fixtures/golden-data/jobs/job_mv28p0fs_0a16b76e.json", import.meta.url), "utf8")) as { result: { svg: string } };
		const out = themeFigureSvg(job.result.svg, D);
		assert.ok(out);
		assert.ok(!/#2563eb|#ffffff/i.test(out), "no light-only color survives");
		assert.ok(out.includes(D.accent) && out.includes(D.paper));
	});

	it("maps colors in <style> blocks and style attributes, leaving url() references and selectors alone", () => {
		const out = themeFigureSvg(svg(`<style>.a{fill:${LEGACY_FIGURE.accent};stroke:white}#arrow{color:#000 !important}</style><path style="stroke: #1f1f1f; fill:url(#g); opacity:.5"/>`), D);
		assert.equal(out, themed(`<style>.a{fill:${D.accent};stroke:${D.paper}}#arrow{color:${D.ink} !important}</style><path style="stroke: ${D.ink}; fill:url(#g); opacity:.5"/>`, D.ink));
	});

	it("never touches text, comments or CDATA", () => {
		const body = `<text fill="#000">#fff white #2563eb</text><!-- fill="#123456" --><![CDATA[ fill:#abcdef ]]>`;
		assert.equal(themeFigureSvg(svg(body), D), themed(body.replace('fill="#000"', `fill="${D.ink}"`), D.ink));
	});

	it("leaves keywords alone and injects the root defaults only where missing", () => {
		const keywords = `<path fill="none" stroke="currentColor"/><g fill="url(#p)"/>`;
		assert.equal(themeFigureSvg(svg(keywords), D), themed(keywords, D.ink));
		assert.equal(themeFigureSvg(svg("", ' fill="#fff"'), D), `<svg color="${D.ink}" ${OPEN} fill="${D.paper}"></svg>`);
		assert.equal(themeFigureSvg(svg("", ' style="color:#000;fill:none"'), D), svg("", ` style="color:${D.ink};fill:none"`));
	});

	it("refuses any figure it cannot re-color completely", () => {
		for (const [why, input] of [
			["an off-palette hue", svg(`<path stroke="#ff0000"/>`)],
			["a named hue", svg(`<path fill="tomato"/>`)],
			["a functional color", svg(`<path style="fill:rgb(0,0,0)"/>`)],
			["a hex-like ID selector", svg(`<style>#face{fill:#000}</style>`)],
			["a raster", svg(`<image href="data:image/png;base64,AA=="/>`)],
			["embedded HTML", svg(`<foreignObject><div/></foreignObject>`)],
			["color animation", svg(`<rect fill="#fff"><animate attributeName="fill" to="#000"/></rect>`)],
			["no svg root", `<g fill="#fff"/>`],
		] as const) {
			assert.equal(themeFigureSvg(input, D), null, why);
		}
	});
});
