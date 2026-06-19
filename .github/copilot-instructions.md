# Copilot Instructions — copilot-toolkit

## What this repo is

A public collection of GitHub Copilot CLI extensions (and eventually skills/agents) by cirvine-msft. Extensions are ES module files (`.mjs`) that run inside the Copilot CLI runtime.

## Repo structure

```
extensions/
  ado-pr-watcher/     # Azure DevOps PR monitoring extension
  ado-build-watcher/  # Azure DevOps build/pipeline monitoring extension
  excalidraw-workbench/ # Excalidraw canvas extension with a prebuilt webview runtime
  lib/                # Shared library (tab-indicator) used by both watchers
skills/               # Future Copilot skills (empty placeholder)
agents/               # Future Copilot agents (empty placeholder)
install-extensions.ps1  # PowerShell installer (PS 5.1+ and pwsh 7+)
install-extensions.sh   # Bash installer (macOS/Linux)
plugin.json           # Plugin manifest for skills/agents distribution
```

## Critical conventions

- **No bundled dependencies in extension hosts.** Extensions use `@github/copilot-sdk` which is auto-provided by the Copilot CLI runtime. Never add it to a package.json or import from node_modules. Browser-only canvas UI dependencies may live in a nested webview package, with generated runtime assets committed when install scripts need to remain copy-only.
- **ES modules only.** All extension code is `.mjs` files using `import`/`export`. No CommonJS, no TypeScript, no build step.
- **`process.execPath` is NOT a Node binary.** Copilot CLI's `process.execPath` points to `copilot.exe`, not `node`. Always use `resolveNodeBinary()` from `extensions/lib/resolve-node.mjs` when spawning worker processes. It probes `process.execPath` first, then falls back to `node` on PATH.
- **Shared code goes in `extensions/lib/`.** Both watchers import from `../lib/tab-indicator.mjs` and `../lib/resolve-node.mjs` via relative paths.
- **PowerShell 5.1 compatibility.** Install scripts must work on Windows PowerShell 5.1. This means: no ternary expressions, no 3+ argument `Join-Path`, no reliance on `$HOME` reflecting `$env:HOME`.
- **COPILOT_HOME env var.** Install scripts respect `COPILOT_HOME` (same as the CLI itself). Default target is `~/.copilot/extensions/`.
- **Mirror install semantics.** Install scripts delete-then-copy each extension directory so stale files from previous versions are removed.

## CI and security scanning

CI runs on every push to main and every PR. It tests:
- `.mjs` syntax validity (`node --check`)
- Excalidraw Workbench host tests
- Excalidraw Workbench webview tests, license check, build, audit, and stale-runtime detection
- `plugin.json` structure validation
- Install script smoke tests on 3 platforms: bash/ubuntu, pwsh/ubuntu, powershell/windows
- Installer idempotence (stale file removal)

Security automation also includes Dependabot for GitHub Actions and the Excalidraw Workbench webview npm package, Dependency Review on PRs, and CodeQL JavaScript analysis.

## Content rules (public repo)

Before committing extension code, verify:
- No hardcoded secrets, tokens, or credentials
- No internal/corp URLs or org-specific references
- No personal file paths (e.g., `C:\Users\someone\...`)
- Generic Azure DevOps API patterns (dev.azure.com, .visualstudio.com URL parsing) are fine
- The Azure CLI install path fallback (`C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin\az.cmd`) is a standard public path and fine to keep
