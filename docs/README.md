# Cairn documentation

To install and use Cairn, start with the [README](../README.md). These pages are for people who build, change or release it.

Many of these documents come from [LearnHarness](https://github.com/amosblomqvist/learnharness), the project Cairn is forked from, and still use its name. Where Cairn works differently, the document says so.

## Building and releasing

| Document | What it covers |
| --- | --- |
| [development.md](development.md) | Setup, commands, environment variables, the project layout and the desktop shell |
| [desktop-release.md](desktop-release.md) | The macOS, Windows and Linux installers, signing, CI and how to cut a release |
| [design.md](design.md) | The design system: palette, light and dark modes, and how demos, diagrams and figures follow it |
| [keyboard.md](keyboard.md) | Keyboard shortcuts |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to propose a change |
| [../CHANGELOG.md](../CHANGELOG.md) | What changed in each release |

## How it works

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The canonical architecture spec: layers, the import law, the five systems and their invariants |
| [teaching-methodology.md](teaching-methodology.md) | The theory of learning and teaching that the system prompts compress |
| [probe-teach-split.md](probe-teach-split.md) | The split between the probing and teaching agents, and how a lesson moves through its plan |
| [compaction-accounting.md](compaction-accounting.md) | How long conversations are compacted and how token usage is counted |
| [tool-content-recovery.md](tool-content-recovery.md) | How tool content written by the model is checked and repaired for display without changing what was stored |

## History

These record how the design got here. They are not kept up to date.

| Document | What it covers |
| --- | --- |
| [vision.md](vision.md) | The original LearnHarness vision and decision log |
| [pi-engine-swap.md](pi-engine-swap.md) | The move to the pi agent engine. In Cairn, pi runs the agent loop and every model call goes through the GitHub Copilot SDK. |
| [archive/plan.md](archive/plan.md) | The original build plan, wave by wave |
| [archive/release-0.3.md](archive/release-0.3.md) | Planning notes for LearnHarness 0.3.0 |
| [archive/architecture-2026-09-08.md](archive/architecture-2026-09-08.md) | The architecture spec before the September 2026 audit |
