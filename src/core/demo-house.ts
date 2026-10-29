/**
 * THE DEMO HOUSE KIT (design wave, docs/design.md "Demos"). Every demo the
 * builder makes runs with this stylesheet + script injected ahead of its
 * own code: the app's palette as CSS variables (both schemes, flipped live
 * by the host), quiet base styles for plain HTML controls, and a small
 * `window.cairn` API for canvas painters. Demos never carry colors of their
 * own — the kit is the runtime the app supplies, the way globals.css is for
 * components, so a demo built today restyles with the app tomorrow.
 *
 * Pure strings, no DOM: the demo card (srcdoc + download), the builder's
 * headless runs, and the tests all call the same functions.
 */

import { PALETTE, PALETTE_VARS, VIZ_VARS, type SchemePalette } from "./palette.ts";
import type { ColorScheme } from "./theme-mode.ts";

/** The kit generation a demo was built and tested against (DemoResult.kit).
 *  Keep the kit's variables, classes, and `window.cairn` API backward
 *  compatible; bump only if an old demo could no longer run. */
export const HOUSE_KIT_VERSION = 1;

/** Host → demo: flip the theme live (the iframe never reloads). */
export interface HouseThemeMessage {
	type: "cairn-theme";
	theme: ColorScheme;
	/** Live token values that override the factory palette (a custom
	 *  background's derived surfaces). */
	vars?: Record<string, string>;
}

export interface HouseKitOptions {
	theme: ColorScheme;
	/** Initial token overrides, applied before the demo's first paint. */
	vars?: Record<string, string>;
	/** Headless rehearsal: flip to the other scheme after this many ms, the
	 *  way the host would, so a broken theme handler fails the test run. */
	rehearseFlipMs?: number;
}

/** A palette as the kit's CSS custom properties (`--background` … `--viz-6`). */
export function paletteVars(p: SchemePalette): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, name] of Object.entries(PALETTE_VARS) as [keyof typeof PALETTE_VARS, string][]) {
		out[name] = p[key];
	}
	p.viz.forEach((hex, i) => {
		const name = VIZ_VARS[i];
		if (name) out[name] = hex;
	});
	return out;
}

const declarations = (vars: Record<string, string>) =>
	Object.entries(vars)
		.map(([name, value]) => `${name}:${value}`)
		.join(";");

// The iframe is sandboxed (opaque origin) and cannot load the app's web
// fonts; the stacks name them first for machines that have them installed.
const TYPE_TOKENS =
	'--font-sans:"Source Sans 3","Source Sans Pro",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;' +
	'--font-mono:"JetBrains Mono",ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace;' +
	"--radius:8px";

// Base styles sit at zero specificity (:where) so ANY selector a demo
// writes wins over them. ASCII only: a downloaded demo is decoded before
// its own charset declaration is seen.
const BASE_CSS = `
:where(*,*::before,*::after){box-sizing:border-box}
:where(body){margin:0;padding:20px;background:var(--background);color:var(--foreground);font:15px/1.55 var(--font-sans);-webkit-font-smoothing:antialiased}
:where(h1,h2,h3,h4){margin:0 0 .5em;font-weight:600;line-height:1.25;color:var(--foreground)}
:where(h1){font-size:1.25rem}
:where(h2){font-size:1.125rem}
:where(h3,h4){font-size:1rem}
:where(p){margin:0 0 .75em}
:where(small,.note,figcaption){font-size:.8125rem;color:var(--muted-foreground)}
:where(a){color:var(--brand);text-underline-offset:2px}
:where(code,kbd,samp,pre,output,.readout){font-family:var(--font-mono);font-size:.8125rem}
:where(output,.readout,td,th){font-variant-numeric:tabular-nums}
:where(output,.readout){color:var(--foreground)}
:where(hr){border:0;border-top:1px solid var(--border);margin:16px 0}
:where(label){font-size:.875rem;color:var(--muted-foreground)}
:where(canvas,img,video){display:block;max-width:100%;height:auto}
:where(button){font:inherit;font-size:.875rem;line-height:1.25;padding:6px 12px;border:1px solid var(--input);border-radius:6px;background:var(--card);color:var(--foreground);cursor:pointer;transition:background-color .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}
:where(button:hover){background:var(--accent)}
:where(button:active){transform:translateY(1px)}
:where(button:disabled){opacity:.45;cursor:default;transform:none}
:where(button.primary){background:var(--foreground);border-color:var(--foreground);color:var(--background)}
:where(button.primary:hover){background:var(--foreground);opacity:.88}
:where(select,textarea,input:not([type]),input[type=text],input[type=number]){font:inherit;font-size:.875rem;padding:5px 8px;border:1px solid var(--input);border-radius:6px;background:var(--card);color:var(--foreground)}
:where(input[type=number]){width:6em;font-family:var(--font-mono);font-variant-numeric:tabular-nums}
:where(input[type=checkbox],input[type=radio]){width:15px;height:15px;margin:0;vertical-align:-2px;accent-color:var(--foreground)}
:where(input[type=range]){-webkit-appearance:none;appearance:none;width:100%;min-width:120px;height:24px;margin:0;background:transparent;cursor:pointer}
:where(input[type=range])::-webkit-slider-runnable-track{height:2px;border-radius:1px;background:var(--input)}
:where(input[type=range])::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:-7px;border:0;border-radius:50%;background:var(--foreground);transition:transform .12s ease}
:where(input[type=range]:active)::-webkit-slider-thumb{transform:scale(1.15)}
:where(input[type=range])::-moz-range-track{height:2px;border-radius:1px;background:var(--input)}
:where(input[type=range])::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:var(--foreground)}
:where(button,select,textarea,input):focus-visible{outline:2px solid var(--ring);outline-offset:2px}
:where(input[type=range]):focus-visible{outline:none}
:where(input[type=range]:focus-visible)::-webkit-slider-thumb{box-shadow:0 0 0 2px var(--background),0 0 0 4px var(--ring)}
:where(table){width:100%;border-collapse:collapse;font-size:.875rem}
:where(th,td){padding:6px 10px;border-bottom:1px solid var(--border);text-align:left}
:where(th){font-weight:600;color:var(--muted-foreground)}
:where(figure){margin:0}
:where(figcaption){padding-top:8px}
:where(.row){display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px}
:where(.stack){display:flex;flex-direction:column;gap:8px}
:where(.panel){background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}
:where(.control){display:grid;grid-template-columns:minmax(6em,auto) 1fr 4.5em;align-items:center;gap:12px}
:where(.control output,.control .readout){text-align:right}
:where(.tabs){display:flex;gap:20px;margin:0 0 12px;border-bottom:1px solid var(--border)}
:where(.tabs button){padding:6px 0;margin-bottom:-1px;border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--muted-foreground);font-family:var(--font-mono);font-size:.75rem}
:where(.tabs button:hover){background:none;color:var(--foreground)}
:where(.tabs button[aria-selected=true],.tabs button.active){color:var(--foreground);border-bottom-color:var(--brand)}
::selection{background:color-mix(in srgb,var(--brand) 22%,transparent)}
`.trim();

