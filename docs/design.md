# Design system

Decided 2026-10-28 (owner brief: the interactive demo "looks very AI
generated" — subtle color that feels smooth, a light mode, and every
generated artifact consistent with the app: demos, charts, diagrams,
figures). References: open-design's craft rules (anti-AI-slop, color,
typography) and the figure grammar of the claude.dev post "Automating eval
design and hillclimbing".

Palette revised the same day (owner: "more interesting and stylish …
simple and intuitive", and the top-left logo must adapt in light mode):
**Ink & Paper** replaced the first wave's warm stone and clay. The clay
accent sat between the semantic red and amber, so the main action read
like a warning; cobalt reads only as "act".

**One law: the app and everything it generates draw from ONE palette.**
Components use tokens; Mermaid, the graph canvas, demos, SVG visuals,
Manim renders, and code highlighting all resolve the same names, in both
modes.

## Sources of truth

| Where | What | Who reads it |
|---|---|---|
| `app/globals.css` | The live tokens: light on `:root`, dark on `.dark` | Every component (Tailwind token utilities) |
| `src/core/palette.ts` | The same values as data (`PALETTE`) | Generator prompts, the demo kit, the figure palette, the code themes, the theme-color meta, the Electron title bar (mirrored in `electron/main.cjs`) |
| `components/theme-tokens.ts` | `livePalette(scheme)`: the tokens as `<html>` resolves them now | Browser painters (graph canvas, Mermaid), so a custom background still applies |
| `tests/palette.test.ts` | Fails when the CSS and the table drift, or a contrast floor breaks | CI |

## Palette

Ink & paper: cream paper (OKLCH hue ≈ 85, chroma ≤ 0.016) under navy ink
in light; dark turns it over — midnight navy (hue ≈ 262, chroma ≤ 0.031)
under cream ink. One cobalt accent, far from the semantic green, amber,
and red; quiet semantic colors; six even data hues. Never pure black or
white.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `#f9f5ed` | `#0c121d` | The page |
| `--card` / `--popover` | `#fdfbf7` | `#111825` | Raised paper; figure paper |
| `--muted` / `--secondary` | `#f2ece1` | `#171e2d` | Quiet fills |
| `--accent` | `#ece7dc` | `#1c2433` | Neutral hover wash — **not** a highlight |
| `--border` | `#e1dcd1` | `#283140` | Hairlines |
| `--input` | `#d7d2c7` | `#323b4a` | Control outlines |
| `--ring` | `#848c9c` | `#7a8798` | Neutral rings, diagram lines |
| `--foreground` / `--primary` | `#132243` | `#efe7d8` | Ink; buttons default to ink |
| `--muted-foreground` | `#5e6a82` | `#9aa6b5` | Secondary text, axes, ticks |
| `--brand` | `#2d62e7` | `#71b1fe` | THE accent (cobalt): focal marks and the one send/answer action |
| `--success` / `--warning` / `--danger` | `#217f40` `#9c6200` `#c5403f` | `#7fd091` `#f4c26a` `#f3817c` | Right / borderline / wrong |
| `--viz-1` … `--viz-6` | `#408ad8` `#cc6e32` `#359953` `#af6ec3` `#a58300` `#009698` | `#74b2f8` `#f2925b` `#73c385` `#ce95df` `#cfa936` `#2bc5c7` | Data series, in this order: blue, orange, green, plum, gold, teal |
| `--viz-muted` | `#8d929c` | `#6e757f` | De-emphasized data |

The data hues share one lightness and chroma per mode (OKLCH L ≈ 0.62,
C ≈ 0.14 on paper — gold and teal less, at the sRGB edge; L 0.75, C 0.12
at night), so no series shouts. Blue opens the order as the brand's
neighbour and orange, its complement, follows: a chart's first two series
are its most distinct. At night orange and gold carry C ≈ 0.135 — on the
navy page their faint graph washes would otherwise read grey.

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

### The mark

The sidebar logo (`components/lh-mark.tsx`, the owner's three stones) is
drawn in the ink, never in fixed greys: the top stone is `--foreground`
and the two below are mixed 82% and 58% toward `--background` (the
owner's white / 208 / 148 ramp). It turns over with the mode — cream
stones at night, navy on paper — and follows a custom background or ink.
It never takes the accent.

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
- Token classes take data hues: keywords plum (`--viz-4`), strings green
  (`--viz-3`), numbers and constants gold (`--viz-5`), functions and keys
  blue (`--viz-1`), types teal (`--viz-6`), tags and regexes orange
  (`--viz-2`). Diffs use success, danger, and warning.
- Each hue moves toward the ink only until it clears 4.5:1 on the code
  surface (`readableOn`); in dark mode the hues already clear it.
- No brand cobalt in code. The theme background is transparent:
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
| paper | `--card` | `#fdfbf7` | `#111825` | `#ffffff` |
| ink | `--foreground` | `#132243` | `#efe7d8` | `#1f1f1f` |
| muted | `--muted-foreground` | `#5e6a82` | `#9aa6b5` | `#6b6b6b` |
| faint | `--border` | `#e1dcd1` | `#283140` | `#d9d9d9` |
| accent | `--brand` | `#2d62e7` | `#71b1fe` | `#2563eb` |
| accent2 | `--viz-2` | `#cc6e32` | `#f2925b` | `#ea580c` |

Generators always draw with the **light** set — the visual maker's SVG
prompt, the animation maker's prompt, and the Manim `cairn_style` module
(`src/server/manim.ts`) — and ignore styling words in a brief. A raster
cannot change after it renders; an SVG can.

The display law (`components/artifacts/figure-image.tsx`):

- **A themable SVG** — every color is a figure color (house light or dark,
  the warm-stone or legacy set, white/black) or a pure grey — is
  re-colored by role (`themeFigureSvg`). The card renders BOTH variants
  and CSS (`dark:`) shows the right one: correct on the server render, no
  re-render on a flip. It sits on `bg-card` with no invert switch. Under a
  custom background, the current scheme's variant is rebuilt from the
  live palette.
- **Anything else** — an off-palette or functional color (`rgb()`,
  `hsl()`, named hues), `<image>`, `foreignObject`, script, color
  animation — plus PNG stills and MP4 animations, shows on light paper
  (`FIGURE.light.paper`) with the manual invert switch.
- **Downloads** always ship the original bytes.
- Figures drawn with the legacy palette or the first wave's warm-stone set
  (`STONE_FIGURE`) theme by role too, so older lessons join the house
  look. Older Manim renders keep their white paper.

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
   joins the role map in `figure-theme.ts`, the way `LEGACY_FIGURE` and
   `STONE_FIGURE` do.
4. `electron/main.cjs` mirrors the page and ink of both schemes for the
   native window (resize backing, Windows/Linux caption overlay); update
   it and `tests/desktop-platform.test.ts` by hand.
