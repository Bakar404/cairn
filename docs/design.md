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
| `app/globals.css` | The live tokens: light on `:root`, dark on `.dark`, high contrast on `[data-contrast="high"]` | Every component (Tailwind token utilities) |
| `src/core/palette.ts` | The same values as data (`PALETTE`), and their high-contrast twin (`PALETTE_HC`) | Generator prompts, the demo kit, the figure palette, the code themes, the theme-color meta, the Electron title bar (mirrored in `electron/main.cjs`) |
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
  selections, checkboxes, focus borders and the focus outline read it
  too.
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
- High contrast raises the inks to 7:1 and the hairlines and data hues to
  4.5:1 (see High contrast).

### Focus

- Keyboard users always see where focus is; pointer users never do.
  `components/input-modality.ts` sets `<html data-input-modality>`
  (`keyboard` on Tab, Shift+Tab or F6, `pointer` on any pointer press),
  and the one focus rule in `app/globals.css` draws only in keyboard
  modality. No other key changes the modality, so arrow keys after a
  click never light an outline.
- The outline is 2 px of `--primary` with a 2 px gap: ink on paper in
  both modes, over 14:1 against page and card. The Enhanced focus
  indicator (Settings → Accessibility, `data-focus="enhanced"`) makes it
  4 px with a 3 px gap, and under
  forced colors it draws in the system `Highlight` color.
- Components don't draw their own focus rings. Button, Input and
  Textarea dropped shadcn's `focus-visible:ring-*` shadows; inputs keep
  the `--ring` border on focus. A surface that holds focus only as a home
  (a dialog container, a menu body) carries `data-focus-container` or
  `data-lh-menu` and draws nothing, because its controls do.
- A control that appears on hover (the copy and expand corners on code
  and diagrams) also appears on `focus-visible`.

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
Eased, never bouncy.

### Reduced motion

- Settings → Accessibility → Motion: System (the default, which follows
  `prefers-reduced-motion` live), Reduced, or Full. Full keeps motion on
  even when the OS asks for less.
- `<html data-motion="reduced|full">` is the single answer.
  `A11Y_BOOT_SCRIPT` (`src/core/accessibility.ts`) sets it before first
  paint, and the `AccessibilityProvider`
  (`components/settings/accessibility.tsx`) keeps it current.
- CSS: `app/globals.css` redefines the `motion-safe:` and
  `motion-reduce:` variants on `data-motion`, so the setting can
  overrule the OS. Anything that loops or travels carries
  `motion-safe:`: spinners and pulses stand still, and chevrons and
  switch thumbs snap. The custom keyframes (`.braille-frame`,
  `.dock-variant`, `.settings-dialog-pop`, `.graph-chrome-fade-in`,
  `.lh-card-enter`) stop under `html[data-motion="reduced"]`. Color,
  opacity and blur fades stay. Streamdown's loading spinners use the
  bare `animate-spin`, so a rule beside its `@source` line stops the
  bare loop utilities too.
- Script asks `motionReduced()` or `useMotionReduced()`
  (`components/reduced-motion.ts`). Scrolling to the latest message is
  instant, the fold fade and height morph are skipped, the plan and
  diagram zooms stop easing, the mode crossfade is skipped, and the
  graph lands each zoom step at once and runs a physics change (and its
  load) to rest before drawing. Dragging a node still moves the graph,
  because the user is moving it.
- Motion (`motion/react`) follows through a `MotionConfig` in the
  provider, and the reasoning shimmer renders as still, muted text.
- `e2e/motion.spec.ts` covers it: what each keyframe class runs under
  Reduced, Full and System, the saved choice applied before the
  settings load, and the graph opening at rest.

## Accessibility

Settings → Accessibility holds accessibility mode. The page runs:

1. **Presets** (see Presets), each a switch.
2. **System:** Follow system accessibility settings (see Following the
   OS).
3. **Display:** Contrast (see High contrast), the Focus indicator (see
   Focus) and Motion (see Reduced motion).
4. **Screen reader:** Expand figure descriptions (see Figures) and
   Announce tool steps (see Screen readers).
5. **Advanced**, collapsed: the reading sliders (see Reading comfort) and
   the WCAG text-spacing check. It's a button disclosure, not
   `<details>`: the dialog's Tab trap counts what a closed `<details>`
   holds as tabbable, and a `hidden` panel is out of it.
6. **Reset accessibility settings** (see Presets), outside Advanced, so
   it's in view while Advanced is collapsed.

### Screen readers