/** The kit's stylesheet: both factory palettes (light on :root, dark under
 *  data-theme="dark"), the type tokens, and the base styles. */
export function houseKitCss(): string {
	return [
		`:root{color-scheme:light;${declarations(paletteVars(PALETTE.light))};${TYPE_TOKENS}}`,
		`:root[data-theme=dark]{color-scheme:dark;${declarations(paletteVars(PALETTE.dark))}}`,
		BASE_CSS,
	].join("\n");
}

/** Every token name `cairn.palette()` reports, without the leading `--`. */
const TOKEN_NAMES = Object.keys(paletteVars(PALETTE.light)).map((name) => name.slice(2));

/** JSON safe to embed inside an inline <script>. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

function houseKitScript(opts: HouseKitOptions): string {
	const rehearse =
		typeof opts.rehearseFlipMs === "number" && opts.rehearseFlipMs >= 0
			? `setTimeout(function(){apply(api.theme==="dark"?"light":"dark");emit()},${Math.round(opts.rehearseFlipMs)});`
			: "";
	return `(function(){
var d=document.documentElement,own=[],subs=[],names=${scriptJson(TOKEN_NAMES)};
function apply(t,v){
for(var i=0;i<own.length;i++)d.style.removeProperty(own[i]);
own=[];
d.setAttribute("data-theme",t==="dark"?"dark":"light");
if(v&&typeof v==="object")for(var k in v){if(/^--[a-z0-9-]+$/.test(k)&&typeof v[k]==="string"){d.style.setProperty(k,v[k]);own.push(k)}}
}
function read(n){n=String(n);return getComputedStyle(d).getPropertyValue(n.indexOf("--")===0?n:"--"+n).trim()}
var api={
get theme(){return d.getAttribute("data-theme")==="dark"?"dark":"light"},
color:read,
viz:function(i){var n=Math.floor(Number(i))||0;return read("viz-"+(((n%6)+6)%6+1))},
alpha:function(n,a){var c=read(n),m=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);return m?"rgba("+parseInt(m[1],16)+","+parseInt(m[2],16)+","+parseInt(m[3],16)+","+a+")":c},
font:function(k){return read(k==="mono"?"font-mono":"font-sans")},
palette:function(){var o={};for(var i=0;i<names.length;i++)o[names[i]]=read(names[i]);return o},
onTheme:function(fn){subs.push(fn);return function(){subs=subs.filter(function(f){return f!==fn})}}
};
function emit(){subs.slice().forEach(function(fn){try{fn(api.theme)}catch(e){setTimeout(function(){throw e})}})}
apply(${scriptJson(opts.theme)},${scriptJson(opts.vars ?? null)});
window.cairn=api;
addEventListener("message",function(e){var m=e.data;if(e.source!==parent||!m||m.type!=="cairn-theme")return;apply(m.theme,m.vars);emit()});
${rehearse}})();`;
}

/** The markup injected ahead of a demo's own code. */
export function houseKit(opts: HouseKitOptions): string {
	return `<style id="cairn-house">${houseKitCss()}</style><script id="cairn-house-api">${houseKitScript(opts)}</script>`;
}

/** Inject the kit as early as possible without breaking the document:
 *  after a head <meta charset> (it must stay within the first 1024 bytes of
 *  a downloaded file), else after <head>, else after <html>, else after the
 *  doctype (never before it — that would drop the page into quirks mode),
 *  else at the very start of a fragment. */
export function withHouseKit(html: string, opts: HouseKitOptions): string {
	const kit = houseKit(opts);
	const insertAt = (index: number) => `${html.slice(0, index)}${kit}${html.slice(index)}`;
	const body = html.search(/<body(?=[\s>])/i);
	const charset = /<meta\s[^>]*charset[^>]*>/i.exec(html);
	if (charset && (body === -1 || charset.index < body)) return insertAt(charset.index + charset[0].length);
	for (const tag of [/<head(?=[\s>])[^>]*>/i, /<html(?=[\s>])[^>]*>/i, /<!doctype[^>]*>/i]) {
		const match = tag.exec(html);
		if (match) return insertAt(match.index + match[0].length);
	}
	return `${kit}${html}`;
}
