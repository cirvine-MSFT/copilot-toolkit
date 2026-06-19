# Excalidraw Workbench

A [GitHub Copilot](https://github.com/features/copilot) app canvas extension that opens repository `.excalidraw` drawings in an interactive workbench. The full Excalidraw editor runs in a Copilot canvas with durable comments and replies, agent actions for patching the scene or capturing snapshots, and a local loopback-only webview — no CDNs, no cloud round-trips.

![Excalidraw Workbench smoke-test canvas with comment markers and comments pane](../../docs/images/excalidraw-workbench-smoke-test.png)

## What you get

- **Full Excalidraw editor** embedded in a Copilot canvas panel, opened via natural language ("open this drawing in the Excalidraw workbench").
- **Durable comments** anchored to elements or scene coordinates, stored in a sidecar `<drawing>.excalidraw.comments.json` file next to the drawing. Reply, resolve, and reopen threads from the canvas or the agent.
- **Agent collaboration** — new comments are forwarded to the Copilot session so the agent can respond inline, propose changes, or patch the scene.
- **Snapshot capture** — request an SVG or PNG snapshot of the current canvas state for the agent to inspect visual layout and pixels.
- **Offline-friendly** — Excalidraw assets are committed under `webview/runtime/` and served from a `127.0.0.1` loopback HTTP server. Nothing is fetched from external CDNs at runtime.

## Install

Excalidraw Workbench is distributed with the rest of the [`copilot-toolkit`](../../README.md) extensions. Install the whole set or this one only.

### PowerShell (Windows)

```powershell
git clone https://github.com/cirvine-msft/copilot-toolkit.git
cd copilot-toolkit
.\install-extensions.ps1 excalidraw-workbench
```

### Bash (macOS / Linux)

```bash
git clone https://github.com/cirvine-msft/copilot-toolkit.git
cd copilot-toolkit
./install-extensions.sh excalidraw-workbench
```

The install script mirrors the extension into `~/.copilot/extensions/excalidraw-workbench/` (or `$COPILOT_HOME/extensions/` if set), including the prebuilt webview under `webview/runtime/`. **End users do not need Node.js or `npm`** — the runtime bundle is committed to the repo and copied as-is.

After installing, run `/clear` in the GitHub Copilot app or restart it so the new canvas type is registered.

### Verify the install

```bash
ls ~/.copilot/extensions/excalidraw-workbench/webview/runtime/index.html
```

If that file exists, the canvas is ready to open.

### Update

```bash
cd copilot-toolkit
git pull
./install-extensions.sh excalidraw-workbench   # or .\install-extensions.ps1 excalidraw-workbench
```

The script deletes the target directory before copying, so stale files from previous versions are removed.

### Uninstall

```bash
rm -rf ~/.copilot/extensions/excalidraw-workbench
```

Then `/clear` or restart the GitHub Copilot app.

## Usage

Drive everything through natural language in a GitHub Copilot app session — never call canvas actions directly.

```text
# Open a drawing
Open examples/excalidraw/smoke-test.excalidraw in the Excalidraw workbench

# Have the agent inspect visual layout
Capture a snapshot of the canvas and review the layout

# Comments — write them in the canvas; the agent will be notified.
# Or ask the agent to:
List the open comments on this drawing
Reply to the spacing comment: "Bumped the arrow padding to 24px"
Mark the spacing comment as resolved

# Patch the scene
Nudge the "Editable box" element 40px to the right and recolor it green
```

You can have multiple workbench instances open at once (each is a separate canvas panel with its own loopback port). Closing the panel shuts the local server down.

## Canvas actions (for reference)

The agent can invoke these on an open `excalidraw-workbench` canvas:

| Action | What it does |
|--------|--------------|
| `get_loaded_file` | Returns metadata for the loaded drawing (path, title, active comment count, revision). |
| `list_comments` | Lists unresolved comments and their replies. |
| `reply_to_comment` | Adds an agent reply to a comment thread. |
| `resolve_comment` | Marks a comment as resolved. |
| `apply_element_patch` | Patches simple fields on an Excalidraw element (`x`, `y`, `width`, `height`, `text`, `strokeColor`, `backgroundColor`). |
| `save_source` | Replaces the scene JSON, guarded by a base-revision check to avoid clobbering newer edits. |
| `refresh_diagram` | Reloads the open webview's drawing and comment state from disk. |
| `capture_snapshot` | Writes a local SVG or PNG snapshot for the agent to inspect. Tries the live webview first, falls back to a host-side SVG render. |

You almost never invoke these by name — describe the outcome you want and Copilot picks the action.

## Files the extension writes

| File | What it is |
|------|------------|
| `<drawing>.excalidraw` | The drawing itself (your file — the extension updates it in place when you save or when the agent patches the scene). |
| `<drawing>.excalidraw.comments.json` | Sidecar file with durable comment threads. Commit this alongside the drawing if you want comments to travel with the repo. |
| Session snapshot artifacts | `capture_snapshot` writes `.svg` / `.png` artifacts into the current Copilot session's artifact directory (not the repo). |

## How it works

1. **Open** — Copilot opens the `excalidraw-workbench` canvas with a workspace-local `.excalidraw` file path.
2. **Serve** — The extension starts a loopback-only HTTP server on `127.0.0.1` with a random per-instance API token, and serves prebuilt webview assets from `webview/runtime/`.
3. **Edit** — The webview embeds the full Excalidraw editor and saves scene JSON back to the checked-out file.
4. **Comment** — Comment markers and threads are stored in the sidecar `<drawing>.excalidraw.comments.json`.
5. **Collaborate** — New comments are forwarded to the agent via a session prompt; the agent can list/reply/resolve comments, patch element fields, save source, or capture snapshots.

The bundled webview lives under `webview/runtime/` (not `dist/`) so source-folder extension installers that skip conventional build output directories still copy everything required to open the canvas.

## Security & network behavior

This is the short version of what the extension does on your machine. **Read this before installing.**

### What the install script does

- The install script (`install-extensions.sh` / `install-extensions.ps1`) is a **file copy only** — it does not run `npm install`, does not download packages, and does not run any code from this repo on your machine during install.
- It copies the source from your cloned `copilot-toolkit/` working tree into `~/.copilot/extensions/excalidraw-workbench/` (or `$COPILOT_HOME/extensions/`). Inspect the source before running the script if you want full assurance.
- Because the bundle is committed and copied verbatim, the install footprint is exactly what you can see in `extensions/excalidraw-workbench/` on GitHub.

### What the extension does at runtime

| Behavior | Detail |
|----------|--------|
| **Local-only HTTP server** | Each open canvas starts a Node.js HTTP server bound to `127.0.0.1` on a random ephemeral port. It does not listen on any non-loopback interface. |
| **Per-instance API token** | A 256-bit random token is generated when the canvas opens; every API and SSE request must present it via `X-Excalidraw-Workbench-Token` or `?token=`. Requests are also rejected unless `Host` and `Origin` match the loopback URL. |
| **Strict Content-Security-Policy** | The served HTML sets `connect-src 'self'`, `script-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, `font-src 'self' data:`. The webview cannot fetch from any external host. |
| **No CDN fetches** | All Excalidraw assets (JS, CSS, fonts, locales) ship under `webview/runtime/` and are served from the loopback server. Nothing is loaded from the internet. |
| **Filesystem scope** | The extension only reads/writes files inside your active workspace. Drawing paths outside the workspace root are rejected; static-asset paths are sandboxed under `webview/runtime/`. |

### What it does *not* do

- No telemetry, analytics, crash reporting, or version-check pings.
- No outbound HTTP from the extension or the bundled webview.
- No package downloads at install or run time.
- No code execution from `.excalidraw` files (they are parsed as JSON only).

### Heads-up about the bundled Excalidraw library

The committed Excalidraw bundle contains URLs to the upstream project's services (`libraries.excalidraw.com`, `plus.excalidraw.com`, firebase, embed providers like YouTube/Vimeo/Figma). These are **referenced in strings inside the bundle but never actually contacted** because the Content-Security-Policy above blocks `connect-src` and `img-src` to anything except `'self'`. Practical effect:

- Built-in **"Browse libraries"** and **"Excalidraw+ sign-in"** buttons inside the editor UI are non-functional inside the workbench (clicking them does nothing or shows a blocked-network error).
- Embedded YouTube/Vimeo/Figma/Twitter elements in a scene render as placeholders, not live previews.

If you want those features, use the upstream Excalidraw web app instead — this workbench is designed for offline, in-repo authoring.

### What gets written to disk

| Location | Contents | Trust boundary |
|----------|----------|----------------|
| `<drawing>.excalidraw` | Your drawing, updated in place when you save or when the agent patches the scene. | In-workspace; commit at your discretion. |
| `<drawing>.excalidraw.comments.json` | Comment threads and replies. Authored by you and/or the agent. | In-workspace; commit if you want comments to travel with the repo. |
| Session artifact directory | `capture_snapshot` writes SVG/PNG snapshots into the current Copilot session's artifact folder. | Outside the repo. |

### Trust boundary with the agent

Comment text, drawing JSON, and snapshot data are routed through the Copilot session as **untrusted input** — the extension explicitly labels these payloads as untrusted drawing data so the agent treats them as context rather than instructions. Comments and replies *do* reach the GitHub Copilot service as part of normal agent conversation traffic; the "no outbound HTTP" guarantee above applies to the extension itself, not to the agent's normal service traffic.

### Verifying provenance

- `extensions/excalidraw-workbench/webview/runtime/PROVENANCE.json` records the exact upstream package versions baked into the committed runtime bundle, with regeneration instructions.
- `extensions/excalidraw-workbench/THIRD_PARTY_NOTICES.md` lists licenses for everything in the bundle.
- Rebuild from source with `cd extensions/excalidraw-workbench/webview && npm ci && npm run build` if you want byte-for-byte audit.

## Requirements

- [GitHub Copilot](https://github.com/features/copilot) app
- A workspace containing `.excalidraw` or `.excalidraw.json` files

For contributors only:

- Node.js 20.19+ and npm to run the webview tests and rebuild the runtime bundle. End users do not need these.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Canvas type isn't recognized after install | Run `/clear` in the GitHub Copilot app or restart it. |
| Canvas opens but Excalidraw assets fail to load | Verify `~/.copilot/extensions/excalidraw-workbench/webview/runtime/index.html` exists. If missing, reinstall and `/clear`. |
| Comments disappeared | Check for the sidecar `<drawing>.excalidraw.comments.json` next to your drawing. Restore from git history if it was deleted. |
| Save conflicts on `save_source` | The agent's `baseRevision` is stale — refresh the webview, then ask the agent to retry. |
| Snapshot returned the host-fallback SVG instead of the live render | The webview wasn't reachable (e.g., panel was closed). Reopen the canvas and retry. |

## License and third-party content

[MIT](../../LICENSE). Bundled Excalidraw assets are licensed under their own terms — see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
