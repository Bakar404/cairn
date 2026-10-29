# Changelog

All notable changes to Cairn are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Bakar404/cairn/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Bakar404/cairn/releases/tag/v0.4.0
