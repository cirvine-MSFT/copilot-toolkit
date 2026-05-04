import { joinSession } from "@github/copilot-sdk/extension";
import { join } from "node:path";
import { CopilotWebview } from "./lib/copilot-webview.js";
import { CommentStore } from "./comment-store.mjs";
import { VizStore } from "./viz-store.mjs";
import { getDiffOutput, formatError, nowIso } from "./common.mjs";

const extensionDir = import.meta.dirname;
let currentConfig = { scope: "branch", base: "main", theme: "dark" };
let commentStore = null;
let vizStore = null;
let currentSessionId = null;

function initStores(sessionId) {
    if (sessionId) currentSessionId = sessionId;
    if (!commentStore && currentSessionId) {
        commentStore = new CommentStore(currentSessionId);
        commentStore.load();
    }
    if (!vizStore && currentSessionId) {
        vizStore = new VizStore(currentSessionId);
        vizStore.load();
    }
    return { commentStore, vizStore };
}

function parseDiffFiles(diffText) {
    const files = [];
    const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
    let m;
    while ((m = re.exec(diffText)) !== null) {
        files.push({ from: m[1], to: m[2] });
    }
    return files;
}

function buildCommentPrompt(event) {
    return [
        "A reviewer left a comment on your code changes in the visual review:",
        `File: ${event.filePath}, Line: ${event.lineNumber}`,
        `Comment: ${event.commentText}`,
        `Thread ID: ${event.threadId}`,
        "",
        "Read the comment, understand the context, and respond appropriately. If the comment suggests a code change, implement it. Reply to the comment using the visual_review_reply tool with the thread ID above.",
    ].join("\n");
}

const webview = new CopilotWebview({
    extensionName: "visual_review",
    contentDir: join(extensionDir, "content"),
    title: "Visual Review — Copilot CLI",
    width: 1200,
    height: 800,
    callbacks: {
        getConfig: () => currentConfig,

        getDiff: async (scope) => {
            const s = scope || currentConfig.scope;
            try {
                const diff = await getDiffOutput(process.cwd(), s, currentConfig.base);
                const files = parseDiffFiles(diff);
                return { diff, files, scope: s, base: currentConfig.base };
            } catch (error) {
                return { diff: "", files: [], scope: s, base: currentConfig.base, error: formatError(error) };
            }
        },

        addComment: async (filePath, line, endLine, side, text) => {
            const { commentStore: store } = initStores();
            const threadId = store.addThread(filePath, line, side, text, endLine);
            session.send({
                prompt: buildCommentPrompt({ filePath, lineNumber: line, commentText: text, threadId }),
                mode: "enqueue",
            }).catch(() => {});
            return { threadId, threads: store.getThreads() };
        },

        addReply: (threadId, text) => {
            const { commentStore: store } = initStores();
            store.addReply(threadId, "user", text);
            return { threads: store.getThreads() };
        },

        resolveThread: (threadId) => {
            const { commentStore: store } = initStores();
            store.resolveThread(threadId);
            return { threads: store.getThreads() };
        },

        getComments: () => {
            const { commentStore: store } = initStores();
            return store.getThreads();
        },

        submitBatch: async (comments) => {
            const { commentStore: store } = initStores();
            for (const c of comments) {
                const threadId = store.addThread(c.filePath, c.line, c.side ?? "right", c.body ?? c.text, c.endLine);
                session.send({
                    prompt: buildCommentPrompt({ filePath: c.filePath, lineNumber: c.line, commentText: c.body ?? c.text, threadId }),
                    mode: "enqueue",
                }).catch(() => {});
            }
            return { threads: store.getThreads() };
        },

        getVisualizations: () => {
            const { vizStore: vs } = initStores();
            return vs ? vs.getAll() : [];
        },
    },
});

