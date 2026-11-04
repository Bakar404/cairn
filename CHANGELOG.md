# Changelog

All notable changes to Cairn are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-11-04

This release adds the review queue, learning goals, the answer check, learning from code changes and PDFs, doctrine evals and accessibility settings. The installers pass automated checks on macOS, Windows and Linux but still haven't had a full hands-on pass on each system. Please [report problems](https://github.com/Bakar404/cairn/issues).

### Added

- **Accessibility settings.** Settings → Accessibility brings together the options below. Preset switches set several at once: Low vision, Reading comfort, Reduce motion and Screen reader, plus WCAG text spacing under Advanced. Each value a preset writes stays editable on its own, and turning the preset off returns those values to their defaults. Reset accessibility settings, at the bottom of the page, turns every preset off, the text size, graph view and zoom they set included, and returns the page to its defaults.
- **Keyboard access.** Every control can be reached with Tab and Shift+Tab, and keyboard focus always shows an outline (a click never does). The Enhanced focus indicator makes it thicker. A dialog holds focus while it's open and hands it back when it closes.
- **High contrast.** Contrast → High raises the app's text colors to 7:1 against their backgrounds (WCAG AAA), and its borders, field edges and chart colors to 4.5:1, in light and dark mode, each keeping its hue. It overrides a custom background and custom bold and italic colors until you turn it off. The knowledge graph, diagrams, and the figures and demos drawn in Cairn's palette repaint to match. Code highlighting keeps its standard colors.
- **Follow system accessibility settings** (on by default). When your system asks for more contrast, Cairn switches to High contrast, and when it asks for less transparency, translucent toolbars and overlays turn solid. Windows contrast themes are always honored: selections, switches and the knowledge graph draw in the theme's colors. System changes apply while Cairn runs, without a reload, and in the macOS desktop app, Differentiate without color underlines links.
- **Motion:** System (follows your system), Reduced or Full. Reduced stops spinners, pulses and other loops, and makes scrolling, zooms and the knowledge graph settle at once. Full keeps motion on even when your system asks for less.
- **Reading comfort.** Sliders under Advanced set the lesson text's line height, paragraph spacing, letter spacing, word spacing and reading width. They move with the arrow keys and read their values in words to a screen reader.
- **Screen reader announcements.** A screen reader hears "Cairn is replying…" when a reply starts and "Reply finished" when it ends, once each, and a reply is marked busy while it streams, so it can be read whole. Announce tool steps (off by default) also names a step that runs for a while, such as "Searching file contents…". An answered quiz states each verdict in words.
- **Descriptions of figures and animations.** The figure and animation makers now describe what they draw. A new figure gets alt text and a Describe section under it. A new animation gets a Transcript with a line per beat, and its video carries the beats as a WebVTT descriptions track. Expand figure descriptions opens them by default.
- **Accessibility checks in CI.** axe-core's WCAG 2.0–2.2 A and AA rules run against the production build in Chromium, with normal, forced-colors and reduced-motion settings, alongside keyboard, motion, contrast and reading checks. Violations are counted against a committed baseline that can only go down. Run them with `npm run test:a11y` after a production build.
- **Review queue.** Home's review pill counts the ideas due for practice ("3 due"). Cairn schedules them with FSRS from your practice sessions: an idea you solved unaided comes back later, one you needed hints for or missed comes back sooner. **Practice these** starts a session on the ten most overdue. An idea missed three times moves to **Keeps slipping**, where **Teach again** starts a fresh lesson on it instead of more drilling. Nothing new is stored: the queue is worked out from your sessions each time.
- **Answer check (on by default).** After a practice problem ends, a second model grades your final answer without seeing the tutor's verdict. When the two disagree, the problem's card says so and gives the check's reason, and the disagreement can only make the review schedule stricter. Switch it in Settings → Agent → Answer check.
- **Microsoft Learn (on by default).** Research can search and read Microsoft's official documentation and code samples on Microsoft Learn. Cairn sends Learn only the search words or the page address, never your lesson. Switch it in Settings → Agent → Microsoft Learn.
- **Learning goals.** **Set a goal**, beside the lesson box, aims a new lesson at a Microsoft certification or at a code repository. For a certification, Cairn reads the exam's study guide on Microsoft Learn and weights each skill area by its share of the exam, with no exam dumps or mock exams. For a repository, it reads the folder's dependency manifests and file names on your computer and lists the technologies; only the ones you keep go to the tutor, which teaches them from the repository's own code.
- **Learn from a code change.** **Code change…**, next to **Import notes…**, imports a GitHub pull request or a range of local commits into the knowledge graph, reasons first: the title, the description and the commit messages, then the diff. Practice on it asks *why* the code changed, with the diff in the problem. Public pull requests work as they are; for a private one, sign in with the GitHub CLI (`gh auth login`). Lock files, build output, vendored code, minified bundles, source maps, test snapshots and binary files are left out.
- **PDF import.** **Import notes…** takes PDFs too, page by page. Cairn reads a PDF's text layer and doesn't run OCR, so a scanned page adds nothing.
- **Checked quotes.** An idea taken from an imported document can keep the short passage it came from, checked word for word against the document, with its PDF page or the diff around it. A quote the document doesn't contain is dropped. The node's card shows these passages, and the tutor cites them.
- **Doctrine evals.** `npm run evals` checks recorded practice sessions against eight of the tutor's laws, such as one problem at a time, the solution hidden until the end and one hint per request, and runs in CI. `npm run evals -- --live` plays scripted learners against real models to record new sessions, and the Live evals workflow runs it on demand, weekly and when the prompts change, once a `COPILOT_GITHUB_TOKEN` secret is set.

