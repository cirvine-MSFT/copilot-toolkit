import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import {
    createEventId,
    createServerId,
    ensureStateDirs,
    findFreePort,
    formatError,
    getDiffOutput,
    getServerStatePath,
    isProcessAlive,
    listJsonFilePaths,
    nowIso,
    openBrowser,
    readJsonFile,
    writeJsonAtomic,
} from "./common.mjs";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const workerFilePath = join(extensionDir, "server-worker.mjs");
const eventScanIntervalMs = 5000;
const idleEventDeliveryDelayMs = 50;
const deliveryOwnerId = String(process.pid);

let currentSessionId = null;
let eventScanTimer = null;
let eventDeliveryInFlight = false;
let activeServerId = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function success(textResultForLlm) {
    return { resultType: "success", textResultForLlm };
}

function failure(textResultForLlm) {
    return { resultType: "failure", textResultForLlm };
}

function safeReadJsonSync(filePath) {
    try {
        return JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const session = await joinSession({
    hooks: {
        onSessionStart: async (_input, invocation) => {
            currentSessionId = invocation.sessionId;
            ensureStateDirs();
            ensureEventMonitor();

            setTimeout(() => {
                deliverPendingEvents(invocation.sessionId).catch(async (error) => {
                    await session.log(`visual-review event delivery failed: ${formatError(error)}`, {
                        level: "warning",
                        ephemeral: true,
                    });
                });
            }, 250);

            await session.log("visual-review ready: launch a browser-based diff viewer with inline commenting.", {
                ephemeral: true,
            });
        },
    },
    tools: [
        // ------------------------------------------------------------------
        // visual_review_start
        // ------------------------------------------------------------------
        {
            name: "visual_review_start",
            description:
                "Launch a browser-based diff viewer with inline commenting that connects back to this CLI session via WebSocket.",
            parameters: {
                type: "object",
                properties: {
                    scope: {
                        type: "string",
                        description:
                            'What diff to show. "branch" compares current branch to base, "staged" shows staged changes, "unstaged" shows working-tree changes.',
                        enum: ["branch", "staged", "unstaged"],
                        default: "branch",
                    },
                    base: {
                        type: "string",
                        description: 'Base branch for "branch" scope. Defaults to "main".',
                        default: "main",
                    },
                    port: {
                        type: "integer",
                        description: "Port for the local server. 0 means auto-select a free port.",
                        default: 0,
                        minimum: 0,
                        maximum: 65535,
                    },
                    theme: {
                        type: "string",
                        description: "Color theme for the diff viewer.",
                        enum: ["dark", "light", "auto"],
                        default: "dark",
                    },
                },
            },
            handler: async (args, invocation) => {
                try {
                    currentSessionId = invocation.sessionId;
                    const cwd = process.cwd();
                    const scope = args?.scope ?? "branch";
                    const base = args?.base ?? "main";
                    const requestedPort = Number(args?.port ?? 0);
                    const theme = args?.theme ?? "dark";

                    // Stop an existing server if one is active
                    if (activeServerId) {
                        const existingPath = getServerStatePath(activeServerId);
                        const existing = await readJsonFile(existingPath);
                        if (existing && existing.status === "active") {
                            existing.stopRequested = true;
                            existing.updatedAt = nowIso();
                            await writeJsonAtomic(existingPath, existing);
                        }

                        activeServerId = null;
                    }

                    // Get the diff to verify there's something to show
                    const diff = await getDiffOutput(cwd, scope, base);
                    if (!diff || !diff.trim()) {
                        return failure(
                            `No differences found for scope "${scope}"${scope === "branch" ? ` (base: ${base})` : ""}. Nothing to review.`,
                        );
                    }

                    // Find a free port
                    const port = await findFreePort(requestedPort);
                    const url = `http://127.0.0.1:${port}`;

                    // Prepare server state
                    const serverId = createServerId();
                    const serverStatePath = getServerStatePath(serverId);
                    const createdAt = nowIso();

                    const serverState = {
                        schemaVersion: 1,
                        serverId,
                        sessionId: invocation.sessionId,
                        createdAt,
                        updatedAt: createdAt,
                        status: "active",
                        stopRequested: false,
                        port,
                        cwd,
                        theme,
                        scope,
                        base,
                        url,
                        worker: {
                            pid: null,
                            startedAt: null,
                        },
                        connectedClients: 0,
                    };

                    await writeJsonAtomic(serverStatePath, serverState);

                    // Spawn the server worker as a detached process
                    const child = spawn(
                        process.execPath,
                        [workerFilePath, serverStatePath],
                        {
                            cwd,
                            detached: true,
                            stdio: "ignore",
                            windowsHide: true,
                        },
                    );
                    child.unref();

                    serverState.worker = {
                        pid: child.pid ?? null,
                        startedAt: nowIso(),
                    };
                    serverState.updatedAt = nowIso();
                    await writeJsonAtomic(serverStatePath, serverState);

                    activeServerId = serverId;

                    // Open the browser after a brief delay for server startup
                    setTimeout(() => openBrowser(url), 500);

                    ensureEventMonitor();

                    return success(
                        [
                            `Visual review server started: ${url}`,
                            `Server ID: ${serverId} | Scope: ${scope}${scope === "branch" ? ` (base: ${base})` : ""} | Theme: ${theme}`,
                            `The browser should open automatically. Use visual_review_stop to shut it down.`,
                        ].join("\n"),
                    );
                } catch (error) {
                    return failure(`Failed to start visual review: ${formatError(error)}`);
                }
            },
        },

        // ------------------------------------------------------------------
        // visual_review_stop
        // ------------------------------------------------------------------
        {
            name: "visual_review_stop",
            description: "Stop the active visual review server.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async (_args, invocation) => {
                try {
                    currentSessionId = invocation.sessionId;

                    if (!activeServerId) {
                        return failure("No active visual review server to stop.");
                    }

                    const serverStatePath = getServerStatePath(activeServerId);
                    const serverState = await readJsonFile(serverStatePath);

                    if (!serverState) {
                        activeServerId = null;
                        return failure("Server state file not found. The server may have already stopped.");
                    }

                    serverState.stopRequested = true;
                    serverState.status = "stopping";
                    serverState.updatedAt = nowIso();
                    await writeJsonAtomic(serverStatePath, serverState);

                    const stoppedId = activeServerId;
                    activeServerId = null;

                    if (eventScanTimer) {
                        clearInterval(eventScanTimer);
                        eventScanTimer = null;
                    }

                    return success(`Stop requested for visual review server ${stoppedId}. It will shut down shortly.`);
                } catch (error) {
                    return failure(`Failed to stop visual review: ${formatError(error)}`);
                }
            },
        },

        // ------------------------------------------------------------------
        // visual_review_status
        // ------------------------------------------------------------------
        {
            name: "visual_review_status",
            description: "Check the status of the visual review server.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async (_args, invocation) => {
                try {
                    currentSessionId = invocation.sessionId;

                    const { serversDir, eventsDir } = ensureStateDirs();
                    const serverPaths = listJsonFilePaths(serversDir);
                    const eventPaths = listJsonFilePaths(eventsDir);

                    const servers = [];
                    for (const filePath of serverPaths) {
                        const state = await readJsonFile(filePath);
                        if (state) {
                            servers.push(state);
                        }
                    }

                    const pendingEvents = [];
                    for (const filePath of eventPaths) {
                        const event = await readJsonFile(filePath);
                        if (event && !isEventDelivered(event, currentSessionId)) {
                            pendingEvents.push(event);
                        }
                    }

                    if (servers.length === 0) {
                        return "No visual review servers found. Use visual_review_start to launch one.";
                    }

                    const lines = ["Visual review servers:"];
                    for (const server of servers) {
                        const workerPid = server.worker?.pid;
                        const alive = workerPid ? isProcessAlive(workerPid) : false;
                        const workerStatus = workerPid
                            ? `pid ${workerPid} (${alive ? "running" : "missing"})`
                            : "not started";

                        lines.push(
                            [
                                `- ${server.serverId} [${server.status}]`,
                                `  url: ${server.url}`,
                                `  scope: ${server.scope}${server.scope === "branch" ? ` (base: ${server.base})` : ""}`,
                                `  theme: ${server.theme}`,
                                `  clients: ${server.connectedClients ?? 0}`,
                                `  worker: ${workerStatus}`,
                                `  created: ${server.createdAt}`,
                            ].join("\n"),
                        );
                    }

                    if (pendingEvents.length > 0) {
                        lines.push("");
                        lines.push(`Pending review comments: ${pendingEvents.length}`);
                        for (const event of pendingEvents) {
                            lines.push(
                                `- ${event.eventId} [${event.kind}] ${event.filePath}:${event.lineNumber} "${truncate(event.commentText, 60)}"`,
                            );
                        }
                    }

                    return lines.join("\n");
                } catch (error) {
                    return failure(`Failed to get visual review status: ${formatError(error)}`);
                }
            },
        },

        // ------------------------------------------------------------------
        // visual_review_send_visualization
        // ------------------------------------------------------------------
        {
            name: "visual_review_send_visualization",
            description: "Push a Mermaid diagram to the visual review browser UI for display alongside the diff.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "Title for the visualization.",
                    },
                    mermaid: {
                        type: "string",
                        description: "Mermaid diagram code.",
                    },
                    description: {
                        type: "string",
                        description: "Optional markdown description to display with the diagram.",
                    },
                },
                required: ["title", "mermaid"],
            },
            handler: async (args, invocation) => {
                try {
                    currentSessionId = invocation.sessionId;

                    if (!activeServerId) {
                        return failure("No active visual review server. Start one with visual_review_start first.");
                    }

                    const { vizDir } = ensureStateDirs();
                    const eventId = createEventId();
                    const eventPath = join(vizDir, `${activeServerId}-${eventId}.json`);

                    const visualizationEvent = {
                        eventId,
                        serverId: activeServerId,
                        kind: "visualization:push",
                        createdAt: nowIso(),
                        title: args.title,
                        mermaid: args.mermaid,
                        description: args.description ?? null,
                        deliveredSessionIds: [],
                    };

                    await writeJsonAtomic(eventPath, visualizationEvent);

                    return success(
                        `Visualization "${args.title}" queued for delivery to the browser UI (event: ${eventId}).`,
                    );
                } catch (error) {
                    return failure(`Failed to send visualization: ${formatError(error)}`);
                }
            },
        },
    ],
});

