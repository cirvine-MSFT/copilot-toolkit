# AGENTS.md — copilot-toolkit

Guidance for AI coding agents (GitHub Copilot coding agent, Copilot CLI, Codex, Cursor, etc.) working in this repo. Humans should read this too — it's the fastest way to understand the moving parts.

## Repo shape

A public collection of GitHub Copilot CLI extensions authored by cirvine-msft.

```
extensions/
  ado-pr-watcher/         # Azure DevOps PR monitoring extension
  ado-build-watcher/      # Azure DevOps build/pipeline monitoring extension
  excalidraw-workbench/   # Canvas extension with prebuilt webview runtime
  lib/                    # Shared helpers (tab-indicator, resolve-node)
skills/                   # Future Copilot skills (placeholder)
agents/                   # Future Copilot agents (placeholder)
install-extensions.ps1    # PowerShell installer (PS 5.1+ and pwsh 7+)
install-extensions.sh     # Bash installer (macOS/Linux)
plugin.json               # Plugin manifest
```

## Non-negotiable conventions

- **No bundled dependencies in extension hosts.** Extension `.mjs` files only import Node built-ins and `@github/copilot-sdk` (provided by the CLI runtime at load time). Never add a `package.json` next to `extension.mjs` and never import from `node_modules`. Browser-only deps live in a nested webview package (see `extensions/excalidraw-workbench/webview/`).
- **ES modules only.** `.mjs` with `import`/`export`. No CommonJS, no TypeScript, no build step for the host.
- **`process.execPath` is not Node.** In Copilot CLI it's `copilot.exe`. Always use `resolveNodeBinary()` from `extensions/lib/resolve-node.mjs` when spawning workers.
- **Shared code goes in `extensions/lib/`** and is imported via relative paths.
- **PowerShell 5.1 compatibility for install scripts.** No ternary expressions, no 3+ argument `Join-Path`, no reliance on `$HOME` reflecting `$env:HOME`.
- **`COPILOT_HOME` env var** is respected by both installers. Default target is `~/.copilot/extensions/`.
- **Delete-then-copy install semantics.** Both installers wipe each extension's target directory before copying, so stale files from previous versions are removed.

## Excalidraw webview: the one build step that matters

`extensions/excalidraw-workbench/webview/` is the only place in the repo with a real build. The prebuilt output at `webview/runtime/**` is **committed to git** so end-user installs stay `npm`-free and copy-only. CI enforces this via a "Verify Excalidraw webview runtime is current" step that fails the build if `git status` shows any change under `webview/runtime/` after `npm run build`.

### **If you change anything under `extensions/excalidraw-workbench/webview/`, you MUST regenerate the runtime and commit the result.**

That includes — and this is the common case — every Dependabot PR that bumps `webview/package.json` or `webview/package-lock.json`. Dependabot only touches the lockfile; a human or agent has to rebuild the committed runtime bundle and push it onto the same PR branch.

### Regeneration recipe

Run these from the repo root:

```bash
cd extensions/excalidraw-workbench/webview
npm ci
npm run test
npm run license-check
npm run build
npm audit --audit-level=moderate
```

Every step must pass — CI runs exactly these. Then, from the repo root:

```bash
git add extensions/excalidraw-workbench/
git commit -m "deps: regenerate excalidraw webview runtime for bumped deps"
git push
```

### Common failure modes when bumping webview deps

- **New license shows up in the runtime dep tree.** Edit `webview/scripts/check-runtime-licenses.mjs` — either widen `allowedLicensePatterns` (for well-known permissive SPDX ids like MPL-2.0, CC0-1.0, Unlicense, 0BSD, Zlib) or add a narrow entry to `allowedMissingLicensePackages` for a package that ships a LICENSE file but omits the `license` field in `package.json`. Never blindly allow every license — re-audit on each bump.
- **`npm audit --audit-level=moderate` fails on transitive vulns.** Add `overrides` in `webview/package.json` to force safe versions of the vulnerable transitive package (e.g., `nanoid`, `lodash-es`). Reinstall and re-audit until clean. Only fall back to `--audit-level=high` in the CI script as a last resort, and never without discussion.
- **Vitest fails resolving a subpath import (e.g., `roughjs/bin/rough`).** Newer Excalidraw dev bundles omit `.js` extensions. Add a `resolve.alias` entry in `webview/vite.config.js` (already done for `roughjs/bin/rough`) and consider adding the offending module to `test.server.deps.inline` so Vitest transforms it.
- **`check-no-bundled-secrets.mjs` flags AWS/GitHub/etc. patterns inside a wasm/base64 chunk.** These are almost always false positives from compressed binary data. Tighten the specific pattern's word boundaries rather than adding blanket file exclusions.

### If you're an automated agent (Copilot cloud agent, coding agent, etc.)

You almost certainly have permission to push to the PR branch. Do the rebuild and push as a follow-up commit on the same branch. Include a `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>` trailer.

If the rebuild uncovers a genuine problem (real license concern, real vuln with no override path, real test failure that isn't a resolver quirk), stop and hand back to a human with a summary. Don't downgrade CI gates to make the PR pass.

## CI and security scanning

CI (`.github/workflows/ci.yml`) runs on every push to `main` and every PR:

- `.mjs` syntax check (`node --check`)
- Excalidraw Workbench host tests (`node --test`)
- Excalidraw Workbench webview: `npm ci`, tests, `license-check`, `build`, `npm audit --audit-level=moderate`
- **Stale runtime detection** — fails if `webview/runtime/` has any uncommitted diff after `npm run build`
- `plugin.json` structure validation
- Install script smoke tests on bash/ubuntu, pwsh/ubuntu, powershell/windows
- Installer idempotence (touch a stale file, reinstall, verify it's gone)

Security automation includes Dependabot (GitHub Actions + the webview npm package), Dependency Review on PRs, and CodeQL JavaScript analysis.

## Content rules (public repo)

Before committing:

- No hardcoded secrets, tokens, or credentials
- No internal/corp URLs or org-specific references
- No personal file paths (e.g., `C:\Users\someone\...`)
- Generic Azure DevOps API patterns (`dev.azure.com`, `.visualstudio.com`) are fine
- The Azure CLI Windows install-path fallback (`C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin\az.cmd`) is a standard public path and fine to keep

## Adding a new extension

1. Create `extensions/my-extension/extension.mjs` and export tools using `@github/copilot-sdk` patterns (see existing extensions).
2. Add the extension name to both install scripts' `$allExtensions` / `all_extensions` arrays.
3. Add the extension's expected files to the CI smoke-test file-existence lists in `.github/workflows/ci.yml` (all three install jobs).
4. Update `README.md` and the extension's own `README.md`.
5. Content review (no secrets, no internal URLs).
