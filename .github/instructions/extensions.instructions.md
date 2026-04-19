---
applyTo: "extensions/**"
---

# Extension development instructions

## Architecture

Each extension is a directory under `extensions/` containing:
- `extension.mjs` — entrypoint that exports tools via `@github/copilot-sdk`
- `common.mjs` — shared helpers (Azure CLI invocation, URL parsing, file I/O)
- Worker files (e.g., `worker.mjs`, `watcher-worker.mjs`) — detached background processes

Extensions register tools that the Copilot agent can invoke. Each tool has a `name`, `description`, `parameters` (JSON Schema), and `handler` function.

## Key patterns

### Worker process spawning
**Never use `process.execPath` directly** — it points to `copilot.exe`, not Node. Use `resolveNodeBinary()` from the shared lib:
```js
import { resolveNodeBinary } from "../lib/resolve-node.mjs";

const nodeBinary = await resolveNodeBinary();
spawn(nodeBinary, [workerPath, ...args], {
    detached: true,
    stdio: ["ignore", "ignore", logFd], // redirect stderr to a log file
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

## Adding a new extension

1. Create `extensions/my-extension/extension.mjs`
2. Export tools using `@github/copilot-sdk` patterns (see existing extensions for examples)
3. Add the extension name to both install scripts' extension lists
4. Add it to the CI expected files list in `.github/workflows/ci.yml`
5. Update README.md with the new extension description
6. Run content review (no secrets, no internal URLs)

## Testing

There are no unit tests for extension logic currently. Validation is:
- `node --check` for syntax
- Manual testing in a live Copilot CLI session
- CI smoke tests for install scripts only