// ---------------------------------------------------------------------------
// Session lifecycle events
// ---------------------------------------------------------------------------

session.on("session.idle", () => {
    if (!currentSessionId) {
        return;
    }

    setTimeout(() => {
        deliverPendingEvents(currentSessionId).catch(async (error) => {
            await session.log(`visual-review idle delivery failed: ${formatError(error)}`, {
                level: "warning",
                ephemeral: true,
            });
        });
    }, idleEventDeliveryDelayMs);
});

session.on("session.shutdown", () => {
    currentSessionId = null;
    if (eventScanTimer) {
        clearInterval(eventScanTimer);
        eventScanTimer = null;
    }
});

// ---------------------------------------------------------------------------
// Event monitoring and delivery
// ---------------------------------------------------------------------------

function ensureEventMonitor() {
    if (eventScanTimer) {
        return;
    }

    eventScanTimer = setInterval(() => {
        if (!currentSessionId) {
            return;
        }

        deliverPendingEvents(currentSessionId).catch(async (error) => {
            await session.log(`visual-review event scan failed: ${formatError(error)}`, {
                level: "warning",
                ephemeral: true,
            });
        });
    }, eventScanIntervalMs);
}

function isEventDelivered(event, sessionId) {
    return (
        Array.isArray(event.deliveredSessionIds) &&
        sessionId &&
        event.deliveredSessionIds.includes(sessionId)
    );
}

