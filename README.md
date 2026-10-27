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
| **Azure** | Not used | *Planned, optional:* `azd up` deploys into **your own** subscription, and Cairn signs in with your `az login` (Microsoft Entra ID), so no Azure keys are stored. |
| **Install** | Desktop downloads | *Now:* run from source. *Planned:* a local web app started with one `npx` command, then a desktop app. |
| **Later** | | Opt-in suggestions for what to learn from Microsoft 365 work context (Work IQ), search over company docs (Azure AI Search), a shared team gateway |

## Requirements

- A GitHub account with **GitHub Copilot**. Copilot Free works, with limited usage. On Copilot Business or Enterprise, your admin may need to allow Copilot CLI/SDK use.
- **Node.js 22.12 or newer** (or 20.19+)
- The **[GitHub CLI](https://cli.github.com)**, signed in with that account (`gh auth login`), or a token in `COPILOT_GITHUB_TOKEN`
- *Optional, later for voice:* an Azure subscription, the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) and the [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd)

Without Azure, Cairn still teaches by text.

## Try it

```bash
gh auth login                        # once, with your Copilot account
git clone https://github.com/Bakar404/cairn.git
cd cairn
npm install
npm run dev                          # then open http://localhost:3000
```

1. If Copilot isn't connected, the message box shows **Connect GitHub Copilot**. Run `gh auth login`, then choose **Check again** in that dialog.
2. Choose **Set up your models**, or just send your first message. Cairn suggests a strong, a cheap and a vision model from your Copilot plan. Review them and save.
3. Type what you want to learn. Cairn first asks a few questions to find what you already know, then starts teaching.

You can change models later in **Settings → Agent**, and see your Copilot connection in **Settings → Providers**.

Notes:

- For a faster, production run, use `npm run build && npm start` instead of `npm run dev`. Next prints a warning about `output: standalone`, which is the desktop build's setting; the web app works anyway.
- Cairn ignores `GITHUB_TOKEN` and `GH_TOKEN`, which are often CI or fine-grained tokens without Copilot access. To use a token instead of your `gh` sign-in, set `COPILOT_GITHUB_TOKEN` before starting Cairn.
- To rehearse the first-run experience, run `npm run dev:fresh`. It starts a throwaway instance with no data at http://localhost:3005, while your real data stays untouched.
- Usage counts against your Copilot plan, under your organization's Copilot policies.
- Research uses Copilot's web search, which takes 20–40 seconds per search, so background research takes a few minutes. Searches use your Copilot plan too.

## Your data

- Chats, the knowledge graph and settings stay on your machine as plain files you can inspect.
- Model requests go to GitHub Copilot under your account and your organization's Copilot policies.
- Research queries go to GitHub Copilot's web search, which GitHub runs on Bing. They go to Tavily or Brave, and dictation audio to Deepgram, only if you add that key. With the planned Azure voice, speech goes to your own Azure Speech resource.
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
