// copilot-webview: reusable helper class for hosting a native webview window
// from a Copilot CLI extension and exchanging eval/RPC messages with it.
//
// Public API:
//   bootstrap(extDir)
//       Installs npm deps if package-lock is missing/stale. Logs via the SDK.
//   new CopilotWebview({ extensionName, contentDir, callbacks?, title?, width?, height? })
//       One window per instance. Properties / methods:
//         .tools                 → array of tool defs (`<extensionName>_show`,
//                                  `<extensionName>_eval`, `<extensionName>_close`)
//                                  to spread into joinSession({ tools }).
//         .show({ reload? })     → opens the window if not already open. If
//                                  already open and `reload: true`, reloads
//                                  the page; otherwise leaves it untouched.
//                                  Returns the window handle either way.
//         .eval(code, opts?)     → run JS in the page; rejects if not open.
//         .close()               → close the window if open. Pre-bound so it
//                                  can be passed directly as hooks.onSessionEnd.
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep, isAbsolute, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { joinSession } from "@github/copilot-sdk/extension";

const __dirname = import.meta.dirname;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2" };

const BRIDGE_JS = `(() => {
    const ws = new WebSocket("ws://" + location.host);
    const pending = new Map();
    let nextId = 0;
    const ready = new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data);
        if ("code" in msg) {
            let result, error;
            try {
                result = await (0, eval)(msg.code);
                try { JSON.stringify(result); } catch { result = String(result); }
            } catch (e) { error = e?.stack || String(e); }
            ws.send(JSON.stringify({ id: msg.id, result, error }));
        } else {
            const cb = pending.get(msg.id);
            if (cb) { pending.delete(msg.id); cb(msg); }
        }
    };
    window.copilot = new Proxy({}, {
        get: (_, method) => async (...args) => {
            await ready;
            return new Promise((resolve, reject) => {
                const id = "p" + (nextId++);
                pending.set(id, ({ result, error }) => error ? reject(new Error(error)) : resolve(result));
                ws.send(JSON.stringify({ id, method, args }));
            });
        },
    });
})();`;

function staticHandler(rootDir) {
    return async (req, res) => {
        if (req.url === "/__bridge.js") {
            res.writeHead(200, { "Content-Type": "text/javascript" });
            return res.end(BRIDGE_JS);
        }
        const rel = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
        const abs = normalize(join(rootDir, rel));
        if (!abs.startsWith(rootDir + sep)) return res.writeHead(403).end();
        try {
            const buf = await readFile(abs);
            res.writeHead(200, { "Content-Type": MIME[extname(abs)] || "application/octet-stream" });
            res.end(buf);
        } catch {
            if (!res.headersSent) res.writeHead(404);
            res.end();
        }
    };
}

export async function bootstrap(extDir) {
    const pkg = join(extDir, "package.json");
    const lock = join(extDir, "package-lock.json");
    if (existsSync(lock) && statSync(pkg).mtimeMs <= statSync(lock).mtimeMs) return;
    const session = await joinSession();
    await session.log("Installing extension dependencies…");
    execSync("npm install --no-audit --no-fund", { cwd: extDir, stdio: "ignore" });
    await session.log("Dependencies installed.");
    await session.disconnect();
}

