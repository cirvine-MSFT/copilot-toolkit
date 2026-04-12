# copilot-toolkit

Personal collection of [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) extensions, skills, and agents.

## Extensions

| Extension | Description |
|-----------|-------------|
| **ado-pr-watcher** | Watches Azure DevOps pull requests for reviewer activity, comment threads, negative votes, and blocking policy failures. Injects follow-up prompts so the Copilot agent can act as the PR author. |
| **ado-build-watcher** | Watches Azure DevOps build/pipeline runs and notifies the session when they complete or fail, enabling automatic diagnosis and next-step continuation. |

## Install extensions

Extensions are **not** distributed through the plugin system — they require the install script below.

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
chmod +x install-extensions.sh && ./install-extensions.sh
```

After installing, run `/clear` in the Copilot CLI or restart it to load the new extensions.

## Skills & agents

Skills and agents will be installable via:

```
/plugin install cirvine-msft/copilot-toolkit
```

None are published yet — the `skills/` and `agents/` directories are placeholders.

## Requirements

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) (for ADO API calls)
- Azure DevOps access for the repos/pipelines you want to watch

## License

[MIT](LICENSE)