### Changed

- **New keys.** Tab moves focus, as in other apps, instead of jumping between text fields; F6 and Shift+F6 do that now, in both directions. The thinking level moved from Shift+Tab to ⌘⇧K (Ctrl+Shift+K on Windows and Linux). Settings → Keyboard won't give a shortcut Tab, Shift+Tab, F6 or Shift+F6, and drops a saved one that used them.

### Security

- The requests that read a folder on your computer, a study guide or a code change are refused when they come from another site or aren't JSON, so a web page you visit can't make Cairn read your files or repositories.
- Reading a code change runs git and the GitHub CLI without a shell. Git reads only commits, never the working tree, with external diff and text-conversion programs, the filesystem monitor, signature checks and the pager turned off, so a repository's own settings can't make Cairn start a program.

## [0.4.0] - 2026-10-29

The first Cairn release. Cairn is a fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) 0.3.8, and this entry lists what changed from it.

This is an early release. The installers pass automated checks on macOS, Windows and Linux but haven't yet had a full hands-on pass on each system. Please [report problems](https://github.com/Bakar404/cairn/issues).

### Added

- **GitHub Copilot as the model connection.** Every lesson, sub-agent and one-off model call runs on your own GitHub Copilot plan through the official Copilot SDK. Sign in from Settings or the setup dialog with a personal, Enterprise Managed User or GitHub Enterprise Cloud (ghe.com) account. Signed-in accounts are listed with their Copilot plan, and you can switch between them. Cairn keeps only the account fields it uses: no token is stored or sent to the browser.
- **Web research through Copilot.** The researcher uses Copilot's hosted web search, so research needs no search API key.
- **Animations.** The tutor can hand off a short animated explanation. An animation agent writes a [Manim](https://www.manim.community/) scene, renders a preview, checks its frames and layout, fixes what's wrong, and only then renders the final video. Rendering needs Docker and runs in a container with no network access and no access to your files.
- **Work IQ (optional, off by default).** Before its first question, the prober can ask Work IQ, Microsoft 365 Copilot's MCP server, which parts of the subject your own work already touches. That only decides where the first question sits; it never counts as evidence of what you know.
- **Clearer asking and answering.** While a check waits for your answer, the dock offers separate **Ask Cairn** and **Answer** actions. Asking instead skips the question.
- **Light, dark and system modes** with a new Ink & Paper palette, a single cobalt accent and a logo that adapts to the mode. Interactive demos, diagrams, figures, charts and animations follow the same palette.
- **Library in your work OneDrive (optional).** Settings → Storage can keep your library (chats, knowledge graph, media and job records) in `Apps\Cairn` in your work OneDrive, synced by the OneDrive client. Sign-in, settings and Copilot state stay on the device, and Cairn itself never contacts OneDrive.
- **Desktop installers** for macOS (Apple Silicon), Windows (x64) and Linux (x64) on [GitHub Releases](https://github.com/Bakar404/cairn/releases), each with a build-provenance attestation you can check with `gh attestation verify`.
- **Repository checks:** CodeQL, dependency review on pull requests, Dependabot, an offline check of the links between docs, workflow linting, and release notes taken from this changelog.

### Changed

- Renamed from LearnHarness to Cairn, with a new stacked-stones icon. The desktop app keeps its data in its own Cairn folder, separate from any LearnHarness install.
- A finished animation, figure or demo now shows in the lesson while Cairn waits for you to answer the open question.
- The macOS build is ad-hoc signed instead of notarized: the first launch needs **Open Anyway** in System Settings → Privacy & Security, and you download new versions yourself. Windows and Linux builds still update in the app.

### Removed

- Model API keys, the ChatGPT sign-in and the other subscription bridges. GitHub Copilot is the only model connection.
- Dictation (Deepgram) and the Tavily and Brave search engines.

### Security

- `npm run dev`, `npm start` and `npm run desktop:dev` listen only on `127.0.0.1`, as the desktop app already did. Before, another machine on your network could reach Cairn by your computer's address.
- A Copilot session can no longer spend tokens on its own. A session left waiting on Cairn's tools is closed after 10 minutes, and one that starts a turn by itself is stopped at once.
- Next.js is updated to 16.4.2 for published advisories, including unauthenticated remote code execution. DOMPurify, sharp, undici, zod and source-map-js are on patched versions too.

[Unreleased]: https://github.com/Bakar404/cairn/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Bakar404/cairn/releases/tag/v0.5.0
[0.4.0]: https://github.com/Bakar404/cairn/releases/tag/v0.4.0
