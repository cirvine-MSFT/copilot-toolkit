import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { normalizeImportedScene } from "./scene-normalize.mjs";

export const canvasInputSchema = {
    type: "object",
    properties: {
        filePath: {
            type: "string",
            description: "Repository-relative or absolute path to a .excalidraw or .excalidraw.json file under the active workspace.",
        },
        title: {
            type: "string",
            description: "Optional title to show in the canvas chrome.",
        },
    },
    required: ["filePath"],
    additionalProperties: false,
};

export const commentIdSchema = {
    type: "object",
    properties: {
        commentId: { type: "string" },
    },
    required: ["commentId"],
    additionalProperties: false,
};

export const replyToCommentSchema = {
    type: "object",
    properties: {
        commentId: { type: "string" },
        body: { type: "string" },
    },
    required: ["commentId", "body"],
    additionalProperties: false,
};

export const applyElementPatchSchema = {
    type: "object",
    properties: {
        elementId: { type: "string" },
        patch: {
            type: "object",
            properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                text: { type: "string" },
                strokeColor: { type: "string" },
                backgroundColor: { type: "string" },
            },
            additionalProperties: false,
        },
    },
    required: ["elementId", "patch"],
    additionalProperties: false,
};

export const saveSourceSchema = {
    type: "object",
    properties: {
        source: { type: "string" },
        baseRevision: {
            type: "string",
            description: "Revision returned by get_loaded_file. Required to avoid overwriting newer drawing changes.",
        },
    },
    required: ["source", "baseRevision"],
    additionalProperties: false,
};

export const captureSnapshotSchema = {
    type: "object",
    properties: {
        format: {
            type: "string",
            enum: ["svg", "png"],
            description: "Snapshot image format. PNG requires a live webview; SVG is always available.",
        },
        liveOnly: {
            type: "boolean",
            description: "When true, fail instead of using the host-side SVG fallback if no live webview responds.",
        },
    },
    additionalProperties: false,
};

export function htmlEscape(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function jsonResponse(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
}

export async function readRequestJson(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }

    const body = Buffer.concat(chunks).toString("utf8");
    return body.trim() === "" ? {} : JSON.parse(body);
}

export async function ensureFileExists(filePath) {
    await access(filePath, constants.R_OK | constants.W_OK);
}

export function isSupportedDrawingPath(filePath) {
    const lower = filePath.toLowerCase();
    return lower.endsWith(".excalidraw") || lower.endsWith(".excalidraw.json");
}

export function resolveWorkspacePath(workspaceRoot, filePath) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
        throw new Error("filePath is required.");
    }

    const root = resolve(workspaceRoot);
    const requestedPath = isAbsolute(filePath)
        ? resolve(filePath)
        : resolve(root, filePath);
    const relativePath = relative(root, requestedPath);

    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error(`Refusing to access a file outside the workspace: ${filePath}`);
    }

    if (!isSupportedDrawingPath(requestedPath)) {
        throw new Error(`Expected a .excalidraw or .excalidraw.json file: ${filePath}`);
    }

    return requestedPath;
}

export function displayPathFor(workspaceRoot, filePath) {
    const relativePath = relative(resolve(workspaceRoot), resolve(filePath));
    return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}

export function commentSidecarPath(filePath) {
    return `${filePath}.comments.json`;
}

export async function readJsonFile(filePath) {
    return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJsonFile(filePath, value) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function normalizeDiagram(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Excalidraw scene must be a JSON object.");
    }

    if (!Array.isArray(value.elements)) {
        throw new Error("Excalidraw scene must contain an elements array.");
    }

    const normalized = normalizeImportedScene(value);
    return {
        type: value.type ?? "excalidraw",
        version: value.version ?? 2,
        source: value.source ?? "https://github.com/cirvine-msft/copilot-toolkit",
        elements: normalized.elements,
        appState: value.appState ?? {},
        files: value.files ?? {},
    };
}

export async function loadDiagram(filePath) {
    return normalizeDiagram(await readJsonFile(filePath));
}

export async function saveDiagram(filePath, diagram) {
    await writeJsonFile(filePath, normalizeDiagram(diagram));
}

export function emptyCommentState() {
    return {
        type: "excalidraw-workbench-comments",
        version: 1,
        comments: [],
    };
}

export async function loadCommentState(filePath) {
    const sidecarPath = commentSidecarPath(filePath);
    try {
        const state = await readJsonFile(sidecarPath);
        if (!state || !Array.isArray(state.comments)) {
            throw new Error(`Invalid comment sidecar: ${sidecarPath}`);
        }

        return {
            type: state.type ?? "excalidraw-workbench-comments",
            version: Number(state.version) || 1,
            comments: state.comments.map(normalizeComment),
        };
    } catch (error) {
        if (error?.code === "ENOENT") {
            return emptyCommentState();
        }

        throw error;
    }
}