async function showWebview({ dir, title = "Copilot Webview", width = 900, height = 700, callbacks = {} } = {}) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`directory does not exist: ${dir}`);
    if (!existsSync(join(dir, "index.html"))) throw new Error(`${dir} does not contain an index.html file`);
    const { WebSocketServer } = await import("ws");

    const id = randomBytes(4).toString("hex");
    const pending = new Map();
    let socket = null;
    const closeListeners = [];

    const server = createServer(staticHandler(dir));
    server.on("clientError", (_e, s) => { try { s.destroy(); } catch {} });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (sock) => {
        socket = sock;
        sock.on("message", async (data) => {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }
            if ("method" in msg) {
                let result, error;
                try {
                    const fn = callbacks[msg.method];
                    if (typeof fn !== "function") throw new Error(`unknown callback: ${msg.method}`);
                    result = await fn(...(msg.args || []));
                    try { JSON.stringify(result); } catch { result = String(result); }
                } catch (e) { error = e?.stack || String(e); }
                sock.send(JSON.stringify({ id: msg.id, result, error }));
            } else {
                const cb = pending.get(msg.id);
                if (cb) { pending.delete(msg.id); cb(msg); }
            }
        });
        sock.on("close", () => { if (socket === sock) socket = null; });
    });

    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/`;

    // On Windows, WebView2 reads WEBVIEW2_USER_DATA_FOLDER and would otherwise
    // create a default folder we don't control. Use a per-window dir we can clean
    // up on exit. macOS (WKWebView) and Linux (webkit2gtk) store data in platform
    // defaults shared by the host process — nothing to redirect or orphan per-window.
    const userDataDir = process.platform === "win32" ? join(tmpdir(), `copilot-webview-${id}`) : null;
    const childEnv = { ...process.env, CW_URL: url, CW_TITLE: title, CW_WIDTH: String(width), CW_HEIGHT: String(height) };
    if (userDataDir) childEnv.WEBVIEW2_USER_DATA_FOLDER = userDataDir;

    const child = spawn("node", [join(__dirname, "webview-child.mjs")], {
        stdio: ["ignore", "ignore", "inherit"],
        env: childEnv,
    });

    const handle = {
        eval(code, { timeoutMs = 3000 } = {}) {
            if (!socket) return Promise.reject(new Error("webview page is not connected yet"));
            const reqId = randomUUID();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(reqId); reject(new Error(`timeout (${timeoutMs}ms)`)); }, timeoutMs);
                pending.set(reqId, ({ result, error }) => { clearTimeout(timer); error ? reject(new Error(error)) : resolve(result); });
                socket.send(JSON.stringify({ id: reqId, code }));
            });
        },
        close() { if (!child.killed) child.kill(); },
        onClose(cb) { closeListeners.push(cb); },
    };

    child.on("exit", (code) => {
        server.close();
        for (const cb of closeListeners) try { cb(code); } catch {}
        if (userDataDir) {
            // WebView2 may still hold file locks for a moment after exit on Windows.
            (async () => {
                for (let i = 0; i < 5; i++) {
                    try { await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }); return; }
                    catch { await new Promise((r) => setTimeout(r, 200 * (i + 1))); }
                }
            })();
        }
    });

    return handle;
}

// Copilot CLI extension wrapper around showWebview. One instance manages a
// single window for one extension. Tools are exposed via `.tools`. The slash
// command lives in main.mjs and just calls `.show()`.
export class CopilotWebview {
    constructor({ extensionName, contentDir, callbacks = {}, title, width, height } = {}) {
        if (!extensionName || typeof extensionName !== "string") {
            throw new Error("CopilotWebview: `extensionName` is required (used to prefix tool names).");
        }
        if (!contentDir || typeof contentDir !== "string") {
            throw new Error("CopilotWebview: `contentDir` is required (path to the directory containing index.html).");
        }
        this.extensionName = extensionName;
        this.prefix = extensionName.replace(/[^a-zA-Z0-9_]/g, "_");
        this.contentDir = isAbsolute(contentDir) ? contentDir : resolve(process.cwd(), contentDir);
        this.callbacks = callbacks;
        this.title = title;
        this.width = width;
        this.height = height;
        this._handle = null;
        this.close = this.close.bind(this);
    }

    async show({ reload = false } = {}) {
        if (this._handle) {
            if (reload) await this._handle.eval("location.reload()", { timeoutMs: 1000 }).catch(() => {});
            return this._handle;
        }
        const handle = await showWebview({
            dir: this.contentDir,
            title: this.title,
            width: this.width,
            height: this.height,
            callbacks: this.callbacks,
        });
        this._handle = handle;
        handle.onClose(() => { if (this._handle === handle) this._handle = null; });
        return handle;
    }

    eval(code, opts) {
        if (!this._handle) return Promise.reject(new Error("webview is not open"));
        return this._handle.eval(code, opts);
    }

    close() { if (this._handle) this._handle.close(); }

    get tools() {
        const { prefix } = this;
        return [
            {
                name: `${prefix}_show`,
                description: "Open the extension's native desktop window. If already open, by default leaves it untouched; pass reload=true to refresh the page.",
                parameters: {
                    type: "object",
                    properties: {
                        reload: { type: "boolean", description: "If the window is already open, reload the page. Default false." },
                    },
                },
                handler: async ({ reload = false } = {}) => {
                    try {
                        const wasOpen = !!this._handle;
                        await this.show({ reload });
                        if (!wasOpen) return "Webview window opened.";
                        return reload ? "Webview already open; refreshed." : "Webview already open.";
                    } catch (e) {
                        return `Error: ${e.message}`;
                    }
                },
            },
            {
                name: `${prefix}_eval`,
                description: "Evaluate JavaScript inside the open webview window and return the result. Useful for DOM queries, reading state, or driving the page.",
                parameters: {
                    type: "object",
                    properties: {
                        code: { type: "string", description: "JavaScript code to evaluate. The result of the last expression is returned." },
                        timeout: { type: "number", description: "Timeout in seconds. Default 3, max 10." },
                    },
                    required: ["code"],
                },
                handler: async ({ code, timeout }) => {
                    const timeoutMs = Math.min(Math.max(Number(timeout) || 3, 0.1), 10) * 1000;
                    try {
                        const r = await this.eval(code, { timeoutMs });
                        return typeof r === "string" ? r : JSON.stringify(r);
                    } catch (e) {
                        return `Error: ${e.message}`;
                    }
                },
            },
            {
                name: `${prefix}_close`,
                description: "Close the webview window if it is open.",
                parameters: { type: "object", properties: {} },
                handler: async () => {
                    this.close();
                    return "Closed.";
                },
            },
        ];
    }
}
