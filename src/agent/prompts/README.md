# Prompt fragments

System prompts are composed at agent construction (src/agent/teacher-agent.ts), one composition per agent — the probe/teach split (docs/probe-teach-split.md):

1. `src/agent/system-prompt.md` — the SHARED base: the agent intro, the voice, the philosophy (why the system exists), and the accuracy rule. The teaching method (Principle i / Principle ii, the click, the arc, the hedge) lives in `teacher/05-method.md` — teacher-only since the prober never teaches.
2. Every numeric-prefix `*.md` fragment in the agent's directory (`prober/` or `teacher/`), in **sorted filename order**, joined with `---` separators. The agent's own job and method LEAD the composition (the 2026-09-27 reorder). The loader enforces the numeric prefix (`\d*-*.md`) — other files (like this README) never enter the model's prompt.
3. The `shared/` fragments, as a trailing appendix (tool/file/format mechanics).

Rules for adding a fragment:

- Name it with a numeric order prefix, inside the right agent directory.
- `shared/` fragments compose into BOTH the prober and the teacher (after the
  base and their own fragments — a trailing appendix): cross-agent doctrine only,
  phase-neutral by construction: `10-voice.md`, `15-accuracy.md`,
  `16-mental-model.md`, `20-question-tools.md` (tool MECHANICS only; what to ask
  is each phase's own doctrine), `25-confidence.md`, `30-learner-files.md`,
  `35-source-evidence.md` (checked quotes and diff hunks in the session context),
  `36-learning-goals.md` (a certification or repository goal in the session context),
  `40-formatting.md`. The "never reference the other agent's tools" rule below
  still applies, so shared fragments may only cover tools both agents actually hold.
- `practice/` composes its own fragments plus a curated shared allowlist
  (`PRACTICE_SHARED_FRAGMENTS` in `src/agent/prompt-segments.ts`): voice,
  accuracy, mental model, formatting. Practice-only doctrine stays in
  `practice/` — `20-code-changes.md` is its rule for code-change evidence.
- One fragment per workstream — your brief tells you which filename you own.
- Document YOUR agent's tools/behaviors exactly; reference tool input field names verbatim (they must match the zod schemas).
- Keep it tight: fragments are always in context. No restating the base prompt.
- The two agents share one transcript but never one toolset — never reference the other agent's tools as if you had them.