// Server worker for the visual-review extension.
// Spawned as a detached process by the extension host:
//   node server-worker.mjs <stateFilePath>
//
// Hosts an HTTP + WebSocket server, serves the browser-based diff viewer
// from the web/ directory, and bridges comments and visualizations between
// the browser and the Copilot CLI session.

import { exec } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { CommentStore } from "./comment-store.mjs";

// ws is a CommonJS package — use createRequire to import it from the
// extension's own node_modules so the worker can run under plain `node`.
const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_DIR = join(__dirname, "web");
const SHUTDOWN_POLL_MS = 5_000;
const STATE_UPDATE_MS = 10_000;
const VIZ_POLL_MS = 3_000;
const MAX_EXEC_BUFFER = 16 * 1024 * 1024;

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
    return new Date().toISOString();
}

function generateId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readJson(filePath) {
    return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        writeFileSync(tempPath, content, "utf8");
        renameSync(tempPath, filePath);
    } catch {
        // Fallback: direct write if rename fails (e.g. cross-device on Windows)
        try { unlinkSync(tempPath); } catch { /* ignore */ }
        writeFileSync(filePath, content, "utf8");
    }
}

function ensureDir(dirPath) {
    mkdirSync(dirPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// State file path from CLI argument
// ---------------------------------------------------------------------------

const stateFilePath = process.argv[2];
if (!stateFilePath) {
    process.stderr.write("server-worker requires a state file path argument.\n");
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Early fatal handlers — registered before anything else can throw
// ---------------------------------------------------------------------------

function writeFatalState(error) {
    try {
        const current = readJson(stateFilePath);
        current.status = "error";
        current.error = String(error?.message ?? error);
        current.updatedAt = nowIso();
        writeJson(stateFilePath, current);
    } catch {
        // Best-effort — state file may not be readable yet
    }
}

process.on("uncaughtException", (err) => {
    process.stderr.write(`[visual-review worker] Uncaught exception: ${err?.stack ?? err}\n`);
    writeFatalState(err);
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[visual-review worker] Unhandled rejection: ${reason?.stack ?? reason}\n`);
    writeFatalState(reason);
    process.exit(1);
});

// ---------------------------------------------------------------------------
// Read initial state
// ---------------------------------------------------------------------------

let state;
try {
    state = readJson(stateFilePath);
} catch (err) {
    process.stderr.write(`Failed to read state file: ${err.message}\n`);
    process.exit(1);
}

const { serverId, port, cwd, theme, scope, base } = state;

// ---------------------------------------------------------------------------
// Directory layout under ~/.copilot/visual-review/
// ---------------------------------------------------------------------------

const vrRoot = join(homedir(), ".copilot", "visual-review");
const eventsDir = join(vrRoot, "events");
const vizDir = join(vrRoot, "viz");
ensureDir(eventsDir);
ensureDir(vizDir);

// ---------------------------------------------------------------------------
// Comment store
// ---------------------------------------------------------------------------

const commentStore = new CommentStore(serverId);
commentStore.load();

// ---------------------------------------------------------------------------
// Diff generation
// ---------------------------------------------------------------------------

let cachedDiff = null;

async function generateDiff() {
    let command;
    switch (scope) {
        case "staged":
            command = "git diff --staged";
            break;
        case "unstaged":
            command = "git diff";
            break;
        case "branch":
        default:
            command = `git diff ${base}..HEAD`;
            break;
    }

    try {
        const { stdout } = await execAsync(command, {
            cwd,
            encoding: "utf8",
            maxBuffer: MAX_EXEC_BUFFER,
        });

        const files = parseDiffFiles(stdout);
        cachedDiff = { diff: stdout, files, scope, base };
    } catch (err) {
        cachedDiff = { diff: "", files: [], scope, base, error: err.message };
    }
}

function parseDiffFiles(diffText) {
    const files = [];
    const diffRe = /^diff --git a\/(.+?) b\/(.+)$/gm;
    let match;
    while ((match = diffRe.exec(diffText)) !== null) {
        files.push({ from: match[1], to: match[2] });
    }
    return files;
}

// ---------------------------------------------------------------------------
// WebSocket server (via ws library)
// ---------------------------------------------------------------------------

/** @type {Set<import("ws").WebSocket>} */
const wsClients = new Set();

function sendToClient(ws, jsonPayload) {
    if (ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify(jsonPayload));
    }
}

function broadcast(jsonPayload) {
    const data = JSON.stringify(jsonPayload);
    for (const ws of wsClients) {
        if (ws.readyState === 1) {
            ws.send(data);
        }
    }
}

// ---------------------------------------------------------------------------
// WebSocket message handler
// ---------------------------------------------------------------------------

function handleWsMessage(ws, message) {
    let msg;
    try {
        msg = JSON.parse(message);
    } catch {
        return;
    }

    switch (msg.type) {
        case "status:connected": {
            // Send current diff data and comments on connect
            if (cachedDiff) {
                sendToClient(ws, { type: "diff:data", ...cachedDiff });
            }
            sendToClient(ws, {
                type: "comment:update",
                threads: commentStore.getThreads(),
            });
            break;
        }

        case "comment:new": {
            const threadId = commentStore.addThread(
                msg.filePath,
                msg.line ?? msg.lineNumber,
                msg.side ?? "right",
                msg.body ?? msg.text,
            );

            broadcast({
                type: "comment:update",
                threads: commentStore.getThreads(),
            });

            writeCommentEvent({
                kind: "comment:new",
                threadId,
                filePath: msg.filePath,
                lineNumber: msg.line ?? msg.lineNumber,
                commentText: msg.body ?? msg.text,
            });
            break;
        }

        case "comment:reply": {
            const commentId = commentStore.addReply(msg.threadId, "user", msg.body ?? msg.text);
            if (commentId) {
                broadcast({
                    type: "comment:update",
                    threads: commentStore.getThreads(),
                });
            }
            break;
        }

        case "comment:resolve": {
            if (commentStore.resolveThread(msg.threadId)) {
                broadcast({
                    type: "comment:update",
                    threads: commentStore.getThreads(),
                });
            }
            break;
        }

        default:
            break;
    }
}

// ---------------------------------------------------------------------------
// Event file writing (consumed by extension host)
// ---------------------------------------------------------------------------

function writeCommentEvent(details) {
    const eventId = generateId("evt");
    const eventPath = join(eventsDir, `${eventId}.json`);

    writeJson(eventPath, {
        eventId,
        serverId,
        kind: details.kind,
        createdAt: nowIso(),
        filePath: details.filePath,
        lineNumber: details.lineNumber,
        commentText: details.commentText,
        threadId: details.threadId,
        deliveredSessionIds: [],
    });
}

// ---------------------------------------------------------------------------
// Visualization polling (reads viz event files written by extension host)
// ---------------------------------------------------------------------------

function pollVisualizations() {
    if (!existsSync(vizDir)) return;

    let entries;
    try {
        entries = readdirSync(vizDir).filter(
            (f) => f.endsWith(".json") && f.startsWith(serverId),
        );
    } catch {
        return;
    }

    for (const entry of entries) {
        const vizPath = join(vizDir, entry);
        try {
            const viz = readJson(vizPath);
            broadcast({
                type: "viz:data",
                title: viz.title ?? "",
                mermaid: viz.mermaid ?? "",
                description: viz.description ?? "",
            });
            // Remove after delivery
            unlinkSync(vizPath);
        } catch {
            // Ignore corrupt/incomplete files
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

function handleRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // ---- Health check (verified by extension host) ----
    if (url.pathname === "/health" && req.method === "GET") {
        return sendJson(res, 200, {
            status: "ok",
            serverId,
            pid: process.pid,
            uptime: process.uptime(),
        });
    }

    // ---- API routes ----
    if (url.pathname === "/api/diff" && req.method === "GET") {
        return sendJson(res, 200, cachedDiff ?? { diff: "", files: [], scope, base });
    }

    if (url.pathname === "/api/comments") {
        if (req.method === "GET") {
            return sendJson(res, 200, { threads: commentStore.getThreads() });
        }

        if (req.method === "POST") {
            return readBody(req).then((body) => {
                try {
                    const msg = JSON.parse(body);
                    const threadId = commentStore.addThread(
                        msg.filePath,
                        msg.lineNumber,
                        msg.side ?? "right",
                        msg.text,
                    );
                    broadcast({
                        type: "comment:update",
                        threads: commentStore.getThreads(),
                    });
                    writeCommentEvent({
                        kind: "comment:new",
                        threadId,
                        filePath: msg.filePath,
                        lineNumber: msg.lineNumber,
                        commentText: msg.text,
                    });
                    return sendJson(res, 201, { threadId });
                } catch {
                    return sendJson(res, 400, { error: "Invalid JSON body" });
                }
            });
        }

        return sendJson(res, 405, { error: "Method not allowed" });
    }

    if (url.pathname === "/api/visualizations" && req.method === "GET") {
        const vizs = [];
        if (existsSync(vizDir)) {
            try {
                const entries = readdirSync(vizDir).filter(
                    (f) => f.endsWith(".json") && f.startsWith(serverId),
                );
                for (const entry of entries) {
                    try {
                        vizs.push(readJson(join(vizDir, entry)));
                    } catch { /* skip */ }
                }
            } catch { /* skip */ }
        }
        return sendJson(res, 200, { visualizations: vizs });
    }

    // ---- Static file serving from web/ ----
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;

    // Prevent directory traversal
    const resolved = resolve(WEB_DIR, `.${filePath}`);
    if (!resolved.startsWith(WEB_DIR)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    if (!existsSync(resolved)) {
        res.writeHead(404);
        res.end("Not Found");
        return;
    }

    const ext = extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    try {
        const content = readFileSync(resolved);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
    } catch {
        res.writeHead(500);
        res.end("Internal Server Error");
    }
}

function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = createServer(handleRequest);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
    wsClients.add(ws);

    ws.on("message", (data) => {
        handleWsMessage(ws, data.toString("utf8"));
    });

    ws.on("close", () => wsClients.delete(ws));
    ws.on("error", () => wsClients.delete(ws));
});

// ---------------------------------------------------------------------------
// Shutdown polling — check state file for stopRequested
// ---------------------------------------------------------------------------

let shutdownTimer;
let stateUpdateTimer;
let vizPollTimer;

function pollShutdown() {
    try {
        const current = readJson(stateFilePath);
        if (current.stopRequested) {
            gracefulShutdown();
        }
    } catch {
        // State file unreadable — keep running
    }
}

function gracefulShutdown() {
    clearInterval(shutdownTimer);
    clearInterval(stateUpdateTimer);
    clearInterval(vizPollTimer);

    // Close all WebSocket connections
    for (const ws of wsClients) {
        try {
            ws.close(1001, "Server shutting down");
        } catch { /* ignore */ }
    }
    wsClients.clear();
    wss.close();

    // Stop accepting new connections
    server.close(() => {
        updateStateFile({ status: "stopped", stoppedAt: nowIso() });
        process.exit(0);
    });

    // Force exit if lingering connections don't close in 3 seconds
    setTimeout(() => {
        updateStateFile({ status: "stopped", stoppedAt: nowIso() });
        process.exit(0);
    }, 3_000);
}

// ---------------------------------------------------------------------------
// State file periodic updates
// ---------------------------------------------------------------------------

function updateStateFile(overrides) {
    try {
        const current = readJson(stateFilePath);
        const updated = {
            ...current,
            connectedClients: wsClients.size,
            updatedAt: nowIso(),
            ...overrides,
        };
        writeJson(stateFilePath, updated);
    } catch {
        // Best-effort — don't crash the worker
    }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
    // Attach error handler BEFORE listen to catch bind failures
    server.on("error", (err) => {
        process.stderr.write(`Server error: ${err.message}\n`);
        updateStateFile({ status: "error", error: err.message });
        process.exit(1);
    });

    // Start HTTP server first so health checks pass quickly.
    // Diff generation happens in the background afterward.
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
        });
    });

    updateStateFile({ status: "running", startedAt: nowIso() });

    // Generate diff in the background — broadcast to any connected clients when ready
    generateDiff()
        .then(() => {
            if (cachedDiff) {
                broadcast({ type: "diff:data", ...cachedDiff });
            }
        })
        .catch((err) => {
            process.stderr.write(`Diff generation failed: ${err.message}\n`);
            cachedDiff = { diff: "", files: [], scope, base, error: err.message };
            broadcast({ type: "diff:data", ...cachedDiff });
        });

    // Poll for shutdown requests
    shutdownTimer = setInterval(pollShutdown, SHUTDOWN_POLL_MS);

    // Periodically update connected client count in state file
    stateUpdateTimer = setInterval(() => updateStateFile({}), STATE_UPDATE_MS);

    // Poll for visualization event files
    vizPollTimer = setInterval(pollVisualizations, VIZ_POLL_MS);
}

start().catch((err) => {
    process.stderr.write(`[visual-review worker] Fatal startup error: ${err?.stack ?? err}\n`);
    writeFatalState(err);
    process.exit(1);
});
