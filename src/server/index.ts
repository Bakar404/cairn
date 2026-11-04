/**
 * THE SERVER-SIDE SURFACE — the only src module (besides the core barrel)
 * that app/ may import. Route handlers and server components come through
 * here; nothing under app/ touches src/store or src/agent directly.
 */

export * from "./chat-handler.ts";
export * from "./events-stream.ts";
export * from "./chats.ts";
export * from "./graph.ts";
export { NotesImportError } from "../agent/subagents/extraction.ts";
// Checked quotes (M25): a PDF import's text, page markers included.
export { pdfBytesToText } from "../agent/subagents/pdf-ops.ts";
// Code changes as sources (M22): a commit range or pull request, read.
export { CodeChangeError, readCodeChange, type CodeChangeRead } from "./code-change.ts";
export * from "./commit-positions.ts";
export * from "./jobs.ts";
// Settings › Storage (OneDrive wave, 2026-10-27): where the library lives,
// and moving it to or from the work OneDrive.
export * from "./storage.ts";
// The Manim renderer (M13): Docker status + install for Settings, and the
// chat media files the animation/visual makers save.
export * from "./manim.ts";
// Work IQ (M10): the stdio MCP adapter the job runner asks through, and the
// Settings connection test.
export * from "./workiq.ts";
// Microsoft Learn (M21): the HTTP MCP adapter the researcher and the Goals
// picker read Microsoft's documentation through.
export * from "./learn-docs.ts";
// Learning goals (M21): the Goals picker's reads, and the guard its JSON
// routes (and the code-change import) share.
export * from "./learning-goals.ts";
// The due-for-practice queue (M20): practice sessions replayed through FSRS.
export * from "./review-queue.ts";
export * from "./same-origin.ts";
export * from "./stores.ts";
export { readRenderSettings, writeRenderSettings } from "../store/render-settings.ts";
// The settings record + prompt overrides (settings-storage wave, 2026-09-19).
// The *Record aliases keep the app/api/settings routes explicit about which
// seam they touch (the raw record, not the chat-section convenience view).
export {
	readSettings as readSettingsRecord,
	writeSettings as writeSettingsRecord,
	settingsStore,
} from "../store/settings.ts";
export { promptOverrides } from "../store/prompt-overrides.ts";
export { isValidSegmentPath } from "../core/prompt-segments.ts";
// The canonical segment discovery/resolution lives in the agent layer
// (composition is an agent concern); the barrel re-exports it for the
// routes — server→agent is the lawful direction (chat-handler precedent).
export { effectivePromptSegments, allSegmentPaths, readPromptOverride } from "../agent/prompt-segments.ts";

// The auth/keys composition (auth-keys wave, 2026-09-19): the curated
// key catalog + the env-reflecting store behind GET/PUT/DELETE /api/keys.
// Importing this module runs the idempotent boot fill-gap — every consumer
// keeps its plain process.env reads (that seam is the point).
export * from "./keys.ts";
export * from "./search.ts";
export { authStore } from "../store/auth.ts";
export * from "./settings-body.ts";
export * from "./turn-liveness.ts";
export * from "./turn-runs.ts";
export * from "./dismissal-park.ts";
export * from "./compaction.ts";
export { runPiTurn, piTurnResponse, type PiTurnHandle, type PiTurnSpec } from "./pi/ui-stream.ts";
export * from "./observability.ts";
export * from "./model-catalog.ts";
export {
	cancelCopilotLogin,
	continueCopilotLogin,
	copilotAccounts,
	copilotLogin,
	CopilotAccountError,
	refreshCopilot,
	signOutCopilotAccount,
	startCopilotLogin,
	switchCopilotAccount,
	type CopilotLoginInput,
} from "../agent/copilot/index.ts";
export { sessionCost } from "./pricing.ts";
