# Cairn

**An AI tutor that runs on your GitHub Copilot subscription, with optional Azure-powered voice.**

Cairn finds out what you already understand, plans a path to your goal and teaches one reasoning step at a time. Like stones in a cairn, each new idea rests on one you already have, and a persistent knowledge graph carries the path from one session to the next.

> [!IMPORTANT]
> **Early stage.** Every model call and web search already runs on your GitHub Copilot subscription. Azure voice and the one-command install are still planned, so for now you run Cairn from source, and dictation uses your own Deepgram key if you add one.

## Built on LearnHarness

Cairn is a fork of **[LearnHarness](https://github.com/amosblomqvist/learnharness)** by **[Amos Blomqvist](https://github.com/amosblomqvist)**, licensed under [AGPL-3.0](LICENSE). The teaching method and nearly all of the app are his work:

- the Measure → Plan → Teach → Practice loop
- the persistent knowledge graph and its extraction pipeline
- the background researcher, visual explanations and interactive demos
- the desktop shell

Cairn keeps the full upstream git history.

Cairn adapts LearnHarness for people and companies that already use GitHub Copilot and, optionally, Azure. If you'd rather use your own model API keys from 30+ providers, use LearnHarness itself at [learnharness.ai](https://learnharness.ai). Its original README is in the [upstream repository](https://github.com/amosblomqvist/learnharness#readme).

> Cairn is an independent project. It is not affiliated with or endorsed by the LearnHarness author, GitHub or Microsoft.

## How it works

The learning loop comes from LearnHarness and is unchanged:

1. **Measure.** Before teaching, Cairn finds where your understanding ends on each part your goal depends on.
2. **Plan.** It maps the dependencies from that starting point to your goal, and adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand: you predict, get an explanation and check your understanding. Confusions are fixed before anything is built on them.
4. **Practice.** Separate sessions pose varied problems that need the right knowledge to come to mind without a prompt.

What you learn builds up as propositions and reasoning chains in a knowledge graph, which later sessions build on.

## What Cairn changes

| | LearnHarness | Cairn |
| --- | --- | --- |
| **Models** | Your own API keys (30+ providers) or a subscription sign-in | **Available now:** your **GitHub Copilot** plan, through the official [GitHub Copilot SDK](https://github.com/github/copilot-sdk). It is the only model connection, and there are no model keys. |
| **Talk** | Dictation through Deepgram | *Planned:* dictation through **Azure Speech**, then a hands-free **voice mode** (speech-to-text → Copilot teacher → neural voice). Until then, Deepgram dictation works with your own key. |
| **Web research** | Tavily or Brave | **Available now:** **Copilot's built-in web search**, with no key. A Tavily or Brave key is optional: it takes over when a Copilot search fails, or you can choose it in **Settings → Agent**. |
| **Animations** | SVG figures and interactive demos | **Available now, optional:** short animated explanations written with [Manim](https://www.manim.community/) and rendered on your computer in Docker, plus Manim figures for typeset math. Turn it on in **Settings → Providers → Animations**. |
| **Work context** | Not used | **Available now, optional, off by default:** before the first question, Cairn can ask [Work IQ](https://github.com/microsoft/work-iq) which parts of the subject your Microsoft 365 work (email, meetings, chats, documents) already touches, so the questions start in the right place. The topics are only a starting guess and never count as things you know. Set it up in **Settings → Providers → Work IQ**, then switch it on in **Settings → Agent**. |
| **Azure** | Not used | *Planned, optional:* `azd up` deploys into **your own** subscription, and Cairn signs in with your `az login` (Microsoft Entra ID), so no Azure keys are stored. |
| **Install** | Desktop downloads | *Now:* run from source. *Planned:* a local web app started with one `npx` command, then a desktop app. |
| **Later** | | Opt-in suggestions for what to learn from Microsoft 365 work context (Work IQ), search over company docs (Azure AI Search), a shared team gateway |

## Requirements

- A GitHub account with **GitHub Copilot**. Copilot Free works, with limited usage. On Copilot Business or Enterprise, your admin may need to allow Copilot CLI/SDK use.
- **Node.js 22.12 or newer** (or 20.19+)
- No separate sign-in tool: Cairn has its own **Sign in with GitHub**. A [GitHub CLI](https://cli.github.com) sign-in (`gh auth login`) or a token in `COPILOT_GITHUB_TOKEN` works too.
- *Optional, for animations:* [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine on Linux), running Linux containers. Cairn downloads the Manim renderer, about 500 MB, only when you choose **Install renderer** in **Settings → Providers → Animations**.
- *Optional, for Work IQ:* a work account with a **Microsoft 365 Copilot** license. You accept the Work IQ license and sign in once, in a terminal (**Settings → Providers → Work IQ** lists the commands), and your Microsoft 365 admin may need to approve Work IQ for your organization once.
- *Optional, later for voice:* an Azure subscription, the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) and the [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd)

Without Azure, Cairn still teaches by text.

## Try it

```bash
git clone https://github.com/Bakar404/cairn.git
cd cairn
npm install
npm run dev                          # then open http://localhost:3000
```

1. If Copilot isn't connected, the message box shows **Connect GitHub Copilot**. Choose **Sign in with GitHub** and approve the sign-in in your browser. GitHub's pages mention the GitHub Copilot CLI, whose sign-in Cairn uses; when one says to return to your terminal, come back to Cairn, which finishes on its own. Already signed in with `gh auth login`? Choose **Check again** instead.
2. Choose **Set up your models**, or just send your first message. Cairn suggests a strong, a cheap and a vision model from your Copilot plan. Review them and save.
3. Type what you want to learn. Cairn first asks a few questions to find what you already know, then starts teaching.

You can change models later in **Settings → Agent**, and manage your Copilot sign-in in **Settings → Providers**.

### Accounts

- **Personal and Enterprise Managed (EMU) accounts on github.com:** choose **Sign in with GitHub**. EMU accounts go through your company's usual single sign-on. If your browser is signed in to GitHub as someone else, switch accounts on GitHub's page (or use a private window) before you approve.
- **GitHub Enterprise Cloud on a `ghe.com` address:** choose **GitHub Enterprise Cloud (ghe.com)** and enter the address, like `your-company.ghe.com`.
- **More than one account:** add another in **Settings → Providers**, then choose **Use** next to the one Cairn should run on. Every model call and search uses that account's Copilot plan.
- The sign-in is the GitHub Copilot runtime's own: it keeps the credential in your system keychain, where the GitHub Copilot CLI keeps its sign-in too, so the two share it. Cairn stores no token and never passes one to the browser. **Sign out** shows only for sign-ins made this way, and may sign the Copilot CLI out as well. A `gh` sign-in is removed with `gh auth logout`.

Notes:

- For a faster, production run, use `npm run build`, then `npm start`, instead of `npm run dev`. Next prints a warning about `output: standalone`, which is the desktop build's setting; the web app works anyway.
- Cairn listens only on this computer (`127.0.0.1`), so other machines on your network, such as an office network, can't reach it or use your Copilot through it.
- Cairn ignores `GITHUB_TOKEN` and `GH_TOKEN`, which are often CI or fine-grained tokens without Copilot access. To use a token instead of a sign-in, set `COPILOT_GITHUB_TOKEN` before starting Cairn.
- To rehearse the first-run experience, run `npm run dev:fresh`. It starts a throwaway instance with no data at http://localhost:3005, while your real data stays untouched.
- Usage counts against your Copilot plan, under your organization's Copilot policies.
- Research uses Copilot's web search, which takes 20–40 seconds per search, so background research takes a few minutes. Searches use your Copilot plan too.

## Your data

- Chats, the knowledge graph and settings stay on your machine as plain files you can inspect.
- Model requests go to GitHub Copilot under your account and your organization's Copilot policies.
- Your GitHub sign-in stays in your system keychain, kept by the GitHub Copilot runtime. Cairn stores no GitHub credentials.
- Research queries go to GitHub Copilot's web search, which GitHub runs on Bing. They go to Tavily or Brave, and dictation audio to Deepgram, only if you add that key. With the planned Azure voice, speech goes to your own Azure Speech resource.
- Animations render on your computer, in a Docker container with no network access and no access to your files. The renderer image comes from Docker Hub, once, when you install it.
- Work IQ is off unless you switch it on. When it's on, the subject of a session goes to Microsoft 365 Copilot under your own sign-in, once per session, and Cairn saves only the short list of topics it returns, not its full answer. Each question may use your organization's Copilot Credits.
- Cairn runs no servers of its own and includes no analytics.

## Development

Development works as it does for LearnHarness, except that models come only from GitHub Copilot:

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # deterministic: no LLM, no network
npm run lint && npm run typecheck
```

Architecture and conventions: [docs/architecture.md](docs/architecture.md) and [docs/development.md](docs/development.md).

### Syncing with upstream

```bash
git remote add upstream https://github.com/amosblomqvist/learnharness.git   # once
git fetch upstream
git merge upstream/main   # on conflicts, README.md keeps Cairn's version
```

## License and attribution

Cairn is free software under the **GNU Affero General Public License v3.0 only** (see [LICENSE](LICENSE)), the same license as LearnHarness.

- LearnHarness © Amos Blomqvist and LearnHarness contributors.
- Cairn modifications © 2026 [@Bakar404](https://github.com/Bakar404).
- **Modification notice (AGPL-3.0 §5(a)):** Cairn is a modified version of LearnHarness 0.3.8 (upstream commit `3dc8847`). Modifications began on 2026-10-26, and the git history records each change.
- If you run a modified Cairn as a network service for other people, AGPL-3.0 §13 requires you to offer them its source code.

GitHub, GitHub Copilot, Microsoft, Azure and Work IQ are trademarks of their respective owners.
