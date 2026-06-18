import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sceneRevision } from "./scene-normalize.mjs";
import {
    addReply,
    applyElementPatch,
    createComment,
    findComment,
    htmlEscape,
    jsonResponse,
    listActiveComments,
    loadDiagram,
    normalizeDiagram,
    readRequestJson,
    resolveComment,
    saveCommentState,
    saveDiagram,
} from "./common.mjs";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const webviewRuntimeDir = join(extensionDir, "webview", "runtime");
const snapshotTimeoutMs = 5000;

const contentTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml; charset=utf-8"],
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".woff2", "font/woff2"],
    [".woff", "font/woff"],
    [".ttf", "font/ttf"],
]);

export async function startWorkbenchServer(entry, handlers) {
    await assertWebviewRuntimeAssets();

    entry.sseClients = new Set();
    entry.snapshotRequests = new Map();

    const server = createServer(async (req, res) => {
        try {
            await handleRequest(entry, handlers, req, res);
        } catch (error) {
            jsonResponse(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    });

    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    entry.expectedHost = `127.0.0.1:${port}`;
    return { server, url: `http://127.0.0.1:${port}/` };
}

export async function closeWorkbenchServer(entry) {
    for (const client of entry.sseClients ?? []) {
        client.end();
    }
    entry.sseClients?.clear();

    for (const request of entry.snapshotRequests?.values() ?? []) {
        clearTimeout(request.timer);
        request.reject(new Error("Canvas closed before snapshot completed."));
    }
    entry.snapshotRequests?.clear();

    await new Promise((resolveClose) => entry.server.close(() => resolveClose()));
}

export async function requestLiveSnapshot(entry, options = {}) {
    if (!entry.sseClients || entry.sseClients.size === 0) {
        throw new Error("No live webview is connected for snapshot capture.");
    }

    const requestId = `snapshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            entry.snapshotRequests.delete(requestId);
            reject(new Error("Timed out waiting for the webview snapshot."));
        }, snapshotTimeoutMs);

        entry.snapshotRequests.set(requestId, { resolve, reject, timer });
    });

    sendEvent(entry, {
        type: "snapshot-request",
        requestId,
        format: options.format === "png" ? "png" : "svg",
    });

    return promise;
}

export function sendEvent(entry, payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of entry.sseClients ?? []) {
        client.write(data);
    }
}

export function refreshWorkbench(entry, reason = "refresh", fields = {}) {
    sendEvent(entry, { type: "refresh-scene", reason, ...fields });
}

export async function enqueueSceneSave(entry, operation) {
    const previous = entry.sceneSaveQueue ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const queued = result.catch(() => {});
    entry.sceneSaveQueue = queued;

    try {
        return await result;
    } finally {
        if (entry.sceneSaveQueue === queued) {
            entry.sceneSaveQueue = null;
        }
    }
}

export async function assertWebviewRuntimeAssets(runtimeDir = webviewRuntimeDir) {
    const indexPath = join(runtimeDir, "index.html");
    try {
        await access(indexPath);
    } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
            throw error;
        }

        throw new Error([
            `Excalidraw Workbench webview assets are missing: ${indexPath}`,
            "Install with the copilot-toolkit install script, or run `npm ci && npm run build` in extensions/excalidraw-workbench/webview before reinstalling or reloading the extension.",
        ].join(" "));
    }
}

async function handleRequest(entry, handlers, req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/events") {
        if (!isAuthorizedRequest(entry, req, url)) {
            jsonResponse(res, 403, { error: "Forbidden." });
            return;
        }
        handleEvents(entry, req, res);
        return;
    }

    if (url.pathname.startsWith("/api/")) {
        if (!isAuthorizedRequest(entry, req, url)) {
            jsonResponse(res, 403, { error: "Forbidden." });
            return;
        }
        await handleApiRequest(entry, handlers, req, res, url);
        return;
    }

    await serveStaticRequest(entry, req, res, url);
}

function handleEvents(entry, req, res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
    entry.sseClients.add(res);
    req.on("close", () => {
        entry.sseClients.delete(res);
    });
}

function isAuthorizedRequest(entry, req, url) {
    if (req.headers.host !== entry.expectedHost) {
        return false;
    }

    const origin = req.headers.origin;
    if (origin && origin !== `http://${entry.expectedHost}`) {
        return false;
    }

    const suppliedToken = req.headers["x-excalidraw-workbench-token"] ?? url.searchParams.get("token");
    return typeof suppliedToken === "string" && suppliedToken === entry.apiToken;
}

async function handleApiRequest(entry, handlers, req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/scene") {
        const diagram = await loadDiagram(entry.filePath);
        jsonResponse(res, 200, {
            scene: diagram,
            revision: sceneRevision(diagram),
            comments: entry.commentState.comments,
            title: entry.title,
            displayPath: entry.displayPath,
        });
        return;
    }

    if (req.method === "POST" && url.pathname === "/api/scene") {
        const input = await readRequestJson(req);
        const scene = input.scene ?? input;
        const result = await enqueueSceneSave(entry, async () => {
            const baseRevision = typeof input.baseRevision === "string" ? input.baseRevision : null;
            if (baseRevision) {
                const current = await loadDiagram(entry.filePath);
                if (sceneRevision(current) !== baseRevision) {
                    return { conflict: true };
                }
            }

            const diagram = normalizeDiagram(scene);
            await saveDiagram(entry.filePath, diagram);
            return { revision: sceneRevision(diagram) };
        });

        if (result.conflict) {
            jsonResponse(res, 409, { error: "The drawing changed on disk. Refresh before saving again." });
            return;
        }

        const clientId = typeof input.clientId === "string" && input.clientId.trim() !== ""
            ? input.clientId.trim()
            : null;
        refreshWorkbench(entry, "scene-saved", clientId ? { clientId } : {});
        jsonResponse(res, 200, { saved: true, revision: result.revision });
        return;
    }

    if (req.method === "GET" && url.pathname === "/api/comments") {
        jsonResponse(res, 200, { comments: entry.commentState.comments });
        return;
    }

    if (req.method === "POST" && url.pathname === "/api/comments") {
        const input = await readRequestJson(req);
        const comment = createComment(input);
        entry.commentState.comments.push(comment);
        await saveCommentState(entry.filePath, entry.commentState);

        if (input.notifyAgent) {
            await handlers.onCommentCreated(entry, comment);
        }

        sendEvent(entry, { type: "comments-updated", reason: "comment-created", commentId: comment.id });
        jsonResponse(res, 201, { comment });
        return;
    }

    const replyMatch = url.pathname.match(/^\/api\/comments\/([^/]+)\/replies$/);
    if (replyMatch && req.method === "POST") {
        const input = await readRequestJson(req);
        const { comment, reply } = addReply(entry.commentState, decodeURIComponent(replyMatch[1]), input.body, input.author ?? "agent");
        await saveCommentState(entry.filePath, entry.commentState);
        if ((input.author ?? "agent") !== "agent" && input.notifyAgent !== false) {
            await handlers.onCommentReplyCreated(entry, comment, reply);
        }
        sendEvent(entry, { type: "comments-updated", reason: "comment-replied", commentId: comment.id });
        jsonResponse(res, 201, { comment, reply });
        return;
    }

    const resolveMatch = url.pathname.match(/^\/api\/comments\/([^/]+)\/resolve$/);
    if (resolveMatch && req.method === "POST") {
        const comment = resolveComment(entry.commentState, decodeURIComponent(resolveMatch[1]));
        await saveCommentState(entry.filePath, entry.commentState);
        sendEvent(entry, { type: "comments-updated", reason: "comment-resolved", commentId: comment.id });
        jsonResponse(res, 200, { comment });
        return;
    }

    const elementMatch = url.pathname.match(/^\/api\/elements\/([^/]+)$/);
    if (elementMatch && req.method === "POST") {
        const input = await readRequestJson(req);
        const element = await enqueueSceneSave(entry, async () => {
            const diagram = await loadDiagram(entry.filePath);
            const patchedElement = applyElementPatch(diagram, decodeURIComponent(elementMatch[1]), input.patch ?? input);
            await saveDiagram(entry.filePath, diagram);
            return patchedElement;
        });
        refreshWorkbench(entry, "element-patched");
        jsonResponse(res, 200, { saved: true, element });
        return;
    }

    const snapshotMatch = url.pathname.match(/^\/api\/snapshots\/([^/]+)$/);
    if (snapshotMatch && req.method === "POST") {
        const requestId = decodeURIComponent(snapshotMatch[1]);
        const pending = entry.snapshotRequests.get(requestId);
        if (!pending) {
            jsonResponse(res, 404, { error: "Snapshot request not found or expired." });
            return;
        }

        const input = await readRequestJson(req);
        entry.snapshotRequests.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(input);
        jsonResponse(res, 200, { received: true });
        return;
    }

    if (req.method === "GET" && url.pathname === "/api/summary") {
        jsonResponse(res, 200, {
            loaded: true,
            filePath: entry.filePath,
            displayPath: entry.displayPath,
            title: entry.title,
            activeComments: listActiveComments(entry.commentState).length,
        });
        return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/comments/")) {
        const commentId = decodeURIComponent(url.pathname.slice("/api/comments/".length));
        jsonResponse(res, 200, { comment: findComment(entry.commentState, commentId) });
        return;
    }

    jsonResponse(res, 404, { error: "Not found." });
}