export async function saveCommentState(filePath, state) {
    await writeJsonFile(commentSidecarPath(filePath), {
        type: "excalidraw-workbench-comments",
        version: 1,
        comments: Array.isArray(state.comments) ? state.comments.map(normalizeComment) : [],
    });
}

export function normalizeComment(comment) {
    return {
        id: String(comment.id ?? createId("comment")),
        body: String(comment.body ?? ""),
        x: Number(comment.x) || 0,
        y: Number(comment.y) || 0,
        elementId: optionalString(comment.elementId),
        elementType: optionalString(comment.elementType),
        elementLabel: optionalString(comment.elementLabel),
        resolved: Boolean(comment.resolved),
        createdAt: optionalString(comment.createdAt) ?? new Date().toISOString(),
        replies: Array.isArray(comment.replies) ? comment.replies.map(normalizeReply) : [],
    };
}

export function normalizeReply(reply) {
    return {
        id: String(reply.id ?? createId("reply")),
        body: String(reply.body ?? ""),
        author: optionalString(reply.author) ?? "agent",
        createdAt: optionalString(reply.createdAt) ?? new Date().toISOString(),
    };
}

export function optionalString(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const text = String(value).trim();
    return text.length > 0 ? text : null;
}

export function createId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createComment(input) {
    const body = String(input.body ?? "").trim();
    if (!body) {
        throw new Error("Comment body is required.");
    }

    return normalizeComment({
        id: createId("comment"),
        body,
        x: Number(input.x) || 0,
        y: Number(input.y) || 0,
        elementId: optionalString(input.elementId),
        elementType: optionalString(input.elementType),
        elementLabel: optionalString(input.elementLabel),
        resolved: false,
        createdAt: new Date().toISOString(),
        replies: [],
    });
}

export function findComment(state, commentId) {
    const comment = state.comments.find((item) => item.id === commentId);
    if (!comment) {
        throw new Error(`Comment not found: ${commentId}`);
    }

    return comment;
}

export function addReply(state, commentId, body, author = "agent") {
    const text = String(body ?? "").trim();
    if (!text) {
        throw new Error("Reply body is required.");
    }

    const comment = findComment(state, commentId);
    const reply = normalizeReply({
        id: createId("reply"),
        body: text,
        author,
        createdAt: new Date().toISOString(),
    });
    comment.replies.push(reply);
    return { comment, reply };
}

export function resolveComment(state, commentId) {
    const comment = findComment(state, commentId);
    comment.resolved = true;
    return comment;
}

export function listActiveComments(state) {
    return state.comments.filter((comment) => !comment.resolved);
}

export function getElementById(diagram, elementId) {
    return diagram.elements.find((element) => element.id === elementId && !element.isDeleted);
}

export function applyElementPatch(diagram, elementId, patch) {
    const element = getElementById(diagram, elementId);
    if (!element) {
        throw new Error(`Element not found: ${elementId}`);
    }

    for (const field of ["x", "y", "width", "height"]) {
        if (patch[field] !== undefined) {
            const value = Number(patch[field]);
            if (!Number.isFinite(value)) {
                throw new Error(`${field} must be a finite number.`);
            }
            element[field] = value;
        }
    }

    for (const field of ["strokeColor", "backgroundColor"]) {
        if (patch[field] !== undefined) {
            element[field] = String(patch[field]);
        }
    }

    if (patch.text !== undefined) {
        if (element.type !== "text") {
            throw new Error("Only text elements can receive a text patch.");
        }
        element.text = String(patch.text);
        element.originalText = element.text;
    }

    element.updated = Date.now();
    element.version = Number(element.version || 1) + 1;
    element.versionNonce = Math.floor(Math.random() * 2147483647);
    return element;
}

export function elementBounds(element) {
    const points = Array.isArray(element.points) ? element.points : null;
    if (points && points.length > 0) {
        const xs = points.map((point) => Number(point[0]) || 0);
        const ys = points.map((point) => Number(point[1]) || 0);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);
        return {
            x: Number(element.x) + minX,
            y: Number(element.y) + minY,
            width: Math.max(1, maxX - minX),
            height: Math.max(1, maxY - minY),
        };
    }

    return {
        x: Number(element.x) || 0,
        y: Number(element.y) || 0,
        width: Math.max(1, Number(element.width) || 1),
        height: Math.max(1, Number(element.height) || 1),
    };
}

