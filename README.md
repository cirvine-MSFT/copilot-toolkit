# copilot-toolkit

Personal collection of [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) extensions, skills, and agents.

## Extensions

| Extension | Tools provided | Description |
|-----------|---------------|-------------|
| **ado-pr-watcher** | `pr_watcher_start`, `pr_watcher_list`, `pr_watcher_stop` | Watches Azure DevOps pull requests for reviewer activity, comment threads, negative votes, and blocking policy failures. Injects follow-up prompts so the Copilot agent can act as the PR author. |
| **ado-build-watcher** | `build_watcher_start`, `build_watcher_list`, `build_watcher_stop` | Watches Azure DevOps build/pipeline runs and notifies the session when they complete or fail, enabling automatic diagnosis and next-step continuation. |
| **visual-review** | `visual_review_start`, `visual_review_stop`, `visual_review_status`, `visual_review_send_visualization` | Launches a native webview diff reviewer with GitHub-style inline commenting. Comments flow back to the Copilot CLI session in real time, enabling interactive code review without leaving the terminal. |

### Quick start

After [installing](#install-extensions), the tools are available in any Copilot CLI session:

```
# Watch a PR — auto-detects org/project/repo from your git remote
Watch my PR for reviews

# Watch a PR by URL
Watch this PR: https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/12345

# Watch a build/pipeline run
Watch this build: https://dev.azure.com/myorg/myproject/_build/results?buildId=98765

# List active watchers
Show my active watchers

# Stop a watcher
Stop the PR watcher
```

You don't call the tools directly — just describe what you want in natural language and Copilot invokes the right tool. The watchers run as detached background processes and inject events back into your session when something happens.

### Visual Review

The visual-review extension opens a native webview diff viewer connected to your Copilot CLI session. It shows your changes with GitHub-style inline commenting — you leave comments in the window, Copilot responds, and replies appear inline.

#### How to use

Just describe what you want in natural language:

```
# Review changes on current branch vs main
Review my changes visually

# Review staged changes
Show me a visual review of my staged changes

# Review changes against a specific branch
Open visual review comparing against develop
```

Or use explicit tool parameters:

```
# Start with specific options
Start visual review with scope=branch base=main theme=dark

# Check status
What's the visual review status?

# Send a diagram to the viz panel
Send this architecture diagram to the visual review
```

#### What you see

The native review window has two panels:

1. **Files Changed** — A GitHub-style diff view with:
   - Side-by-side or unified diff layout
   - Syntax highlighting
   - File tree sidebar for navigation
   - **Inline commenting** — hover over any line to add a comment
   - Comments flow back to your CLI session, and Copilot's replies appear inline

2. **Visualizations** — A panel for Mermaid diagrams showing:
   - Architecture impact diagrams
   - Sequence diagrams
   - Data flow visualizations
   - Any Mermaid diagram sent via the `visual_review_send_visualization` tool

#### Comment workflow

1. In the review window, hover over a line number → click the blue "+" button
2. Type your comment and click "Comment"
3. The comment appears in your Copilot CLI session as a follow-up prompt
4. Copilot reads the comment, understands the context, and responds
5. The response appears inline in the review window as a threaded reply
6. Continue the conversation — each reply goes back and forth in real time

#### Requirements

- A desktop environment with native webview support
- Git repository with changes to review
- No Azure CLI or Azure DevOps access required

### How watchers work

1. **Start** — Copilot calls `pr_watcher_start` or `build_watcher_start`, which spawns a detached worker process
2. **Poll** — The worker polls Azure DevOps APIs via `az` CLI at a configurable interval (default 60s for builds, 30s for PRs)
3. **Notify** — When the worker detects a change (new review comment, build completed, etc.), it writes an event file
4. **React** — The extension picks up the event and injects a follow-up prompt into your session so Copilot can act on it

## Install extensions

Extensions are **not** distributed through the plugin system — they require the install script.

| What | How installed | What this repo provides |
|------|--------------|------------------------|
| **Extensions** | Install scripts below | `ado-pr-watcher`, `ado-build-watcher`, `visual-review` |
| **Skills & agents** | `copilot plugin install` | None yet (placeholders) |

**PowerShell (Windows):**

```powershell
git clone https://github.com/cirvine-msft/copilot-toolkit.git
cd copilot-toolkit
.\install-extensions.ps1
```

**Bash (macOS / Linux):**

```bash
git clone https://github.com/cirvine-msft/copilot-toolkit.git
cd copilot-toolkit
./install-extensions.sh
```

To install only specific extensions:

```bash
./install-extensions.sh ado-build-watcher          # just the build watcher
.\install-extensions.ps1 ado-pr-watcher             # just the PR watcher
```

After installing, run `/clear` in the Copilot CLI or restart it to load the new extensions.

### Update

```bash
cd copilot-toolkit
git pull
./install-extensions.sh   # or .\install-extensions.ps1
```

The install scripts use mirror semantics — stale files from previous versions are cleaned up automatically.

### Uninstall

Remove the installed extension directories:

```bash
rm -rf ~/.copilot/extensions/ado-pr-watcher
rm -rf ~/.copilot/extensions/ado-build-watcher
rm -rf ~/.copilot/extensions/visual-review
rm -rf ~/.copilot/extensions/lib
```

Then run `/clear` or restart the CLI.

## Plugin system

This repo contains a `plugin.json` manifest for future skills and agents. When skills/agents are published, they'll be installable via:

**From the terminal:**
```bash
copilot plugin install cirvine-msft/copilot-toolkit
```

**From within the CLI:**
```
/plugin install cirvine-msft/copilot-toolkit
```

> **Note:** The plugin system installs skills and agents only — it does **not** install the watcher extensions. Those always require the install scripts above.

## Requirements

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) with the Azure DevOps extension
- Azure DevOps access for the repos/pipelines you want to watch

> **Note:** The visual-review extension only requires Git and native webview support on your machine. It does not need Azure CLI or Azure DevOps access.

### Azure CLI setup

```bash
# Install Azure DevOps extension (if not already present)
az extension add --name azure-devops

# Login
az login

# Optionally set defaults so you don't have to pass org/project every time
az devops configure --defaults organization=https://dev.azure.com/YOUR_ORG project=YOUR_PROJECT
```

The extensions auto-detect org/project/repo from your git remote when possible. Explicit values are only needed when auto-detection can't resolve them (e.g., non-ADO git remotes, numeric build IDs without context).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Tools don't appear after install | Run `/clear` or restart the CLI |
| `az` commands fail with auth errors | Run `az login` to refresh credentials |
| Watcher not detecting changes | Check `pr_watcher_list` / `build_watcher_list` for status; verify Azure DevOps access |
| Extension not loading | Verify files exist in `~/.copilot/extensions/ado-pr-watcher/` |

## License

[MIT](LICENSE)
