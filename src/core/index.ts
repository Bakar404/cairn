/**
 * THE CORE PUBLIC API — the only module the shell (app/, components/) may
 * import. Everything exported here is browser-safe: pure logic + types,
 * no node builtins, no fs, no network.
 *
 * Server-side surfaces (chat streaming, store reads) live behind
 * src/server's barrel instead — the import law (eslint.config.mjs):
 *
 *   components/**  →  "@/src/core"        (this barrel, ONLY)
 *   app/**         →  "@/src/core" + "@/src/server"
 *
 * Server-only core modules (core/graph.ts emission/derivation) are pure
 * but need storage ports passed in by a server caller, so they are
 * deliberately NOT re-exported here — the server imports them directly.
 * The storage PORT TYPES are types-only and browser-safe, hence re-exported.
 */

export * from "./contracts.ts";
export * from "./ports.ts";
export * from "./chains.ts";
export * from "./render-settings.ts";

export * from "./question-core.ts";
// The event bus (push architecture, 2026-10-02): vocabulary + emit/subscribe
// for every layer; the browser shell consumes the types + the runtime names
// through this barrel (shell law: pure core via @/src/core only).
export * from "./events.ts";
// clusters.ts (Louvain) is deliberately NOT re-exported: nothing in the
// shell runs community detection — the snapshot carries the partition
// from the server. Keeping it out keeps the heavy clustering deps out of the
// client bundle (verified 2026-09-13: chunks contained it while this
// line existed). Same logic as layout-settle.ts below.
export * from "./layout.ts";
export * from "./plan-tree.ts";
export * from "./phases.ts";
export * from "./pending.ts";
export * from "./prompt-segments.ts";
export * from "./math-delims.ts";
// Wave B (owner-approved 2026-09-26): the native record (LhMessage), the
// and the input-events contract — all
// pure logic, browser-safe.
export * from "./native-messages.ts";
export * from "./compaction.ts";
export * from "./input-events.ts";
// Wave D (owner-approved 2026-09-26): the client view model — the grouping
// canon (one continuous assistant document, step separators) ported from
// the deleted server projection to the client side. Pure, browser-safe.
export * from "./view.ts";
export * from "./tool-parts.ts";
export * from "./answer-presentation.ts";
export * from "./prices.ts";
export * from "./context-usage.ts";
export type { CopilotAccount, CopilotAccounts, CopilotLogin, CopilotLoginProvider, CopilotLoginStep, CopilotStatus } from "./contracts/copilot.ts";
export * from "./cost-summary.ts";
export * from "./fuzzy.ts";
// settings.ts + settings-resolution.ts (settings-storage wave, 2026-09-19):
// the user-settings record's shape/sanitizer (pure) and its fully-resolved
// view. Browser-safe — the Wave-4 panel imports these directly.
export * from "./settings.ts";
// theme-mode.ts (design wave): light/dark/system — the mode type, scheme
// resolution, and the no-flash boot script the root layout inlines.
export * from "./theme-mode.ts";
// palette.ts (design wave): the globals.css palette as data, for the
// generators and native chrome that cannot read CSS.
export * from "./palette.ts";
// demo-house.ts (design wave): the stylesheet + window.cairn API injected
// into every kit-built demo (the card, downloads, and headless runs).
export * from "./demo-house.ts";
// figure-theme.ts (design wave): the figure palette (SVG, Manim) and the
// role-by-role re-coloring that lets an SVG figure follow the scheme.
export * from "./figure-theme.ts";
// code-theme.ts (design wave): the two Shiki themes code blocks highlight
// with, from the same palette.
export * from "./code-theme.ts";
// graph-deletion.ts (wave 6): the whole module is PURE but storage-port
// driven — the deletion RUNS server-side only. The shell needs exactly one
// two type-only things from it: the ChatDeleteMode union (the delete
// dialog's two-option design + the DELETE query param) and the stats
// shape its success line describes, hence this type-only re-export.
export type { ChatDeleteMode, ChatDeletionStats } from "./graph-deletion.ts";
export * from "./settings-resolution.ts";
export * from "./search.ts"; // search port (search wave, 2026-09-20)
// manim.ts (M13): the animation renderer port + media URL helper — types
// and pure helpers; the docker adapter lives in src/server/manim.ts.
export * from "./manim.ts";
// workiq.ts (M10): the Work IQ client port, setup steps, question template
// and answer parser; the stdio adapter lives in src/server/workiq.ts.
export * from "./workiq.ts";
export * from "./session-find.ts";
export * from "./session-navigation.ts";
// auth-keys.ts (auth-keys wave, 2026-09-19): the curated key catalog +
// shape rules + masking — pure, browser-safe (the auth page binds to the
// /api/keys routes built on it).
export * from "./auth-keys.ts";
// keyboard.ts: the shortcut registry + binding normalization (pure, browser-safe).
export * from "./keyboard.ts";
export * from "./coverage.ts";
// session-markdown.ts (2026-09-27 engine; first consumer 2026-10-06): the
// ONE session→markdown formatter — the extractor's view and the user-facing
// export share it. Pure, browser-safe.
export * from "./session-markdown.ts";
// storage.ts (OneDrive wave, 2026-10-27): where the library lives — the
// Settings › Storage types and the PUT /api/storage parser. Pure; the moves
// live in src/store/library.ts.
export * from "./storage.ts";