async function serveStaticRequest(entry, req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") {
        jsonResponse(res, 405, { error: "Method not allowed." });
        return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await renderIndexHtml(entry);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Security-Policy", [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self'",
            "worker-src 'self' blob:",
        ].join("; "));
        res.end(req.method === "HEAD" ? "" : html);
        return;
    }

    if (url.pathname === "/favicon.ico") {
        res.statusCode = 204;
        res.end();
        return;
    }

    const filePath = resolveStaticPath(url.pathname);
    if (!filePath) {
        jsonResponse(res, 404, { error: "Not found." });
        return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream");
    if (req.method === "HEAD") {
        res.end();
        return;
    }

    createReadStream(filePath)
        .on("error", () => jsonResponse(res, 404, { error: "Not found." }))
        .pipe(res);
}

async function renderIndexHtml(entry) {
    const indexPath = join(webviewRuntimeDir, "index.html");
    let html = await readFile(indexPath, "utf8");
    const config = {
        title: entry.title,
        displayPath: entry.displayPath,
        assetPath: "/assets/",
        apiToken: entry.apiToken,
    };
    const script = `<script>window.EXCALIDRAW_ASSET_PATH="/assets/";window.EXCALIDRAW_WORKBENCH_CONFIG=${JSON.stringify(config).replace(/</g, "\\u003c")};</script>`;
    html = html.replace("</head>", `${script}</head>`);
    return html.replace(/<title>.*?<\/title>/i, `<title>${htmlEscape(entry.title)}</title>`);
}

function resolveStaticPath(pathname) {
    const rawPath = decodeURIComponent(pathname).replace(/^\/+/, "");
    const requestedPath = resolve(webviewRuntimeDir, rawPath);
    const relativePath = relative(webviewRuntimeDir, requestedPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        return null;
    }

    return requestedPath;
}