export function diagramBounds(elements) {
    const visibleElements = elements.filter((element) => !element.isDeleted);
    if (visibleElements.length === 0) {
        return { x: 0, y: 0, width: 1200, height: 800 };
    }

    const bounds = visibleElements.map(elementBounds);
    const minX = Math.min(...bounds.map((bound) => bound.x));
    const minY = Math.min(...bounds.map((bound) => bound.y));
    const maxX = Math.max(...bounds.map((bound) => bound.x + bound.width));
    const maxY = Math.max(...bounds.map((bound) => bound.y + bound.height));
    const padding = 80;

    return {
        x: minX - padding,
        y: minY - padding,
        width: Math.max(1, maxX - minX + padding * 2),
        height: Math.max(1, maxY - minY + padding * 2),
    };
}

function transformFor(element) {
    const angle = Number(element.angle) || 0;
    if (angle === 0) {
        return "";
    }

    const x = Number(element.x) || 0;
    const y = Number(element.y) || 0;
    const width = Number(element.width) || 0;
    const height = Number(element.height) || 0;
    return ` transform="rotate(${angle * 180 / Math.PI} ${x + width / 2} ${y + height / 2})"`;
}

function strokeWidthFor(element) {
    return Math.max(1, Number(element.strokeWidth) || 1);
}

function strokeFor(element) {
    return htmlEscape(element.strokeColor || "#1e1e1e");
}

function fillFor(element) {
    const fill = element.backgroundColor || "transparent";
    return fill === "transparent" ? "none" : htmlEscape(fill);
}

function opacityFor(element) {
    const opacity = Number(element.opacity);
    return Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity / 100)) : 1;
}

function shortText(value, maxLength = 80) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function elementLabel(element) {
    if (element.type === "text" && element.text) {
        return shortText(element.text);
    }

    return `${element.type} ${String(element.id || "").slice(0, 8)}`;
}

function renderRectangle(element) {
    const roundness = element.roundness ? 12 : 0;
    return `<rect x="${Number(element.x) || 0}" y="${Number(element.y) || 0}" width="${Math.max(1, Number(element.width) || 1)}" height="${Math.max(1, Number(element.height) || 1)}" rx="${roundness}" ry="${roundness}" fill="${fillFor(element)}" stroke="${strokeFor(element)}" stroke-width="${strokeWidthFor(element)}" opacity="${opacityFor(element)}"${transformFor(element)} />`;
}

function renderEllipse(element) {
    const cx = Number(element.x) + Number(element.width) / 2;
    const cy = Number(element.y) + Number(element.height) / 2;
    return `<ellipse cx="${cx}" cy="${cy}" rx="${Math.max(1, Number(element.width) / 2 || 1)}" ry="${Math.max(1, Number(element.height) / 2 || 1)}" fill="${fillFor(element)}" stroke="${strokeFor(element)}" stroke-width="${strokeWidthFor(element)}" opacity="${opacityFor(element)}"${transformFor(element)} />`;
}

function renderDiamond(element) {
    const x = Number(element.x);
    const y = Number(element.y);
    const width = Number(element.width);
    const height = Number(element.height);
    const points = [
        `${x + width / 2},${y}`,
        `${x + width},${y + height / 2}`,
        `${x + width / 2},${y + height}`,
        `${x},${y + height / 2}`,
    ].join(" ");
    return `<polygon points="${points}" fill="${fillFor(element)}" stroke="${strokeFor(element)}" stroke-width="${strokeWidthFor(element)}" opacity="${opacityFor(element)}"${transformFor(element)} />`;
}

function renderLinearElement(element) {
    const points = Array.isArray(element.points) ? element.points : [[0, 0], [Number(element.width) || 0, Number(element.height) || 0]];
    const coordinates = points
        .map((point) => `${Number(element.x) + (Number(point[0]) || 0)},${Number(element.y) + (Number(point[1]) || 0)}`)
        .join(" ");
    const markerEnd = element.type === "arrow" ? ' marker-end="url(#arrowhead)"' : "";
    return `<polyline points="${coordinates}" fill="none" stroke="${strokeFor(element)}" stroke-width="${strokeWidthFor(element)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacityFor(element)}"${markerEnd}${transformFor(element)} />`;
}

