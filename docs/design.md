# Design system

Decided 2026-10-28 (owner brief: the interactive demo "looks very AI
generated" — subtle color that feels smooth, a light mode, and every
generated artifact consistent with the app: demos, charts, diagrams,
figures). References: open-design's craft rules (anti-AI-slop, color,
typography) and the figure grammar of the claude.dev post "Automating eval
design and hillclimbing".

**One law: the app and everything it generates draw from ONE palette.**
Components use tokens; Mermaid, the graph canvas, demos, SVG visuals,
Manim renders, and code highlighting all resolve the same names, in both
modes.

## Sources of truth

| Where | What | Who reads it |
|---|---|---|
| `app/globals.css` | The live tokens: light on `:root`, dark on `.dark` | Every component (Tailwind token utilities) |
| `src/core/palette.ts` | The same values as data (`PALETTE`) | Generator prompts, the demo kit, the figure palette, the code themes, the theme-color meta, the Electron title bar |
| `components/theme-tokens.ts` | `livePalette(scheme)`: the tokens as `<html>` resolves them now | Browser painters (graph canvas, Mermaid), so a custom background still applies |
| `tests/palette.test.ts` | Fails when the CSS and the table drift, or a contrast floor breaks | CI |

## Palette

Warm stone neutrals (OKLCH hue ≈ 80, chroma ≤ 0.014), one clay accent,
quiet semantic colors, and six muted data hues. Never pure black or white.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `#f8f5f1` | `#131210` | The page |
| `--card` / `--popover` | `#fcfbf9` | `#191816` | Raised paper; figure paper |
| `--muted` / `--secondary` | `#f0ece7` | `#201e1b` | Quiet fills |
| `--accent` | `#eae7e1` | `#262421` | Neutral hover wash — **not** a highlight |
| `--border` | `#e0dcd5` | `#33302c` | Hairlines |
| `--input` | `#d6d2cb` | `#3d3a35` | Control outlines |
| `--ring` | `#918b83` | `#8a857e` | Neutral rings, diagram lines |
| `--foreground` / `--primary` | `#211e19` | `#e9e6e0` | Ink; buttons default to ink |
| `--muted-foreground` | `#69645c` | `#9f9b93` | Secondary text, axes, ticks |
| `--brand` | `#ab532f` | `#db8862` | THE accent (clay): focal marks and the one send/answer action |
| `--success` / `--warning` / `--danger` | `#3f7849` `#946523` `#af3c3a` | `#87c28f` `#e3ba74` `#e7827b` | Right / borderline / wrong |
| `--viz-1` … `--viz-6` | `#b76849` `#5377a0` `#668c5e` `#936188` `#ac853f` `#428787` | `#d58966` `#7fa2c9` `#8ab181` `#bc8db1` `#d9b572` `#76b5b4` | Data series, in this order |
| `--viz-muted` | `#8f8c85` | `#78746e` | De-emphasized data |

Derived in CSS (one formula for both modes): `--brand-soft`,
`--success-soft`, `--warning-soft`, `--danger-soft` (12–14% tints) and
`--code-surface` (a step into the page).

### Layers and discipline

- **Neutrals carry ~90% of every screen.** Hierarchy comes from surface
  steps (page → card → muted) and the three inks, not from color.
- **One accent, `--brand`, for focal marks and the screen's one
  send/answer action.** Focal marks: the `[!IMPORTANT]` callout border,
  link underlines, the plan's current-node glow, text selection, a
  diagram's focus node, a demo's or figure's subject. The action is
  `Button variant="brand"` (or `bg-brand` on a raw button): the composer's
  send, the home start button, the question dock's Answer and Submit
  answer. At most two visible uses per screen. Every other button stays
  ink (`variant="default"`) or quieter; `--primary` stays ink because
  selections, checkboxes, and focus borders read it too.
- **Semantic colors only when something IS right, borderline, or wrong**
  (graded answers, failures, the practice "Next problem" register).
- **Data hues in their fixed order** for anything plotted: graph regions,
  Mermaid series, demo series, figure accents.
- **Tokens only in components**: `bg-card`, `text-muted-foreground`,
  `text-success`, `border-brand/70` — never raw Tailwind palette classes
  (`text-emerald-500`, `bg-zinc-900`) or hex. Accepted exceptions: the
  modal scrim (`bg-black/50`), the shadcn destructive button's white
  label, and a legacy demo's white ground (see Demos).

### Contrast floors (tested, both modes)

- Inks — foreground, muted-foreground, brand, success, warning, danger —
  ≥ 4.5:1 on page and card; brand-foreground ≥ 4.5:1 on brand.
- Data hues ≥ 3:1 on page and card (graphical objects).
- Code tokens ≥ 4.5:1 on the code surface, page, and card.
- Graph region fields read as color (channel spread ≥ 16) yet stay a tint
  (≤ 1.6:1 against the page).