async function deliverPendingEvents(sessionId) {
    if (!sessionId || eventDeliveryInFlight) {
        return;
    }

    eventDeliveryInFlight = true;

    try {
        const { eventsDir } = ensureStateDirs();
        const eventPaths = listJsonFilePaths(eventsDir);

        for (const eventPath of eventPaths) {
            const event = await readJsonFile(eventPath);
            if (!event) {
                continue;
            }

            // Only deliver comment events as follow-up prompts
            if (!event.kind || !event.kind.startsWith("comment:")) {
                continue;
            }

            const deliveredSessionIds = Array.isArray(event.deliveredSessionIds)
                ? event.deliveredSessionIds
                : [];

            if (deliveredSessionIds.includes(sessionId)) {
                continue;
            }

            // Claim this event for delivery
            event.inFlightDelivery = {
                owner: deliveryOwnerId,
                sessionId,
                startedAt: nowIso(),
            };
            await writeJsonAtomic(eventPath, event);

            try {
                await session.log(
                    `visual-review: new comment on ${event.filePath}:${event.lineNumber} — delivering to session.`,
                    { level: "info" },
                );

                await session.send({
                    prompt: buildCommentPrompt(event),
                    mode: "enqueue",
                });

                event.deliveredSessionIds = [...new Set([...deliveredSessionIds, sessionId])];
                event.deliveredAt = nowIso();
                delete event.inFlightDelivery;
                await writeJsonAtomic(eventPath, event);
            } catch (error) {
                if (event.inFlightDelivery?.owner === deliveryOwnerId) {
                    delete event.inFlightDelivery;
                }
                event.lastError = formatError(error);
                await writeJsonAtomic(eventPath, event);
                throw error;
            }
        }
    } finally {
        eventDeliveryInFlight = false;
    }
}

function buildCommentPrompt(event) {
    const sections = [
        "A reviewer left a comment on your code changes in the visual review:",
        `File: ${event.filePath}, Line: ${event.lineNumber}`,
        `Comment: ${event.commentText}`,
        "",
        "Read the comment, understand the context, and respond appropriately. If the comment suggests a code change, implement it. Then reply to the comment using visual_review_status or by pushing an update.",
    ];

    return sections.join("\n");
}

function truncate(text, maxLength) {
    if (!text || text.length <= maxLength) {
        return text ?? "";
    }

    return `${text.slice(0, maxLength - 3)}...`;
}
