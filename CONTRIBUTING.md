# Contributing to Cairn

Thanks for helping. Cairn is a fork of [LearnHarness](https://github.com/amosblomqvist/learnharness), which supplies the teaching method and most of the app. If your change isn't specific to Cairn, consider proposing it upstream too. Cairn-specific areas include Copilot, Work IQ, OneDrive, animations and the release pipeline.

## Set up

You need Node.js 22.12 or newer (or 20.19+); CI uses Node 26. To try the teacher by hand you also need a GitHub account with Copilot. The tests don't need one.

```bash
git clone https://github.com/Bakar404/cairn.git
cd cairn
npm ci
npm run dev          # http://localhost:3000
npm run dev:fresh    # a throwaway instance with no data, on port 3005
```

[docs/development.md](docs/development.md) covers the architecture, the environment variables and the desktop shell. [docs/README.md](docs/README.md) lists every doc.

## Before you open a pull request

```bash
npm run typecheck
npm test             # deterministic: no model calls, no network
npm run lint         # includes the import law (docs/architecture.md §2)
```

`npm test` and `npm run dev:fresh` use POSIX shell syntax, so on Windows run them from Git Bash or WSL. A few tests also assume POSIX paths, so CI on Ubuntu is the reference.

Also:

- Keep each pull request to one topic.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- For UI changes, follow [docs/design.md](docs/design.md) and attach screenshots in light and dark mode.
- Update the docs your change affects.
- Never commit tokens, your `data/` folder or personal learning content.

CI runs the checks above, a standalone build on macOS, Windows and Linux, CodeQL, an offline check of the links between docs and a lint of the workflows.

## Releases

The maintainer cuts releases from tags. [docs/desktop-release.md](docs/desktop-release.md) describes the pipeline and the release steps.

## License

Cairn is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). By contributing, you agree that your contribution is licensed under the same terms.
