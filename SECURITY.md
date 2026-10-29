# Security policy

## Reporting a vulnerability

Please report security problems privately, through [private vulnerability reporting](https://github.com/Bakar404/cairn/security/advisories/new) for this repository. Don't open a public issue, pull request or discussion about them.

Include what you found, the steps to reproduce it, the version or commit you tested and the impact you expect. A minimal proof of concept helps.

Reports are handled on a best-effort basis. You'll get a reply once the report has been triaged, and a fix ships in a new release with an entry in [CHANGELOG.md](CHANGELOG.md). Credit is given in the advisory unless you'd rather stay anonymous.

## Supported versions

Only the [latest release](https://github.com/Bakar404/cairn/releases/latest) and the `main` branch receive security fixes.

## Scope

In scope, for example:

- The local server and its API. Cairn listens only on `127.0.0.1`. Anything that lets another machine, another user on the same computer or a website you visit reach it or act through it is in scope.
- The desktop app: its access check on the local API (`proxy.ts`), the Electron preload bridge and the update channel.
- Your GitHub sign-in. Cairn should never write a Copilot credential to disk, a log or the browser.
- Anything that lets someone else spend your Copilot usage.
- The sandboxes: interactive demos run in a `sandbox="allow-scripts"` iframe, and animations render in a Docker container with no network and no mounts.
- The release pipeline and the installers it produces.

Out of scope:

- Vulnerabilities in GitHub Copilot, the Copilot SDK, Electron, Next.js or another dependency itself. Please report those to their maintainers, but do tell us if Cairn uses one unsafely.
- Code that Cairn shares unchanged with [LearnHarness](https://github.com/amosblomqvist/learnharness). Report it here and consider reporting it upstream too.
- The warnings Windows and macOS show for the unsigned and ad-hoc signed installers. [Download](README.md#download) explains them.
