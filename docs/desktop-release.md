# Desktop builds and releases

## Platforms

| Platform | Build runner | Packages | In-app update |
|---|---|---|---|
| macOS, Apple Silicon | `macos-26` (arm64) | DMG + ZIP, notarized or ad-hoc signed (see [macOS signing](#macos-signing)) | ZIP via Squirrel.Mac when notarized; manual download when ad-hoc signed |
| Windows, x64 | `windows-2025` | unsigned per-user NSIS installer | NSIS |
| Linux, x64 | `ubuntu-24.04` | AppImage + `.deb` | AppImage replacement; `.deb` through dpkg/apt with elevation if needed |

Windows signing is deliberately disabled for this first release. SmartScreen may warn about an unknown publisher on initial installation. AppImage is the primary Linux download because it is self-contained and updates without administrator permission. The installed `electron-updater` 6.8.9 also supports `.deb` updates; an update may request an administrator password. Both use the same download/restart banner.

The custom app bar stays on all three platforms. macOS keeps its left-side traffic lights; Windows/Linux use Electron's native right-side Window Controls Overlay, with CSS space reserved from the overlay's actual geometry. Windows/Linux hide the native menu until Alt is pressed. macOS keeps its system menu.

Icons are per-platform (2026-10-13): macOS compiles the Icon Composer document `build/icon.icon` via actool into `Assets.car` (macOS 26 Liquid Glass) plus a fallback icns that `scripts/after-pack.cjs` replaces with the full-res `build/icon.icns` (actool's caps at 256px); Windows embeds `build/icon.ico` and Linux uses `build/icon.png`. `node scripts/make-icons.mjs` generates all three from the flat design (`build/icon-flat.svg`); its icns step needs macOS (`iconutil`). Building the mac icon needs **macOS 26+ and Xcode 26+** (`actool`): Xcode 26's asset compiler crashes on macOS 15 because its host frameworks lack required symbols. `desktop:dist` injects `DEVELOPER_DIR` locally; release packaging uses `macos-26` and selects Xcode via setup-xcode. The older-OS fallback icon remains included. Linux's desktop identity is `cairn-learn.desktop`. Package-maintainer metadata comes from `package.json` `author`; support goes through [GitHub Issues](https://github.com/Bakar404/cairn/issues).

## Build pipeline

Each OS installs its own dependencies and builds its own Next standalone tree:

1. `npm ci`
2. Native PDF/SVG renderer tests for that OS, running in Electron's bundled Node (no display needed).
3. `npm run build` (`output: "standalone"`).
4. `node scripts/build-server.mjs` — copy static assets, refuse leaked data/keys, remove only standalone-root `dist/` and `node_modules/electron/` (old installers and the development runtime), check prompt assets. Runtime dependencies' own `dist/` directories and native renderer binaries stay intact.
5. `node scripts/smoke-server.mjs --electron` — boot the standalone server in Electron's bundled Node, using empty temporary data/auth, then check the home route and GET-only APIs.
6. `npx electron-builder <platform flags> --publish <policy>`.

The shell/updater live in `app.asar`; the standalone server and native renderer binaries ship unpacked as `extraResources`. **Do not cross-build the server payload.** Next traces the build machine's native binaries, so a macOS-built standalone tree is not a Windows/Linux payload.

After packaging, each release job checks what it built:

- macOS: `codesign --verify --deep --strict` must pass, and the job prints the signing identity. An ad-hoc build must carry `"cairnUpdates": "manual"` in the `package.json` inside `app.asar`.
- `scripts/smoke-provider-runtime.mjs` initializes the packaged model providers offline, in the host Node and in the packaged app's own Node.
- `scripts/smoke-demo-runtime.mjs` runs the interactive-demo runtime in the packaged Electron, without a system browser.
- `scripts/smoke-window.mjs` launches the packaged app, waits for its window to render the home page, and saves a dark and a light screenshot. They're uploaded as the `window-<platform>` artifact. Linux runs it under `xvfb-run`.
- `actions/attest` records a signed build-provenance attestation for each installer (see [Verifying a download](#verifying-a-download)).

`npm run desktop:dist` remains the local macOS signing path: with a Developer ID Application certificate in the login keychain and your own `APPLE_KEYCHAIN_PROFILE` and `APPLE_TEAM_ID` exported, it signs and notarizes; without them electron-builder warns and produces an unsigned, un-notarized build. For a local Windows/Linux build, run steps 1–5 above, then:

```sh
# On Windows:
npx electron-builder --win --x64 --publish never

# On Linux:
npx electron-builder --linux --x64 --publish never
```

## CI

`.github/workflows/ci.yml` runs on main pushes and pull requests:

- Typecheck, full deterministic test suite, and lint on Ubuntu.
- Native renderer tests plus standalone build/boot-smoke on macOS (`macos-15`), Windows, and Linux. This macOS job does not compile the Icon Composer asset; only release packaging needs the newer runner.
- **Docs links:** [lychee](https://github.com/lycheeverse/lychee), offline, checks every relative link and heading anchor in the Markdown files. Web links aren't checked, so the job never fails because another site is down.
- **Workflow lint:** [actionlint](https://github.com/rhysd/actionlint), with shellcheck, checks every workflow.

Alongside it:

- `codeql.yml` runs CodeQL on the JavaScript/TypeScript code and on the workflows themselves, for pushes, pull requests and once a week. Findings appear under Security → Code scanning.
- `dependency-review.yml` fails a pull request that adds a dependency with a known vulnerability of moderate severity or higher.
- `.github/dependabot.yml` opens weekly update pull requests for GitHub Actions and npm packages. It skips the packages `package.json` pins exactly on purpose; the file says why.

## Releases

`.github/workflows/release.yml` has two deliberately separate modes:

- **Rehearsal (Actions → Desktop release → Run workflow):** builds all three installers as workflow artifacts kept for 7 days, with the window screenshots. Windows and Linux are unsigned; macOS is ad-hoc signed, never notarized, with in-app updates off. No secrets are needed, no release is created and nothing is published. Run one on `main` before every tag.
- **Push `v<package.json version>`:**
  1. **Release gates.** The tag must equal `v` plus the `package.json` version, and `CHANGELOG.md` must have a non-empty `## [<version>]` section; `npx tsx scripts/release-notes.ts <version>` prints it. Typecheck, tests and lint must pass.
  2. **One draft.** A single job creates or reuses the tag's **draft GitHub Release**, titled "Cairn &lt;version&gt;". Its body is that changelog section plus first-launch and verification notes. A reused draft keeps its title and body. A published or ambiguous existing release fails this step instead of being modified, and preparing the draft once avoids competing draft creation by the OS jobs.
  3. **Package.** The three OS jobs package, check and upload their installers and update metadata into that draft in parallel. macOS is signed as `MAC_SIGNING` says (see [macOS signing](#macos-signing)).
  4. **Verify draft release.** A final read-only job (below) fails the run unless the draft is complete and self-consistent.

  Separate runs for the same ref are serialized, never cancelled mid-upload. The workflow never publishes the draft; a person does.

The three jobs upload distinct updater feeds: `latest-mac.yml`, `latest.yml`, `latest-linux.yml`, with the matching ZIP/NSIS/AppImage/deb assets and blockmaps. **A partially populated draft is never fit to publish — and the final job enforces it mechanically.** The app reads the baked GitHub feed without a token, so the repository must stay public for installed apps to find updates.

### The verification job

`verify` runs only on tag pushes (`needs: package`, so after **all three** packaging legs; manual rehearsals upload nothing and skip it). It checks out the tagged revision without persisting credentials and runs `scripts/verify-release.ts`. GitHub requires push access to list **draft** releases, so this job needs `contents: write` even though every API operation is GET-only. The token is exposed only to the release-list and feed-download steps, not dependency installation or the offline validator. The validator:

- finds the draft using the same tag matching as the draft job and electron-builder's publisher — `tag_name` equals `v<version>` **or** the bare `<version>`; zero matches, two matches, or an already-published match fail the run, and a draft matched only via the unprefixed form is flagged with a warning (a later run could create a second draft under the `v`-tag and split the assets — rename before publishing);
- fails unless the release holds **exactly** these 11 assets — nothing missing, nothing extra (a stale name from an older run is an error), nothing zero-size, nothing still in a non-`uploaded` state:

| Asset | Role |
|---|---|
| `Cairn-<v>-arm64.dmg` + `.blockmap` | macOS installer |
| `Cairn-<v>-arm64-mac.zip` + `.blockmap` | macOS updater payload (Squirrel.Mac installs from the ZIP) |
| `Cairn-<v>-x64-setup.exe` + `.blockmap` | Windows NSIS installer |
| `Cairn-<v>-x86_64.AppImage` | Linux AppImage (no sidecar blockmap) |
| `Cairn-<v>-amd64.deb` | Linux deb (no sidecar blockmap) |
| `latest-mac.yml` / `latest.yml` / `latest-linux.yml` | updater feeds |

  (The Linux names are deliberate: the user-set `linux.artifactName` applies to both Linux targets, and `${arch}` expands per target — `x86_64` inside the AppImage, `amd64` in the deb — exactly what the installed app-builder-lib 26.15.3 emits. The script's expectations fail closed if `electron-builder.yml` drifts from these shapes.);
- downloads the three feeds from the draft and fails unless each parses, carries the `package.json` version, and references **exactly** the uploaded assets — by bare file name only (no paths, traversal, or URLs), with sizes matching the API-reported asset sizes, the ZIP first in `latest-mac.yml`, and the legacy top-level `path`/`sha512` backed by that first entry.

The job only reads (release list + asset downloads); it never creates, edits, publishes, or deletes anything.

## macOS signing

The repository variable `MAC_SIGNING` (**Settings → Secrets and variables → Actions → Variables**) chooses how a tag's macOS build is signed:

| `MAC_SIGNING` | Signature | First launch | Updates |
|---|---|---|---|
| `notarized` (the default when unset) | Developer ID, hardened runtime, notarized by Apple | Opens normally | In the app, through Squirrel.Mac |
| `adhoc` | Ad-hoc, no hardened runtime, not notarized | macOS blocks it until the user chooses **Open Anyway** in System Settings → Privacy & Security | Manual downloads |

Squirrel.Mac installs an update only if its signature satisfies the running app's designated requirement. For an ad-hoc signature that requirement is the hash of that one build, so no other build can satisfy it. Ad-hoc builds are therefore stamped `"cairnUpdates": "manual"`: `electron/main.cjs` then never starts the updater, and Settings shows the version with a link to the release notes. The release still carries the ZIP and `latest-mac.yml`, so the asset list doesn't depend on the signing mode.

Cairn currently ships ad-hoc (`MAC_SIGNING=adhoc`) because it has no Apple Developer ID yet. To switch to notarized builds, add the five secrets below and delete the variable or set it to `notarized`. Without the secrets, a `notarized` tag build fails loudly rather than shipping an unsigned app.

For notarized builds, add these under repository **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application `.p12` backup, including its private key |
| `MAC_CSC_KEY_PASSWORD` | Password protecting that `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Your Apple Developer team ID |

The workflow maps the certificate secrets to electron-builder's `CSC_LINK` / `CSC_KEY_PASSWORD`. GitHub's built-in `GITHUB_TOKEN` supplies `GH_TOKEN` with job-scoped `contents: write`; no separate GitHub token secret is required. Signing credentials are present only for the packaging step, not the Next build. Never commit certificates, passwords, or `.env.local`.

## Verifying a download

Each installer the release workflow publishes (DMG, ZIP, setup EXE, AppImage, deb) has a build-provenance attestation. With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify Cairn-<version>-x64-setup.exe -R Bakar404/cairn
```

A pass proves the file was built by this repository's release workflow from the tagged commit and hasn't changed since. It isn't a code signature: Windows and macOS still show their warnings for unsigned and ad-hoc signed apps.

## Release runbook

1. Make sure `main` is green in CI.
2. In `CHANGELOG.md`, turn `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD`, start a new empty `## [Unreleased]` above it, and update the comparison links at the bottom. Check the notes with `npx tsx scripts/release-notes.ts x.y.z`.
3. Bump the version with `npm version x.y.z --no-git-tag-version`, which updates `package.json` and `package-lock.json`. Commit, push to `main` and wait for CI.
4. Run the rehearsal on `main`. Look at the `window-*` screenshots, and install the `cairn-*` artifacts on the machines you have: open the app, sign in, start and resume a lesson, open an interactive demo, switch between light and dark, and try the window buttons, dragging and zoom.
5. Tag and push: `git tag vx.y.z` then `git push origin vx.y.z`.
6. Wait for **all three** packaging jobs **and Verify draft release**. The gate checks the draft's 11 assets and the three update feeds: a single draft, the right names, version, sizes and upload state, and feeds that reference only what the release holds. If anything fails, fix the cause and re-run the failed jobs before publishing; electron-builder replaces same-named assets on re-upload, and the gate rejects leftovers.
7. Read the draft on the Releases page, then publish it with `gh release edit vx.y.z --draft=false --latest`.
8. Download an installer from the published release and check it with `gh attestation verify`. With a notarized macOS build or on Windows or Linux, also check that an installed older version finds the update.

Changes to `electron/`, native modules, packaging/updater configuration, or Electron itself call for a hands-on pass on each OS (step 4) before tagging. Other changes rely on the deterministic suite, the per-OS build and boot smoke in CI, and the release jobs' packaged-app checks.
