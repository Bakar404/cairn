# Keyboard shortcuts

Decided 2026-09-17 (owner key-map review after the first draft; the whole
app must be usable with the keyboard only — voice first, keyboard as the
second pillar of input).

## Architecture

- **Registry**: `src/core/keyboard.ts` — `KEYBOARD_ACTIONS` holds every
  action: `{ id, label, scope, binding }`. The cheat sheet renders FROM
  the registry, so it can never list a non-functional shortcut.
- **Provider**: `components/keyboard-shortcuts.tsx` — one window-level
  keydown listener (bubble phase, mounted once in AppShell). Normalizes
  keys to `mod+d`-style strings, resolves overrides, dispatches
  `lh:kbd-<action-id>` window CustomEvents. Surfaces listen for their
  own events (matching the pre-existing `lh:chat-renamed` seam style).
- **Persistence**: overrides live under localStorage `lh:keymap` as
  `{actionId: binding}` merged over defaults. Settings → Keyboard edits
  them (rebind, reset). It refuses the reserved keys (Tab, Shift+Tab, F6,
  Shift+F6) and says why, and `loadOverrides` drops a stored override on
  one.
- **displayOnly entries**: the registry also lists SURFACE-owned keys
  (the question dock's row machine) for the cheat sheet only —
  `effectiveKeymap` skips them so bare arrows can never leak to pages
  where the surface isn't mounted.

## Rules

- **Tab moves focus** (accessibility mode, M27, 2026-10-30; this
  retires the 2026-09-17 "Tab is dead" rule). Tab and Shift+Tab reach
  every control in document order, and no shortcut may take them
  (`RESERVED_BINDINGS` in `src/core/keyboard.ts`).
- **F6 / Shift+F6** walk the active surface's text fields: the old
  plain-Tab field cycle, now in both directions. They work from inside a
  field and wrap; from outside the chain, F6 enters at the first field
  and Shift+F6 at the last. Under an open dialog they do nothing.
- **⌘⇧K / Ctrl+Shift+K** cycles the thinking level, also while typing
  in a field (modifier combos are the only keys that fire from typing
  surfaces; bare keys never do).
- **Dialogs** (`components/use-dialog-focus.ts`): opening one moves
  focus inside it (Cancel on the delete and abort confirmations,
  otherwise the dialog itself, so a screen reader reads its name first).
  Tab and Shift+Tab wrap inside the topmost dialog. Closing returns focus
  to the control that opened it; when that control is gone (a menu
  item), focus goes back to where it was when the dialog opened, the
  menu's trigger. The connection dialog keeps its own trap.
- **Menus** (`components/menu-shell.tsx`): ↑/↓ and Enter as before. Tab
  and Shift+Tab do nothing inside a menu; Esc closes it. A menu that
  closes with focus inside it in keyboard modality returns focus to its
  trigger (after a click, focus is left alone, so Space can't reopen the
  menu by surprise).
- **Enter submits from anywhere** (`components/enter-submits.ts`) except
  where Enter already means something: a keyboard-focused button, link
  or `<summary>` keeps native Enter, and inside a dialog or menu Enter
  always belongs to it.
- **Esc priority chain**: topmost popover → cheat sheet → abort turn
  (local stream only — a server-side wake turn has no client request to
  abort). Every element/document-level Esc handler that acts calls
  `e.stopPropagation()` so the window chain never double-fires. The
  session search claims Esc to blur back to normal, and a focused dock
  field claims Esc so the window chain never acts under the learner's
  typing.
- **Focus outline**: keyboard users see a 2px outline in `--primary`
  (4px under Settings → Accessibility → Focus indicator → Enhanced, the
  system Highlight color under forced colors); pointer users see none. `components/input-modality.ts`
  sets `<html data-input-modality>`: `keyboard` on Tab, Shift+Tab or F6,
  `pointer` on any pointer press. No other key changes it, so the quiz's
  ←/→ after a click never light an outline. That attribute is what the
  2026-09 outline experiment lacked: inputs match `:focus-visible` even
  on a click, so it showed a ring on plain click-focus and was rejected.
  Tooltips open on focus only in keyboard modality.

## Key map (Wave A — global)

| Action | Binding | Seam |
|---|---|---|
| ~~Toggle dictation~~ | ~~⌘D~~ | RETIRED (2026-10-27) — the Deepgram dictation was removed; voice input returns later on a different service |
| Model selector | ⌘K | `lh:kbd-open-model-picker` (model-picker.tsx) |
| Cycle thinking level | ⌘⇧K / Ctrl+Shift+K | `lh:kbd-cycle-thinking` (model-picker.tsx) |
| Next / previous text field | F6 / Shift+F6 | `lh:kbd-cycle-fields` with `detail.reverse` (field-cycle.ts) |
| Toggle sidebar | ⌘B | `lh:toggle-sidebar` (sidebar.tsx) |
| Sessions search | ⌘⇧F | `lh:kbd-sessions-search` (sidebar.tsx) |
| Walk search results | ↑ / ↓ *in the search field* | sidebar.tsx (cycles the filtered rows, wraps) |
| Open search result | Enter *in the search field* | sidebar.tsx (walked row, else the first match) |
| ~~Cycle session~~ | ~~⌥↑ / ⌥↓~~ | RETIRED (owner, 2026-10-10) — the search walk above replaces it |
| ~~Open selected session~~ | ~~⌥Enter~~ | RETIRED (owner, 2026-10-10) — the search Enter above replaces it |
| Jump to graph (home) | ⌘G | router.push in keyboard-shortcuts.tsx |
| New session | ⌘N | router.push in keyboard-shortcuts.tsx |
| Rename session | F2 | `lh:kbd-rename-session` (chat.tsx) |
| Cheat sheet | ? | keyboard-shortcuts.tsx |
| Find (graph: node search) | ⌘F | `lh:kbd-find` (graph-view.tsx; chat transcript search rides the same event when that feature lands) |

## Model menu keyboard machine (owner polish, 2026-09-17)

(Removed from the settings/cheat-sheet registry 2026-10-10 — obvious
in-field navigation; the behavior below is unchanged.)

While the model menu is open, focus stays in the search field and the
menu owns ↑/↓/Enter inside the input's own handler:

- **↑/↓** walk the filtered results — clamped, no wrap. First ↓ starts at
  the first row; first ↑ at the last. The walked row gets a muted ring and
  scrollIntoView.
- **Enter** picks the walked row, or the **first result** when nothing is
  walked yet (owner decision). Typing a new query resets the walk.
- Clicking and Enter share one `pickModel` path; Esc still closes the menu.

## Question dock row machine (Wave B, owner rounds 2026-09-17)

While a question is expanded, the dock owns ↑/↓/Space/Enter, and ←/→
on a quiz:

- **↑/↓** walk every answerable row in order — options first, then the
  quiz's "I don't know" / the ask's "Other…" (never both) — **clamped at
  the ends, no wrap** (owner: faster to navigate when the walk stops).
  The walked row gets a subtle ring (`bg-accent/40`) and scrollIntoView.
- **Space** acts on the walked row exactly like a click: multi toggles,
  single displaces; Other also focuses its inline input for typing.
- **Enter** submits once an answer exists (`canSubmit`). Before that,
  Enter on a keyboard-focused row activates it like a click.
- **←/→** step the quiz confidence from anywhere in the dock (owner, UI
  round 2026-10-01). The slider is also a native range input in the Tab
  order; the dock cancels its native step, so a key never moves it
  twice.
- **Tab** is native (M27). The rows are one Tab stop with a roving
  tabindex (the walked row, or the first when none is walked), so Tab
  goes rows → confidence slider → thinking field → Submit. Keyboard
  focus landing on a row walks it, so ↑/↓ continue from there, and focus
  follows the walk while the user is in the rows, so focused and walked
  never diverge. A click doesn't walk.
- Guards: keys from a typing surface keep their native meaning (arrows
  move the caret, space types — the thinking field is never hijacked),
  modifier combos are never the dock's (owner round 3), and an open
  dialog or menu owns its keys, so it never walks the rows behind it.
  The listener lives only while the dock is expanded — collapsed, the
  bar's native Enter expands it.

## Status

- Wave A (global plumbing + shortcuts above) — landed, CDP-verified.
- Wave B (question row machine) — landed, CDP-verified.
- Accessibility mode (M27, 2026-10-30): native Tab, F6 field walk,
  ⌘⇧K thinking cycle, dialog and menu focus, focus outline — covered by
  `e2e/keyboard.spec.ts`.
- Wave C remainder: ⌘F chat transcript search (new feature, needs its own
  design pass), ⌘I import notes on graph. ⌘F graph node search shipped
  early (owner live-tested the gap).