- Mermaid labels ≥ 4.5:1 on every fill the theme derives, including
  authored colors after snapping.

## Modes

- **Light / Dark / System** — Settings → Appearance, or the sidebar's
  mode switch (`data-testid="mode-switch"`). The factory mode is dark.
- `<html class="dark">` is the single source of truth. `MODE_BOOT_SCRIPT`
  (`src/core/theme-mode.ts`, inlined in `app/layout.tsx`) sets it before
  first paint from `localStorage["cairn-mode"]`, so there is no flash. The
  `AppearanceProvider` (`components/settings/appearance.tsx`) is the only
  writer afterwards: it caches the mode for the next boot and syncs the
  `theme-color` meta and the desktop title bar.
- User-initiated flips crossfade through a view transition (240 ms);
  reduced motion skips it.
- Painters outside CSS subscribe through `components/color-scheme.ts`
  (`useColorScheme`, `usePaletteKey`) and redraw on a flip. Nothing
  reloads: a running demo keeps its state.
- A custom background (Appearance) derives its own surfaces
  (`derivedPalette`) and applies only in the scheme it suits
  (`backgroundScheme`).

## Type

- Chrome: JetBrains Mono (`font-ui`). Prose: Source Sans 3
  (`font-prose`). Titles: CMU Serif bold (`font-title`).
- Chrome labels are small, uppercase, tracked, and muted — the card
  captions "Figure", "Animation", "Interactive demo" play the role of the
  reference post's "FIG n" label. Everything the learner reads (prose,
  demo text, figure labels) is sentence case.
- Numbers sit in mono with tabular figures and carry their units.

## Motion

150 ms standard, 100 ms for hover and press, 240 ms entering, on
`--ease-standard` (`cubic-bezier(0.2, 0, 0, 1)`) or `--ease-out-soft`.
Eased, never bouncy. Entrance animations and the mode crossfade honor
`prefers-reduced-motion`.

## Generated artifacts

| Artifact | Gets the palette from | On a mode flip |
|---|---|---|
| Mermaid diagrams | `livePalette` → `mermaidConfig` + `houseColors` | Re-renders |
| Knowledge graph | `livePalette` → canvas regions and inks | Repaints |
| Interactive demos | The house kit injected into the iframe | `postMessage`; the demo repaints itself |
| SVG visuals | `FIGURE.light` in the prompt → `themeFigureSvg` at display | CSS swaps the light/dark variant |
| Manim stills and animations | `cairn_style` (`FIGURE.light`) | Stay on light paper; invert switch |
| Code blocks | `CODE_THEME` (Shiki `cairn-light` / `cairn-dark`) | CSS (`.dark`) picks the dark token colors; no re-highlight |

### Mermaid (`components/mermaid-render.ts`)

- `mermaidConfig(palette, scheme)` on Mermaid's `base` theme: surfaces and
  inks from the live tokens, lines in `--ring`, series in data-hue order,
  and `class X focus` drawn with a `--brand` stroke.
- `houseColors()` snaps a chart's own colors (`classDef`, `style`,
  `linkStyle`, sequence `rect`/`box`) onto the house palette: red, amber,
  and green land on danger, warning, and success; other hues on the
  nearest data hue; fills become quiet tints under ink labels; greys
  become neutrals; a `focus` class loses its own colors. Old transcripts
  restyle too.
- Prompt (`src/agent/prompts/shared/40-formatting.md`): mark the one node
  that matters with `class B focus`; no `classDef`, `style`, or hex.

### Knowledge graph (`components/graph-view.tsx`, `graph-canvas.ts`)

Cluster regions take the data hue of a stable slot, laid down as its
vivid twin (`vividHex` in `src/core/palette.ts`: same hue and luma, more
chroma) so the faint region field (20% alpha by default) reads as a soft
tint of that hue instead of diluting to grey. On light, region labels are
pulled 30% toward ink to hold contrast.

### Code blocks (`src/core/code-theme.ts`)

Streamdown highlights code with two house Shiki themes
(`createCodePlugin` in `components/ai-elements/message.tsx`) instead of
GitHub's light and dark themes.

- Mostly ink. Punctuation and operators sit halfway to muted; comments
  are muted.
- Token classes take data hues: keywords plum (`--viz-4`), strings sage
  (`--viz-3`), numbers and constants ochre (`--viz-5`), functions and keys
  slate (`--viz-2`), types teal (`--viz-6`), tags and regexes terracotta
  (`--viz-1`). Diffs use success, danger, and warning.
- Each hue moves toward the ink only until it clears 4.5:1 on the code
  surface (`readableOn`); in dark mode the hues already clear it.
- No brand clay in code. The theme background is transparent:
  `--code-surface` paints the block.

### Demos — the house kit (`src/core/demo-house.ts`)