function renderText(element) {
    const fontSize = Number(element.fontSize) || 16;
    const lineHeight = fontSize * 1.25;
    const lines = String(element.text ?? "").split("\n");
    const textAnchor = element.textAlign === "center" ? "middle" : element.textAlign === "right" ? "end" : "start";
    const x = Number(element.x) + (textAnchor === "middle" ? Number(element.width || 0) / 2 : textAnchor === "end" ? Number(element.width || 0) : 0);
    const y = Number(element.y) + fontSize;
    const family = element.fontFamily === 3 ? "Cascadia Mono, Consolas, monospace" : "Segoe UI, Arial, sans-serif";
    const tspans = lines
        .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${htmlEscape(line)}</tspan>`)
        .join("");

    return `<text font-family="${family}" font-size="${fontSize}" fill="${strokeFor(element)}" text-anchor="${textAnchor}" opacity="${opacityFor(element)}"${transformFor(element)} x="${x}" y="${y}">${tspans}</text>`;
}

function renderUnsupported(element) {
    const bound = elementBounds(element);
    return `<g opacity="0.55"><rect x="${bound.x}" y="${bound.y}" width="${bound.width}" height="${bound.height}" fill="#f6f8fa" stroke="#8c959f" stroke-dasharray="6 4" /><text x="${bound.x + 8}" y="${bound.y + 22}" font-family="Segoe UI, Arial, sans-serif" font-size="14" fill="#57606a">Unsupported: ${htmlEscape(element.type)}</text></g>`;
}

function renderElementShape(element) {
    switch (element.type) {
        case "rectangle":
            return renderRectangle(element);
        case "ellipse":
            return renderEllipse(element);
        case "diamond":
            return renderDiamond(element);
        case "arrow":
        case "line":
            return renderLinearElement(element);
        case "text":
            return renderText(element);
        default:
            return renderUnsupported(element);
    }
}

function renderCommentMarkers(comments) {
    return comments
        .filter((comment) => !comment.resolved)
        .map((comment, index) => {
            const x = Number(comment.x) || 0;
            const y = Number(comment.y) || 0;
            return `<g class="comment-marker" data-comment-id="${htmlEscape(comment.id)}"><circle cx="${x}" cy="${y}" r="14" fill="#fff4ce" stroke="#8a6d00" stroke-width="2" /><text x="${x}" y="${y + 5}" font-family="Segoe UI, Arial, sans-serif" font-size="13" text-anchor="middle" fill="#000000">${index + 1}</text><title>${htmlEscape(comment.body)}</title></g>`;
        })
        .join("\n");
}

export function renderSvg(diagram, comments = []) {
    const elements = Array.isArray(diagram.elements)
        ? diagram.elements.filter((element) => !element.isDeleted)
        : [];
    const bounds = diagramBounds(elements);
    const background = diagram.appState?.viewBackgroundColor || "#ffffff";
    const body = elements
        .map((element) => `<g data-element-id="${htmlEscape(element.id)}" data-element-type="${htmlEscape(element.type)}" data-element-label="${htmlEscape(elementLabel(element))}">${renderElementShape(element)}</g>`)
        .join("\n");

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" width="${bounds.width}" height="${bounds.height}" role="img" aria-label="Excalidraw diagram">
<defs>
  <marker id="arrowhead" markerWidth="12" markerHeight="8" refX="10" refY="4" orient="auto" markerUnits="strokeWidth">
    <path d="M0,0 L10,4 L0,8 Z" fill="#1e1e1e" />
  </marker>
</defs>
<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="${htmlEscape(background)}" />
${body}
${renderCommentMarkers(comments)}
</svg>`;
}

export function snapshotDirectory(sessionWorkspacePath, workspaceRoot) {
    if (sessionWorkspacePath) {
        return join(sessionWorkspacePath, "files", "excalidraw-workbench", "snapshots");
    }

    return join(workspaceRoot, ".copilot", "excalidraw-workbench", "snapshots");
}

export async function writeSnapshotArtifact({ sessionWorkspacePath, workspaceRoot, sourceFilePath, format, content }) {
    const requestedFormat = format === "png" ? "png" : "svg";
    const directory = snapshotDirectory(sessionWorkspacePath, workspaceRoot);
    await mkdir(directory, { recursive: true });
    const safeBase = basename(sourceFilePath, extname(sourceFilePath)).replace(/[^A-Za-z0-9._-]+/g, "-");
    const snapshotPath = join(directory, `${safeBase}-${Date.now().toString(36)}.${requestedFormat}`);
    const buffer = requestedFormat === "png" && typeof content === "string" && content.startsWith("data:image/png;base64,")
        ? Buffer.from(content.slice("data:image/png;base64,".length), "base64")
        : Buffer.from(String(content), "utf8");
    await writeFile(snapshotPath, buffer);
    return snapshotPath;
}
