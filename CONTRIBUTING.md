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

## Filing issues

Use the GitHub issue templates for bug reports, feature requests, and support questions. Include enough detail to reproduce the problem, but keep examples generic and redact secrets, tokens, private URLs, organization names, and personal paths.

For security vulnerabilities, do not open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/cirvine-msft/copilot-toolkit/security/advisories/new).

## Code conventions

- Extension code is ES modules (`.mjs`) — no build step, no bundled dependencies
- Extensions use `@github/copilot-sdk` which is auto-provided by the CLI runtime — do **not** add it as a dependency
- Shared utilities go in `extensions/lib/`
- Use `resolveNodeBinary()` from `extensions/lib/resolve-node.mjs` when spawning worker processes; `process.execPath` points at the Copilot CLI executable, not Node.
- Canvas extensions may include a nested webview package when the browser UI requires dependencies. Keep those dependencies out of the extension host and commit generated runtime webview assets when installers need to remain copy-only.

### Excalidraw Workbench development

The Excalidraw Workbench extension has host-side ESM modules plus a nested React/Vite webview.

```bash
# Host helper tests
node --test extensions/excalidraw-workbench/*.test.mjs

# Webview tests and build
cd extensions/excalidraw-workbench/webview
npm ci
npm run test
npm run build
npm run secret-scan
npm audit --audit-level=moderate
```

Use Node.js 20.19+ for webview work.

Commit `extensions/excalidraw-workbench/webview/runtime/` after rebuilding. The install scripts copy prebuilt assets and do not run npm. Keep the committed bundle under `runtime/` instead of `dist/` or `build/` so generic source-folder installers do not treat it as disposable build output.

## Validation

Before submitting a PR, verify:

```bash
# Syntax check all extension files
find extensions -path '*/node_modules/*' -prune -o -name '*.mjs' -type f -exec node --check {} \;

# Run host tests
node --test extensions/excalidraw-workbench/*.test.mjs

# Run webview tests/build/audit when touching Excalidraw Workbench
cd extensions/excalidraw-workbench/webview && npm ci && npm run check && npm audit --audit-level=moderate

# Run install script and verify it works
./install-extensions.sh
```

CI runs automatically on PRs and checks:
- `.mjs` syntax validity
- Excalidraw Workbench host tests, webview tests, license checks, build, audit, and stale-runtime detection
- `plugin.json` structure
- Install script smoke tests (bash on Ubuntu, pwsh on Ubuntu, PowerShell on Windows)
- Installer idempotence (stale files are removed on reinstall)
- Dependency review for vulnerable dependency changes
- CodeQL JavaScript security analysis

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