Demos never carry colors of their own. The card injects the kit
(`withHouseKit`) ahead of the demo's code, the way `globals.css` serves
components, so a demo built today restyles with the app tomorrow.

- **Variables**: every palette token, for both schemes, plus
  `--font-sans`, `--font-mono`, `--radius`.
- **Base styles** at zero specificity (`:where`) for semantic HTML: text,
  headings, buttons, range sliders, checkboxes, selects, number inputs,
  tables, figcaptions. Any selector a demo writes wins.
- **Classes**: `.row`, `.stack`, `.panel`, `.control` (label · input ·
  readout), `.readout` / `<output>`, `.note`, `.tabs`
  (`aria-selected="true"` marks the active tab), `button.primary`.
- **`window.cairn`** for canvas painters: `color(name)`, `viz(i)`,
  `alpha(name, a)`, `font("mono" | "sans")`, `palette()`, `theme`,
  `onTheme(fn)`.
- **Theme flips** arrive as `postMessage({ type: "cairn-theme", theme,
  vars })`; the iframe never reloads.
- **The builder** (`src/agent/subagents/demo-builder.ts`) is told to use
  tokens only and to ignore styling words in a brief ("dark theme",
  "accent #60A5FA"): a requested highlight becomes `--brand`, further
  ones `--viz-2`, `--viz-3`, …. `run_demo` loads the demo with the kit in
  light and rehearses a flip to dark after 1 s, so a demo that breaks on
  a flip fails before delivery. A delivered demo records
  `kit: HOUSE_KIT_VERSION`.
- **Versioning**: keep the kit's variables, classes, and API backward
  compatible; bump `HOUSE_KIT_VERSION` only if an old demo could no
  longer run.
- **Legacy demos** (no `kit` field) render as built, on white, with the
  invert switch. To restyle one, ask the teacher to rebuild it.

### Figures — SVG visuals and Manim (`src/core/figure-theme.ts`)

Six roles, taken from the app palette:

| Role | App token | Light | Dark | Legacy (pre-wave) |
|---|---|---|---|---|
| paper | `--card` | `#fcfbf9` | `#191816` | `#ffffff` |
| ink | `--foreground` | `#211e19` | `#e9e6e0` | `#1f1f1f` |
| muted | `--muted-foreground` | `#69645c` | `#9f9b93` | `#6b6b6b` |
| faint | `--border` | `#e0dcd5` | `#33302c` | `#d9d9d9` |
| accent | `--brand` | `#ab532f` | `#db8862` | `#2563eb` |
| accent2 | `--viz-2` | `#5377a0` | `#7fa2c9` | `#ea580c` |

Generators always draw with the **light** set — the visual maker's SVG
prompt, the animation maker's prompt, and the Manim `cairn_style` module
(`src/server/manim.ts`) — and ignore styling words in a brief. A raster
cannot change after it renders; an SVG can.

The display law (`components/artifacts/figure-image.tsx`):

- **A themable SVG** — every color is a figure color (house light or dark,
  the legacy set, white/black) or a pure grey — is re-colored by role
  (`themeFigureSvg`). The card renders BOTH variants and CSS (`dark:`)
  shows the right one: correct on the server render, no re-render on a
  flip. It sits on `bg-card` with no invert switch. Under a custom
  background, the current scheme's variant is rebuilt from the live
  palette.
- **Anything else** — an off-palette or functional color (`rgb()`,
  `hsl()`, named hues), `<image>`, `foreignObject`, script, color
  animation — plus PNG stills and MP4 animations, shows on light paper
  (`FIGURE.light.paper`) with the manual invert switch.
- **Downloads** always ship the original bytes.
- Figures drawn with the legacy palette theme by role too, so older
  lessons join the house look. Older Manim renders keep their white paper.

## Anti-slop rules

For the app UI and every generated artifact (adapted from open-design):

- Flat surfaces and 1 px hairlines. No gradients, glows, drop shadows,
  blur, or glass.
- No default Tailwind indigo or violet, no emoji as icons, no pill badges,
  no colored left-border callout cards.
- Inside a demo: no title banner or hero header (the card already shows
  the title); the subject gets the width; controls sit in one compact
  group, not a dashboard of cards.
- Accent at most twice per screen; series follow the data-hue order.
- Sentence case for anything the learner reads; no letter-spaced
  eyebrows inside artifacts.
- Motion is smooth and purposeful.

## Changing the palette

1. Edit `app/globals.css` (`:root` and `.dark`) and `src/core/palette.ts`
   together, then run `tests/palette.test.ts` (drift and contrast).
2. Generators interpolate `PALETTE` / `FIGURE` and the code themes derive
   from `PALETTE`, so new artifacts follow automatically, and the demo kit
   restyles every kit demo on its next render.
3. Figures already drawn with the previous figure colors stop being
   themable (they fall back to paper and invert) unless the previous set
   joins the role map in `figure-theme.ts`, the way `LEGACY_FIGURE` does.