const customTools = [
    {
        name: "visual_review_start",
        description: "Launch a browser-based diff viewer with inline commenting that connects back to this CLI session via WebSocket.",
        parameters: {
            type: "object",
            properties: {
                scope: {
                    type: "string",
                    description: 'What diff to show. "branch" compares current branch to base, "staged" shows staged changes, "unstaged" shows working-tree changes.',
                    enum: ["branch", "staged", "unstaged"],
                    default: "branch",
                },
                base: {
                    type: "string",
                    description: 'Base branch for "branch" scope. Defaults to "main".',
                    default: "main",
                },
                theme: {
                    type: "string",
                    description: "Color theme for the diff viewer.",
                    enum: ["dark", "light", "auto"],
                    default: "dark",
                },
            },
        },
        handler: async (args) => {
            currentConfig = {
                scope: args?.scope ?? "branch",
                base: args?.base ?? "main",
                theme: args?.theme ?? "dark",
            };
            initStores();
            const wasOpen = !!webview._handle;
            await webview.show({ reload: wasOpen });
            const scope = currentConfig.scope;

            // Non-blocking: ask agent to generate diagrams if none exist yet
            if (vizStore && vizStore.getAll().length === 0) {
                session.send({
                    prompt: [
                        "The visual review window just opened. Generate 1-2 Mermaid diagrams that illustrate the key architectural changes in this branch's diff.",
                        "Use the visual_review_send_visualization tool for each diagram. Good candidates: component/module relationships (graph), request/data flows (sequence), or before→after architecture.",
                        "Keep diagrams concise and focused on what changed. Do NOT ask for confirmation — just generate them.",
                    ].join("\n"),
                    mode: "enqueue",
                }).catch(() => {});
            }

            return [
                "Visual review window opened.",
                `Scope: ${scope}${scope === "branch" ? ` (base: ${currentConfig.base})` : ""} | Theme: ${currentConfig.theme}`,
            ].join("\n");
        },
    },
    {
        name: "visual_review_stop",
        description: "Stop the active visual review server.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
            webview.close();
            return "Visual review window closed.";
        },
    },
    {
        name: "visual_review_status",
        description: "Check the status of the visual review server.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
            const isOpen = !!webview._handle;
            const { commentStore: cs, vizStore: vs } = initStores();
            const threads = cs ? cs.getThreads() : [];
            const active = threads.filter((t) => t.status === "active").length;
            const resolved = threads.filter((t) => t.status === "resolved").length;
            const vizCount = vs ? vs.getAll().length : 0;
            if (!isOpen) {
                return "No active visual review window. Use visual_review_start to launch one.";
            }
            return [
                "Visual review window is open.",
                `Scope: ${currentConfig.scope}${currentConfig.scope === "branch" ? ` (base: ${currentConfig.base})` : ""} | Theme: ${currentConfig.theme}`,
                `Comments: ${active} active, ${resolved} resolved`,
                `Visualizations: ${vizCount}`,
            ].join("\n");
        },
    },
    {
        name: "visual_review_send_visualization",
        description: "Push a Mermaid diagram to the visual review browser UI for display alongside the diff.",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "Title for the visualization." },
                mermaid: { type: "string", description: "Mermaid diagram code." },
                description: { type: "string", description: "Optional markdown description to display with the diagram." },
            },
            required: ["title", "mermaid"],
        },
        handler: async (args) => {
            const viz = {
                title: args.title,
                mermaid: args.mermaid,
                description: args.description ?? null,
            };
            const { vizStore: vs } = initStores();
            if (vs) vs.add(viz);
            try {
                await webview.eval(`window.addVisualization(${JSON.stringify(viz)})`);
            } catch {
                // Window not open or not connected — viz stored for hydration
            }
            return `Visualization "${args.title}" sent to the visual review window.`;
        },
    },
    {
        name: "visual_review_reply",
        description: "Reply to a review comment in the visual review browser UI. The reply appears inline in the comment thread.",
        parameters: {
            type: "object",
            properties: {
                threadId: { type: "string", description: "The thread ID of the comment to reply to." },
                text: { type: "string", description: "The reply text." },
            },
            required: ["threadId", "text"],
        },
        handler: async (args) => {
            if (!args.threadId || !args.text) {
                return "Both threadId and text are required.";
            }
            const { commentStore: store } = initStores();
            const commentId = store.addReply(args.threadId, "Copilot", args.text);
            if (!commentId) {
                return `Thread ${args.threadId} not found.`;
            }
            try {
                await webview.eval(`window.addAgentReply(${JSON.stringify(args.threadId)}, ${JSON.stringify(args.text)})`);
            } catch {
                // Window not open — reply stored in comment store for hydration
            }
            return `Reply sent to thread ${args.threadId} in the visual review browser.`;
        },
    },
];

const session = await joinSession({
    tools: [...customTools, ...webview.tools],
    commands: [{
        name: "visual-review",
        description: "Open the visual review window for code diff viewing and commenting.",
        handler: async () => {
            initStores();
            await webview.show();
        },
    }],
    hooks: {
        onSessionStart: (_input, invocation) => {
            initStores(invocation.sessionId);
        },
        onSessionEnd: webview.close,
    },
});
