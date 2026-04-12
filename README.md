# copilot-toolkit

Personal collection of [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) extensions, skills, and agents.

## Extensions

| Extension | Tools provided | Description |
|-----------|---------------|-------------|
| **ado-pr-watcher** | `pr_watcher_start`, `pr_watcher_list`, `pr_watcher_stop` | Watches Azure DevOps pull requests for reviewer activity, comment threads, negative votes, and blocking policy failures. Injects follow-up prompts so the Copilot agent can act as the PR author. |
| **ado-build-watcher** | `build_watcher_start`, `build_watcher_list`, `build_watcher_stop` | Watches Azure DevOps build/pipeline runs and notifies the session when they complete or fail, enabling automatic diagnosis and next-step continuation. |

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

### How watchers work

1. **Start** — Copilot calls `pr_watcher_start` or `build_watcher_start`, which spawns a detached worker process
2. **Poll** — The worker polls Azure DevOps APIs via `az` CLI at a configurable interval (default 60s for builds, 30s for PRs)
3. **Notify** — When the worker detects a change (new review comment, build completed, etc.), it writes an event file
4. **React** — The extension picks up the event and injects a follow-up prompt into your session so Copilot can act on it

## Install extensions

Extensions are **not** distributed through the plugin system — they require the install script.

| What | How installed | What this repo provides |
|------|--------------|------------------------|
| **Extensions** | Install scripts below | `ado-pr-watcher`, `ado-build-watcher` |
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
