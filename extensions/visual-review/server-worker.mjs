// Server worker for the visual-review extension.
// Spawned as a detached process by the extension host:
//   process.execPath server-worker.mjs <stateFilePath>
//
// Hosts an HTTP server with a manual WebSocket implementation, serves the
// browser-based diff viewer from the web/ directory, and bridges comments
// and visualizations between the browser and the Copilot CLI session.

import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { CommentStore } from "./comment-store.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_DIR = join(__dirname, "web");
const WEBSOCKET_MAGIC = "258EAFA5-E914-47DA-95CA-5AB9C11FE5B4";
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
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
// WebSocket protocol helpers (RFC 6455, text frames only, no extensions)
// ---------------------------------------------------------------------------

function computeAcceptKey(clientKey) {
    return createHash("sha1")
        .update(clientKey + WEBSOCKET_MAGIC)
        .digest("base64");
}

function handleUpgrade(req, socket) {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
        socket.destroy();
        return null;
    }

    const accept = computeAcceptKey(key);
    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );

    return socket;
}

/**
 * Encode a UTF-8 string into a WebSocket text frame (opcode 0x1, FIN set).
 * Server-to-client frames are never masked.
 */
function encodeFrame(data) {
    const payload = Buffer.from(data, "utf8");
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81; // FIN + text opcode
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}

/**
 * Encode a close frame (opcode 0x8).
 * @param {number} code  Status code (e.g. 1000 for normal closure)
 */
function encodeCloseFrame(code) {
    const buf = Buffer.alloc(4);
    buf[0] = 0x88; // FIN + close opcode
    buf[1] = 2;    // payload length = 2 bytes for the status code
    buf.writeUInt16BE(code, 2);
    return buf;
}

/** Encode a pong frame echoing the given payload. */
function encodePongFrame(payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x8a; // FIN + pong opcode
        header[1] = len;
    } else {
        header = Buffer.alloc(4);
        header[0] = 0x8a;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    }
    return Buffer.concat([header, payload]);
}

/**
 * Streaming frame decoder. Accumulates incoming buffers and yields decoded
 * frames as they become complete.
 */
class FrameDecoder {
    constructor() {
        this.buffer = Buffer.alloc(0);
    }

    /** Append new data and return an array of decoded frames. */
    push(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        const frames = [];

        while (true) {
            const frame = this._tryDecode();
            if (!frame) break;
            frames.push(frame);
        }

        return frames;
    }

    _tryDecode() {
        const buf = this.buffer;
        if (buf.length < 2) return null;

        const firstByte = buf[0];
        const secondByte = buf[1];

        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
            if (buf.length < 4) return null;
            payloadLen = buf.readUInt16BE(2);
            offset = 4;
        } else if (payloadLen === 127) {
            if (buf.length < 10) return null;
            payloadLen = Number(buf.readBigUInt64BE(2));
            offset = 10;
        }

        const maskSize = isMasked ? 4 : 0;
        const totalNeeded = offset + maskSize + payloadLen;
        if (buf.length < totalNeeded) return null;

        let payload;
        if (isMasked) {
            const mask = buf.subarray(offset, offset + 4);
            payload = Buffer.alloc(payloadLen);
            const masked = buf.subarray(offset + 4, offset + 4 + payloadLen);
            for (let i = 0; i < payloadLen; i++) {
                payload[i] = masked[i] ^ mask[i % 4];
            }
        } else {
            payload = buf.subarray(offset, offset + payloadLen);
        }

        // Advance the buffer past this frame
        this.buffer = buf.subarray(totalNeeded);

        return { opcode, payload };
    }
}

// ---------------------------------------------------------------------------
// WebSocket connection tracking
// ---------------------------------------------------------------------------

/** @type {Set<import("node:net").Socket>} */
const wsClients = new Set();

/** @type {Map<import("node:net").Socket, FrameDecoder>} */
const wsDecoders = new Map();

function sendToSocket(socket, jsonPayload) {
    if (socket.writable) {
        socket.write(encodeFrame(JSON.stringify(jsonPayload)));
    }
}

function broadcast(jsonPayload) {
    const frame = encodeFrame(JSON.stringify(jsonPayload));
    for (const socket of wsClients) {
        if (socket.writable) {
            socket.write(frame);
        }
    }
}

function removeClient(socket) {
    wsClients.delete(socket);
    wsDecoders.delete(socket);
}

// ---------------------------------------------------------------------------
// WebSocket message handler
// ---------------------------------------------------------------------------

function handleWsMessage(socket, message) {
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
                sendToSocket(socket, { type: "diff:data", ...cachedDiff });
            }
            sendToSocket(socket, {
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

            // Broadcast updated threads to all clients
            broadcast({
                type: "comment:update",
                threads: commentStore.getThreads(),
            });

            // Write event file for the extension host to pick up
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

server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname !== "/ws") {
        socket.destroy();
        return;
    }

    const ws = handleUpgrade(req, socket);
    if (!ws) return;

    const decoder = new FrameDecoder();
    wsClients.add(ws);
    wsDecoders.set(ws, decoder);

    // Feed any buffered data from the upgrade
    if (head && head.length > 0) {
        processIncoming(ws, decoder, head);
    }

    ws.on("data", (data) => {
        processIncoming(ws, decoder, data);
    });

    ws.on("close", () => removeClient(ws));
    ws.on("error", () => removeClient(ws));
});

function processIncoming(socket, decoder, data) {
    const frames = decoder.push(data);

    for (const frame of frames) {
        switch (frame.opcode) {
            case 0x1: // text
                handleWsMessage(socket, frame.payload.toString("utf8"));
                break;
            case 0x8: // close
                socket.write(encodeCloseFrame(1000));
                socket.end();
                removeClient(socket);
                break;
            case 0x9: // ping
                socket.write(encodePongFrame(frame.payload));
                break;
            case 0xa: // pong — ignore
                break;
            default:
                break;
        }
    }
}

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
    for (const socket of wsClients) {
        try {
            socket.write(encodeCloseFrame(1001));
            socket.end();
        } catch { /* ignore */ }
    }
    wsClients.clear();
    wsDecoders.clear();

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
    // Generate diff on startup
    await generateDiff();

    // Start HTTP server on loopback only
    server.listen(port, "127.0.0.1", () => {
        updateStateFile({ status: "running", startedAt: nowIso() });
    });

    server.on("error", (err) => {
        process.stderr.write(`Server error: ${err.message}\n`);
        updateStateFile({ status: "error", error: err.message });
        process.exit(1);
    });

    // Poll for shutdown requests
    shutdownTimer = setInterval(pollShutdown, SHUTDOWN_POLL_MS);

    // Periodically update connected client count in state file
    stateUpdateTimer = setInterval(() => updateStateFile({}), STATE_UPDATE_MS);

    // Poll for visualization event files
    vizPollTimer = setInterval(pollVisualizations, VIZ_POLL_MS);
}

start();