- The transcript is a `role="log"` region, so a screen reader reads what
  is added to it, but not when the teacher starts or stops replying.
  `components/reply-announcer.tsx` says that in a polite status region,
  mounted empty and outside the log: "Cairn is replying…" once a reply
  has been busy for 100 ms, and "Reply finished" once it has been idle
  for a second, so the hand-off to an owed continuation stays one reply.
  Each line clears after 7 s, so the next reply's identical line is
  spoken again.
- Announce tool steps (Settings → Accessibility, off by default) also
  names a tool step that is still running after 5 s, by its activity
  label ("Searching file contents…"), at most once every 15 s.
- The message being streamed carries `aria-busy="true"`, which asks a
  screen reader to wait for the whole message instead of reading each
  chunk. Spinners are labeled images (`role="img"`), not live regions,
  so the announcer is the only thing that speaks.
- `tests/reply-announcer.test.tsx` runs the announcer under a virtual
  screen reader and checks that each line is spoken exactly once.

### High contrast

- **Contrast** (Standard or High) raises the app to WCAG's enhanced
  contrast (AAA). High sets `<html data-contrast="high">`, and so does a
  system that asks for more contrast while Follow system is on (see
  Following the OS). The select shows the stored choice; while the OS
  raises it, the hint says "High for now: your system asks for more
  contrast".
- **The palette** is `PALETTE_HC` (`src/core/palette.ts`).
  `highContrast()` moves each ink, edge and data color in OKLab lightness
  alone (darker on paper, lighter at night), by the least that holds its
  floor, so every hue stays, and its chroma too where sRGB allows. The
  surfaces stay. The floors (`HIGH_CONTRAST_FLOORS`):
  - Inks (foreground, muted-foreground, brand, success, warning, danger)
    ≥ 7:1 on page, card, muted and accent. A semantic ink also holds 7:1
    on its own soft tint over the page or a card, and brand-foreground
    holds 7:1 on the brand.
  - Hairlines, field edges and the ring ≥ 4.5:1 on the same four
    surfaces.
  - Data hues ≥ 4.5:1 on page and card.
- **The CSS.** `html[data-contrast="high"]` and
  `html.dark[data-contrast="high"]` in `app/globals.css` carry
  `PALETTE_HC`, written out, so nothing computes at runtime. Every value
  is `!important`, so High beats a custom background (Appearance's inline
  variables) and the custom bold and italic colors, which take the ink.
  Standard gives them back. The derived tokens (the soft tints,
  `--code-surface`) follow.
- **Faded neutrals.** `text-muted-foreground/70` and its kin lay a 7:1
  ink at partial alpha, which gives the ratio back, so at High they take
  the full ink. Variants (`hover:`, `dark:`, `disabled:`) keep their own
  colors. Faded hairlines take the full `--border` too, though today
  every border already paints it: an unlayered `* { border-color }` rule
  outranks Tailwind's border utilities.
- **Painters.** `usePaletteKey` changes with the contrast and
  `livePalette` reads the tokens as `<html>` resolves them, so the
  knowledge graph, Mermaid, themable figures and kit demos (through the
  `cairn-theme` message) repaint at High.
- **Not covered:**
  - Code highlighting stays at AA (see Code blocks).
  - Legacy demos keep their own colors on white.
  - Unmeasured: a semantic tint over muted or accent, text selection's
    brand wash, and the 90% hover fills of the brand and success buttons.
- `tests/palette.test.ts` regenerates `PALETTE_HC`, checks every floor
  and holds the CSS to it. `e2e/contrast.spec.ts` checks what the browser
  paints, in both schemes: the palette, a custom background beaten and
  given back, the faded neutrals, and axe's AAA rule
  (`color-contrast-enhanced`) on every page and Settings section, demo
  frames aside.

### Following the OS

- **Follow system accessibility settings** (on by default) lets the OS
  raise the app's contrast and turn its translucent surfaces solid. Off,
  both stay standard whatever the OS asks. Motion has its own System
  choice (see Reduced motion), and forced colors are always honored.
- The `AccessibilityProvider` reports the OS on `<html>` as it is,
  whatever the settings say, in the media-feature vocabulary:
  `data-os-contrast` (`more` or `no-preference`), `data-os-transparency`
  (`reduce`), `data-os-forced-colors` (`active` or `none`),
  `data-os-differentiate` (`without-color`) and `data-os-inverted`
  (`inverted`). Nothing styles off `data-os-inverted` yet.
- Two sources feed them, and the OS asks for a thing when either says so.
  The browser's media queries (`prefers-contrast: more`,
  `prefers-reduced-transparency: reduce`, `forced-colors: active`) are
  read live. In the desktop app, `electron/main.cjs` adds Electron's
  `nativeTheme` flags: each load pulls them through
  `window.lh.getSystemAccessibility()`, and every change is pushed through
  `onSystemAccessibility`, so a contrast theme switched on while the app
  runs applies without a reload. A high-contrast theme counts as asking
  for more contrast. Inverted colors and "Differentiate without color"
  have no media query, so only the desktop app sees them.
