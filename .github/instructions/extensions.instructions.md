---
applyTo: "extensions/**"
---

# Extension development instructions

## Architecture

Each extension is a directory under `extensions/` containing:
- `extension.mjs` — entrypoint that exports tools via `@github/copilot-sdk`
- `common.mjs` — shared helpers (Azure CLI invocation, URL parsing, file I/O)
- Worker files (e.g., `worker.mjs`, `watcher-worker.mjs`) — detached background processes
- Canvas webview assets when needed (e.g., `webview/runtime/` for `excalidraw-workbench`)

Extensions register tools that the Copilot agent can invoke. Each tool has a `name`, `description`, `parameters` (JSON Schema), and `handler` function.

Canvas extensions register canvases using `createCanvas` from `@github/copilot-sdk/extension`. Keep the extension host dependency-light; browser-only dependencies belong in a nested webview package and must be prebuilt into committed assets if installers need to copy them.

## Key patterns

### Worker process spawning
**Never use `process.execPath` directly** — it points to `copilot.exe`, not Node. Use `resolveNodeBinary()` from the shared lib:
```js
import { resolveNodeBinary } from "../lib/resolve-node.mjs";

const nodeBinary = await resolveNodeBinary();
spawn(nodeBinary, [workerPath, ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
});
```

### Azure CLI invocation
Both extensions shell out to `az` CLI for Azure DevOps API calls. The common pattern:
- Try `az` on PATH first
- Fall back to the default Windows install path
- Parse JSON output from `az` commands
- Handle auth expiry gracefully (warn user to `az login`)

### File-based IPC
Watchers communicate with the extension host via JSON files in a temp directory. The worker writes event files; the extension polls for them and injects follow-up prompts into the session.

### Tab indicator
`extensions/lib/tab-indicator.mjs` provides terminal tab title manipulation to show watcher status. Both extensions use `markWatching()`, `unmarkWatching()`, and `resetWatching()`.

### Webview-based canvas extensions
`excalidraw-workbench` is the exception to the no-build-extension pattern:
- the extension host (`extension.mjs`, `common.mjs`, `server.mjs`) is plain ESM and uses only Node built-ins plus `@github/copilot-sdk`;
- browser dependencies live under `webview/`;
- generated `webview/runtime/` is committed so install scripts remain copy-only;
- CI runs `npm ci`, tests, build, stale-runtime detection, and `npm audit --audit-level=moderate`;
- runtime assets must be served from loopback/local files, not CDNs.

## Updating webview dependencies

Dependabot cannot land a webview dependency update on its own, because it never
rebuilds the committed `runtime/` bundle. Follow this order:

1. Check out the Dependabot branch.
2. `cd extensions/excalidraw-workbench/webview && npm ci && npm run check`
3. **Rebuild and commit `runtime/`.** Vite content-hashes filenames, so most
   build-affecting bumps change the output and the stale-runtime CI check will
   fail otherwise. This is the single biggest source of dependency-PR friction.
4. Run the render check — see below. This is the only step that proves the canvas
   actually renders.
5. Only then merge.

### The render check is not optional for major bumps

`npm run test` and the server smoke tests both pass against a runtime with **no
stylesheet and no fonts**, because neither one paints pixels. A real browser is
the only way to catch that class of break:

```bash
npm install --no-save playwright
npx playwright install chromium
node tools/excalidraw-render-check.mjs            # add --headed to watch it
```

`tools/` lives outside `extensions/` on purpose — the install scripts mirror-copy
everything except `node_modules`, so contributor tooling placed under
`extensions/` would ship into every user's `~/.copilot/extensions`.

### Fail loudly, never skip silently

`webview/scripts/copy-excalidraw-assets.mjs` previously guarded its source paths
with a bare `existsSync` skip. When upstream Excalidraw 0.18 deprecated the
`excalidraw-assets` folder, that guard turned a breaking layout change into a
build that reported success while emitting a runtime with no fonts, no locales,
and no vendor chunk. Both that script and
`webview/scripts/check-runtime-assets.mjs` now hard-fail instead. Do not relax
them to make a dependency bump pass.

### Pinned majors

`@excalidraw/excalidraw`, `react`, `react-dom`, and `jsdom` are pinned to
**majors only** in `.github/dependabot.yml`; patch and minor security updates
still flow normally. The pins are tracked by
[issue #30](https://github.com/cirvine-MSFT/copilot-toolkit/issues/30) and must be
lifted together, not individually — `@excalidraw/excalidraw` 0.17.6's peer range
caps React at 18.

## Adding a new extension

1. Create `extensions/my-extension/extension.mjs`
2. Export tools using `@github/copilot-sdk` patterns (see existing extensions for examples)
3. Add the extension name to both install scripts' extension lists
4. Add it to the CI expected files list in `.github/workflows/ci.yml`
5. Update README.md with the new extension description
6. Run content review (no secrets, no internal URLs)

## Testing

Validation is:
- `node --check` for syntax (covers `extensions/` and `tools/`)
- `node --test` for extension-specific host tests when present
- `node --test extensions/excalidraw-workbench/*.test.mjs` also runs `serve-smoke.test.mjs`, which boots the real loopback server against a sample drawing and verifies every runtime asset serves correctly
- webview package tests/builds for canvas extensions with browser assets, including `scripts/check-runtime-assets.mjs` which asserts the built runtime is actually complete
- `node tools/excalidraw-render-check.mjs` (contributor-only, needs Playwright) for real-browser render verification
- Manual testing in a live Copilot CLI session
- CI smoke tests for install scripts
