# Contributing

Thanks for your interest in contributing to copilot-toolkit!

## Development setup

1. Clone the repo:
   ```bash
   git clone https://github.com/cirvine-msft/copilot-toolkit.git
   cd copilot-toolkit
   ```

2. Install extensions locally for testing:
   ```bash
   ./install-extensions.sh   # or .\install-extensions.ps1
   ```

3. Run `/clear` in the Copilot CLI to pick up changes.

### Live development loop

For iterating on extension code:

1. Edit files in `extensions/`
2. Re-run the install script to copy changes to `~/.copilot/extensions/`
3. Run `/clear` in the CLI to reload

Alternatively, use `copilot --plugin-dir .` to load the repo directly as a plugin source during development (useful for skills/agents, not extensions).

## Code conventions

- Extension code is ES modules (`.mjs`) — no build step, no bundled dependencies
- Extensions use `@github/copilot-sdk` which is auto-provided by the CLI runtime — do **not** add it as a dependency
- Shared utilities go in `extensions/lib/`
- Use `process.execPath` (not `node` or `node.exe`) when spawning worker processes

## Validation

Before submitting a PR, verify:

```bash
# Syntax check all extension files
find extensions -name '*.mjs' -exec node --check {} \;

# Run install script and verify it works
./install-extensions.sh
```

CI runs automatically on PRs and checks:
- `.mjs` syntax validity
- `plugin.json` structure
- Install script smoke tests (bash on Ubuntu, pwsh on Ubuntu, PowerShell on Windows)
- Installer idempotence (stale files are removed on reinstall)

## Content review checklist

Since this is a public repo, scan any new code for:
- [ ] No hardcoded secrets, tokens, or credentials
- [ ] No internal/corp URLs or org-specific references
- [ ] No personal file paths
- [ ] Generic Azure DevOps API patterns are fine (dev.azure.com, .visualstudio.com URL parsing)

## Pull requests

- Create a feature branch off `main`
- Keep changes focused — one extension or feature per PR
- Update README if user-facing behavior changes
- Update install scripts if extension structure changes
- CI must pass before merge

## Tested platforms

| Platform | Install script | Status |
|----------|---------------|--------|
| Ubuntu (bash) | `install-extensions.sh` | CI tested |
| Ubuntu (pwsh 7+) | `install-extensions.ps1` | CI tested |
| Windows (PowerShell 5.1+) | `install-extensions.ps1` | CI tested |
| macOS (bash) | `install-extensions.sh` | Manual testing |