- The effective answers go on `data-contrast` (`high` when chosen, or
  when following the OS and it asks for more) and `data-transparency`
  (`reduced` only when following the OS and it asks).
  `accessibilityAttributes` (`src/core/accessibility.ts`) is the rule, and
  `A11Y_BOOT_SCRIPT` applies it before first paint from the media queries
  and the cached switch.
- **Reduced transparency:** the `bg-card/…`, `bg-background/…` and
  `bg-popover/…` surfaces (the floating toolbars, overlays and dialog
  scrims) paint solid, and `backdrop-blur` stops.
- **Differentiate without color** (macOS) underlines every link. It's an
  observation, not a preference, so it ignores the switch.
- **Forced colors** (a Windows contrast theme) repaint the page in the
  user's system palette and drop author fills, so a state shown by a fill
  alone disappears. `app/globals.css` draws those states in system colors:
  - A switch's track and disc are `ButtonFace` and `ButtonText`; on, they
    are `Highlight` and `HighlightText`.
  - A chosen option fills with `Highlight`, its text in `HighlightText`,
    the way Windows draws a selection. The rule keys off state attributes
    rather than tints, so components carry them: `aria-current` (the open
    session, the current model, thinking level and font, the open
    Settings section), `aria-pressed` (the home page's mode pills, the
    session filter), checked radios and checkboxes, selected options and
    tabs, and `data-selected` for a read-only record (the learner's answer
    on an answered card).
  - A list whose focus stays in its search field (the session search, the
    model menu) marks its arrow-walk cursor with `data-highlighted`: a
    dashed inset `Highlight` outline, `HighlightText` on a filled row. It
    gives way to the focus ring when the row itself holds keyboard focus.
  - The answered card puts each row's verdict in words for screen readers
    ("Your answer, incorrect", "Correct answer"): its tints flatten here,
    and its ✓ and ✗ marks are hidden glyphs.
  - A custom-drawn range thumb draws in `ButtonText`.
  - The browser never repaints a canvas, so the knowledge graph draws in
    the system palette itself: nodes and labels in `CanvasText`, edges in
    `GrayText`, clusters tinted `Highlight`. `usePaletteKey` changes with
    forced colors and high contrast, so the graph and Mermaid redraw.
  - Forced colors alone leave `data-contrast` standard: they replace the
    palette rather than raise it. A high-contrast theme usually also asks
    for more contrast, which does raise it.
  - Still lost: emphasis shown by color alone, the inline-code chip, and
    the confidence rail's gradient.
- `e2e/follow-os.spec.ts` covers it: contrast and transparency live and
  from the boot script, the switch and selection paint under forced
  colors, and the desktop flags through a stubbed `window.lh`.

### Reading comfort

- **Five sliders** under Advanced space the teaching prose (`.lh-prose`).
  Spacing is in multiples of the text size (em), so it follows the
  Reading font size; the width is in characters (ch). The ranges are
  `A11Y_RANGES` (`src/core/accessibility.ts`):

  | Slider | Range | Unset |
  |---|---|---|
  | Line height | 1–2×, in steps of 0.05 | 1.5× |
  | Paragraph spacing | 0–2.5×, in steps of 0.05 | the prose's own 1rem gap |
  | Letter spacing | 0–0.5×, in steps of 0.01 | the font's own |
  | Word spacing | 0–1×, in steps of 0.01 | the font's own |
  | Reading width | 45–90 characters, in steps of 5, then Full | Full |

- **On `<html>`.** `accessibilityVars` turns the section into variables:
  `--lh-prose-leading` always, and `--lh-paragraph-spacing`,
  `--lh-letter-spacing`, `--lh-word-spacing` and `--lh-reading-width`
  only while set. The `AccessibilityProvider` writes them and caches them
  with the attributes, and `A11Y_BOOT_SCRIPT` applies the cache before
  first paint.
- **The CSS** (`app/globals.css`, "Reading comfort"). Each rule falls back
  to `revert-layer`, so while its variable is unset the page is exactly
  what it was.
  - Letter and word spacing go on the prose root and on headings, which
    carry Tailwind tracking of their own. The rest inherits.
  - Paragraph spacing replaces the margin after every paragraph but the
    last.
  - Reading width caps paragraphs, lists, headings and quotes. The cap
    takes in the box's padding, so a list's indent counts toward it, and
    each block measures `ch` in its own font, so a heading's cap is
    wider. Code, tables, math and figures keep the full column.
  - Code, math, tables, figures and diagrams keep normal letter and word
    spacing, from `@layer base`, so a utility can still set its own.
    Mermaid labels are SVG text in boxes measured when the diagram draws,
    and added spacing would overflow them.
  - Line height sets the prose's own, which running text inherits.
    Headings keep their own, tighter line height (1.3× on a lesson's
    `h2`).
- **The Slider** (`components/settings/controls.tsx`) is a native range
  input, so the arrow keys, Home and End move it. Its value shows beside
  it and is read in words through `aria-valuetext` ("1.5 times the text
  size", "80 characters", "Full width"). An unset field shows and reads
  "Default" until the thumb moves. A write waits until the thumb settles,
  250 ms after the last change or at once on blur, so a drag or a run of
  arrow keys is one PUT. The track and its Reset are 24 px tall (WCAG
  2.5.8). Reset shows only while the field is set; it clears the field
  and hands focus to the slider, because the button then hides.
- **WCAG 1.4.12** (Text spacing) asks that nothing is lost at line height
  1.5×, 2× after paragraphs, 0.12× between letters and 0.16× between
  words. The WCAG text spacing preset (see Presets) sets exactly that.
  `e2e/reading.spec.ts` turns it on for a lesson and checks the spacing
  its paragraphs and headings compute, that code keeps its own, and that
  no text that showed whole before is cut off after. It also moves
  Reading width by keyboard and checks the cap and both Resets.

### Presets

- A preset is a named set of values, not a mode
  (`src/core/accessibility-presets.ts`), and a switch, like the page's
  other on/off settings. Turning one on writes its values into the
  settings, where each stays editable on its own, and nothing records
  which preset was turned on. The switch is on while every value it
  writes is current; an unset field counts as its default.

  | Preset | Writes |
  |---|---|
  | Low vision | Contrast High, Focus indicator Enhanced, line height 1.5×, paragraph spacing 2.25×, reading width 80, Reading font size 20 px, and 125% zoom in the desktop app |
  | Reading comfort | Line height 1.5×, paragraph spacing 2.25×, reading width 80 |
  | Reduce motion | Motion Reduced |
  | Screen reader | Expand figure descriptions and Announce tool steps on, and Graph rendering off, so home shows the chains view |
  | WCAG text spacing (under Advanced) | Line height 1.5×, paragraph spacing 2×, letter spacing 0.12×, word spacing 0.16× |

- Turning a preset off returns each value it wrote to its default, not to
  what was there before; a value changed since stays. Reading comfort's
  values are part of Low vision's, so turning Low vision on shows both
  on, and turning it off turns both off. Turning Reading comfort off
  under Low vision clears the spacing, and Low vision shows off with its
  other values still set.
- A preset writes Appearance, then Graph, then Accessibility, one PUT at a
  time, so each carries the record as it stands. Zoom isn't stored: it's
  set last, only in the desktop app, and doesn't count toward the switch.
  Turning Low vision off returns the zoom to 100% while it's still 125%; a
  zoom changed since stays.
- **Reset accessibility settings** sits at the bottom of the page,
  outside Advanced. It clears the Accessibility section and turns every
  preset off where it writes elsewhere: a Reading font size of 20 px,
  Graph rendering off and a 125% zoom return to their defaults, whichever
  page set them. Another font size or zoom stays. Like the Keyboard page's
  Reset all, it's always enabled: a button that disabled itself would drop
  keyboard focus to the page.
- `e2e/presets.spec.ts` turns Low vision on and off and checks what it
  writes, then checks that Reset is in view while Advanced is collapsed
  and turns Low vision and Screen reader off, their Appearance and Graph
  values included.

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

To assistive technology the canvas is one image (`role="img"`) named by
its counts ("Knowledge graph: 12 propositions in 3 chains."). Just before
it in the Tab order, a skip link, hidden until focused, reads "View the
graph as a list" and opens the Chains table.

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
- **Text alternatives.** The makers describe what they draw
  (`describe_figure`, `describe_animation`;
  `components/artifacts/text-alternative.tsx`). The alt names the image; a
  figure without one is "Figure", and an animation without one is named by
  its title. The description sits under the card in a "Describe"
  disclosure, closed unless Expand figure descriptions (Settings →
  Accessibility) is on. An animation's is "Transcript", which adds one
  line per beat ("0:03 — text"), and its video carries the beats as a
  WebVTT descriptions track.
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
   together, then run `tests/palette.test.ts` (drift and contrast). A
   change to `PALETTE` moves its high-contrast twin too: the test fails
   with the new `highContrast(PALETTE)`, so write those values into
   `PALETTE_HC` and the two `[data-contrast="high"]` blocks.
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
