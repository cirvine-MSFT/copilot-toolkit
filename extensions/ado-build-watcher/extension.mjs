import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import {
    ensureStateDirs,
    extractRunSummary,
    fetchRun,
    formatError,
    listJsonFilePaths,
    makeWatcherId,
    normalizeOptionalString,
    normalizeOrganizationUrl,
    normalizePollIntervalSeconds,
    nowIso,
    readJson,
    resolveRunReference,
    writeJson,
} from "./common.mjs";
import { markWatching, resetWatching, unmarkWatching } from "../lib/tab-indicator.mjs";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const workerPath = join(extensionDir, "watcher-worker.mjs");
const eventScanIntervalMs = 5000;
const idleEventDeliveryDelayMs = 50;
const orphanedDeliveryRetryDelayMs = 30000;
const deliveryOwnerId = String(process.pid);
const workerExecutable = process.execPath;
const defaultWatcherFollowUpPrompt = [
    "Summarize the build result.",
    "If it failed or was canceled, inspect likely failure details and diagnose the probable root cause.",
    "If you can safely continue with the next debugging or validation step in the current repo/branch, do so.",
    "If it succeeded, continue with the next obvious dependent step if one is clear.",
    "If the next step is not obvious, explain the blocker or suggest the next action.",
].join(" ");

let currentSessionId = null;
let eventScanTimer = null;
let eventDeliveryInFlight = false;

function getWorkerPid(watcher) {
    const pid = Number(watcher?.worker?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}

function describeWatcherHealth(watcher) {
    if (watcher?.status !== "active") {
        return null;
    }

    const workerPid = getWorkerPid(watcher);
    if (!workerPid) {
        return "worker pid unavailable";
    }

    return isProcessAlive(workerPid)
        ? `worker ${workerPid} running`
        : `worker ${workerPid} missing`;
}

const session = await joinSession({
    hooks: {
        onSessionStart: async (_, invocation) => {
            currentSessionId = invocation.sessionId;
            ensureStateDirs();
            ensureEventMonitor();

            setTimeout(() => {
                deliverPendingEvents(invocation.sessionId).catch(async (error) => {
                    await session.log(`build-watcher event delivery failed: ${formatError(error)}`, {
                        level: "warning",
                        ephemeral: true,
                    });
                });
            }, 250);

            await session.log("build-watcher ready: start, list, and stop Azure DevOps build watchers.", {
                ephemeral: true,
            });
        },
    },
    tools: [
        {
            name: "build_watcher_start",
            description: "Start a detached watcher for an Azure DevOps build and notify this CLI session when it reaches a terminal state.",
            parameters: {
                type: "object",
                properties: {
                    run: {
                        type: "string",
                        description: "Azure DevOps build results URL, build logs URL, or a raw run ID.",
                    },
                    organizationUrl: {
                        type: "string",
                        description: "Optional Azure DevOps organization URL. Useful when run is only a numeric ID.",
                    },
                    project: {
                        type: "string",
                        description: "Optional Azure DevOps project name. Useful when run is only a numeric ID.",
                    },
                    pollIntervalSeconds: {
                        type: "integer",
                        description: "Polling interval in seconds. Clamped to 15-300.",
                        minimum: 15,
                        maximum: 300,
                        default: 60,
                    },
                    followUpPrompt: {
                        type: "string",
                        description: "Optional instruction to send back into the session when the watched build completes or fails.",
                    },
                },
                required: ["run"],
            },
            handler: async (args, invocation) => {
                try {
                    currentSessionId = invocation.sessionId;
                    const options = normalizeStartArgs(args);
                    const requested = resolveRunReference(options);
                    const run = await fetchRun(
                        requested.runId,
                        {
                            organizationUrl: requested.organizationUrl,
                            project: requested.project,
                        },
                        process.cwd(),
                    );

                    const summary = extractRunSummary(run, {
                        organizationUrl: requested.organizationUrl,
                        project: requested.project,
                    });

                    if (!summary.organizationUrl || !summary.project) {
                        return {
                            resultType: "failure",
                            textResultForLlm:
                                "I could not resolve the Azure DevOps organization/project for that run. Please pass organizationUrl and project explicitly.",
                        };
                    }

                    if (summary.terminal) {
                        return `Run ${summary.runId} is already terminal (${summary.displayStatus}). No watcher started. ${summary.resultsUrl ?? ""}`.trim();
                    }

                    const { watchersDir } = ensureStateDirs();
                    const watcherId = makeWatcherId(summary.runId);
                    const watcherPath = join(watchersDir, `${watcherId}.json`);
                    const createdAt = nowIso();

                    const watcher = {
                        schemaVersion: 1,
                        watcherId,
                        sessionId: invocation.sessionId,
                        createdAt,
                        updatedAt: createdAt,
                        cwd: process.cwd(),
                        status: "active",
                        stopRequested: false,
                        pollIntervalSeconds: options.pollIntervalSeconds,
                        followUpPrompt: options.followUpPrompt,
                        consecutiveErrors: 0,
                        lastError: null,
                        nextPollAt: new Date(Date.now() + options.pollIntervalSeconds * 1000).toISOString(),
                        worker: {
                            pid: null,
                            startedAt: null,
                        },
                        run: summary,
                        lastObservation: summary,
                        lastObservationAt: createdAt,
                    };

                    writeJson(watcherPath, watcher);

                    const child = spawn(workerExecutable, [workerPath, watcherPath], {
                        cwd: process.cwd(),
                        detached: true,
                        stdio: "ignore",
                        windowsHide: true,
                    });
                    child.unref();

                    watcher.worker = {
                        pid: child.pid ?? null,
                        startedAt: nowIso(),
                    };
                    watcher.updatedAt = nowIso();
                    writeJson(watcherPath, watcher);

                    ensureEventMonitor();
                    markWatching(watcherId);

                    return [
                        `Started build watcher ${watcherId} for run ${summary.runId}.`,
                        `${summary.pipelineName} / ${summary.buildNumber}.`,
                        `Polling every ${options.pollIntervalSeconds}s.`,
                        `Results: ${summary.resultsUrl ?? "n/a"}.`,
                        `Use build_watcher_list to inspect it or build_watcher_stop to request a graceful stop.`,
                    ].join(" ");
                } catch (error) {
                    return {
                        resultType: "failure",
                        textResultForLlm: `Failed to start build watcher: ${formatError(error)}`,
                    };
                }
            },
        },
        {
            name: "build_watcher_list",
            description: "List active and completed Azure DevOps build watchers plus pending session events.",
            parameters: {
                type: "object",
                properties: {
                    currentSessionOnly: {
                        type: "boolean",
                        description: "Only show watchers created for the current CLI session.",
                        default: false,
                    },
                    includeCompleted: {
                        type: "boolean",
                        description: "Include non-active watchers in the output.",
                        default: true,
                    },
                    includeEvents: {
                        type: "boolean",
                        description: "Include pending watcher event files in the output.",
                        default: true,
                    },
                },
            },
            handler: async (args, invocation) => {
                try {
                    currentSessionId = invocation.sessionId;
                    const options = {
                        currentSessionOnly: args?.currentSessionOnly === true,
                        includeCompleted: args?.includeCompleted !== false,
                        includeEvents: args?.includeEvents !== false,
                    };

                    const { watchersDir, eventsDir } = ensureStateDirs();
                    const watchers = listJsonFilePaths(watchersDir)
                        .map((filePath) => safeReadJson(filePath))
                        .filter(Boolean)
                        .filter((watcher) => !options.currentSessionOnly || watcher.sessionId === currentSessionId)
                        .filter((watcher) => options.includeCompleted || watcher.status === "active")
                        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

                    const lines = [];

                    if (watchers.length === 0) {
                        lines.push("No matching build watchers found.");
                    } else {
                        lines.push("Build watchers:");
                        for (const watcher of watchers) {
                            const health = describeWatcherHealth(watcher);
                            lines.push(
                                `- ${watcher.watcherId} [${watcher.status}] run ${watcher.run?.runId} | ${watcher.run?.pipelineName ?? "unknown pipeline"} | ${watcher.run?.buildNumber ?? "unknown build"} | branch ${watcher.run?.branch ?? "n/a"} | next poll ${watcher.nextPollAt ?? "n/a"}${health ? ` | ${health}` : ""}`,
                            );
                        }
                    }

                    if (options.includeEvents) {
                        const events = listJsonFilePaths(eventsDir)
                            .map((filePath) => safeReadJson(filePath))
                            .filter(Boolean)
                            .filter((event) => !options.currentSessionOnly || event.sessionId === currentSessionId)
                            .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

                        lines.push("");
                        if (events.length === 0) {
                            lines.push("Pending watcher events: none.");
                        } else {
                            lines.push("Watcher events:");
                            for (const event of events) {
                                const delivered = Array.isArray(event.deliveredSessionIds) &&
                                    currentSessionId &&
                                    event.deliveredSessionIds.includes(currentSessionId);
                                lines.push(
                                    `- ${event.eventId} [${event.kind}] watcher ${event.watcherId} | run ${event.run?.runId ?? "n/a"} | ${event.run?.displayStatus ?? event.watcherStatus ?? "unknown"} | delivered here ${delivered ? "yes" : "no"}`,
                                );
                            }
                        }
                    }

                    return lines.join("\n");
                } catch (error) {
                    return {
                        resultType: "failure",
                        textResultForLlm: `Failed to list build watchers: ${formatError(error)}`,
                    };
                }
            },
        },
        {
            name: "build_watcher_stop",
            description: "Request a graceful stop for an active Azure DevOps build watcher.",
            parameters: {
                type: "object",
                properties: {
                    watcherId: {
                        type: "string",
                        description: "The watcher ID returned by build_watcher_start.",
                    },
                },
                required: ["watcherId"],
            },
            handler: async (args, invocation) => {
                try {
                    currentSessionId = invocation.sessionId;
                    const watcherId = normalizeOptionalString(args?.watcherId);
                    const { watchersDir } = ensureStateDirs();
                    const watcherPath = join(watchersDir, `${watcherId}.json`);
                    const watcher = safeReadJson(watcherPath);

                    if (!watcher) {
                        return {
                            resultType: "failure",
                            textResultForLlm: `No watcher found for ID ${watcherId}.`,
                        };
                    }

                    if (watcher.status !== "active") {
                        return `Watcher ${watcherId} is already ${watcher.status}.`;
                    }

                    const workerPid = getWorkerPid(watcher);
                    if (workerPid && !isProcessAlive(workerPid)) {
                        watcher.status = "stopped";
                        watcher.updatedAt = nowIso();
                        watcher.stoppedAt = nowIso();
                        watcher.worker = {
                            ...(watcher.worker ?? {}),
                            pid: null,
                            exitedAt: watcher.worker?.exitedAt ?? nowIso(),
                        };
                        writeJson(watcherPath, watcher);
                        unmarkWatching(watcherId);

                        return `Watcher ${watcherId} was not running anymore. Marked it stopped.`;
                    }

                    watcher.stopRequested = true;
                    watcher.updatedAt = nowIso();
                    writeJson(watcherPath, watcher);
                    unmarkWatching(watcherId);

                    return `Stop requested for watcher ${watcherId}. It should stop on its next poll cycle (within about ${watcher.pollIntervalSeconds}s).`;
                } catch (error) {
                    return {
                        resultType: "failure",
                        textResultForLlm: `Failed to stop build watcher: ${formatError(error)}`,
                    };
                }
            },
        },
    ],
});

session.on("session.idle", () => {
    if (!currentSessionId) {
        return;
    }

    setTimeout(() => {
        deliverPendingEvents(currentSessionId).catch(async (error) => {
            await session.log(`build-watcher idle delivery failed: ${formatError(error)}`, {
                level: "warning",
                ephemeral: true,
            });
        });
    }, idleEventDeliveryDelayMs);
});

session.on("session.shutdown", () => {
    currentSessionId = null;
    resetWatching();
    if (eventScanTimer) {
        clearInterval(eventScanTimer);
        eventScanTimer = null;
    }
});

function normalizeStartArgs(args) {
    return {
        run: String(args?.run ?? "").trim(),
        organizationUrl: normalizeOrganizationUrl(args?.organizationUrl),
        project: normalizeOptionalString(args?.project),
        pollIntervalSeconds: normalizePollIntervalSeconds(args?.pollIntervalSeconds),
        followUpPrompt: normalizeOptionalString(args?.followUpPrompt) ?? defaultWatcherFollowUpPrompt,
    };
}

function ensureEventMonitor() {
    if (eventScanTimer) {
        return;
    }

    eventScanTimer = setInterval(() => {
        if (!currentSessionId) {
            return;
        }

        deliverPendingEvents(currentSessionId).catch(async (error) => {
            await session.log(`build-watcher event scan failed: ${formatError(error)}`, {
                level: "warning",
                ephemeral: true,
            });
        });
    }, eventScanIntervalMs);
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
            const event = safeReadJson(eventPath);
            if (!event || event.sessionId !== sessionId) {
                continue;
            }

            const deliveredSessionIds = Array.isArray(event.deliveredSessionIds)
                ? event.deliveredSessionIds
                : [];

            if (deliveredSessionIds.includes(sessionId)) {
                continue;
            }

            const inFlightDelivery = event.inFlightDelivery && typeof event.inFlightDelivery === "object"
                ? event.inFlightDelivery
                : null;
            const inFlightStartedAtMs = typeof inFlightDelivery?.startedAt === "string"
                ? Date.parse(inFlightDelivery.startedAt)
                : Number.NaN;
            const inFlightOwnedByThisProcess = inFlightDelivery?.owner === deliveryOwnerId;
            const inFlightIsOrphaned = !inFlightOwnedByThisProcess && (
                Number.isNaN(inFlightStartedAtMs)
                || (Date.now() - inFlightStartedAtMs) >= orphanedDeliveryRetryDelayMs
            );

            if (inFlightDelivery && !inFlightIsOrphaned) {
                continue;
            }

            event.inFlightDelivery = {
                owner: deliveryOwnerId,
                sessionId,
                startedAt: nowIso(),
            };
            writeJson(eventPath, event);

            try {
                await session.log(buildEventNotice(event), {
                    level: eventLogLevel(event),
                });

                await session.send({
                    prompt: buildEventPrompt(event),
                    mode: "enqueue",
                });

                event.deliveredSessionIds = [...new Set([...deliveredSessionIds, sessionId])];
                event.deliveredAt = nowIso();
                delete event.inFlightDelivery;
                writeJson(eventPath, event);
                unmarkWatching(event.watcherId);
            } catch (error) {
                const errorMessage = formatError(error);

                if (event.inFlightDelivery?.owner === deliveryOwnerId) {
                    delete event.inFlightDelivery;
                }
                event.lastError = errorMessage;
                writeJson(eventPath, event);
                throw error;
            }
        }
    } finally {
        eventDeliveryInFlight = false;
    }
}

function buildEventPrompt(event) {
    const payload = {
        eventId: event.eventId,
        watcherId: event.watcherId,
        kind: event.kind,
        createdAt: event.createdAt,
        watcherStatus: event.watcherStatus,
        run: event.run,
        lastError: event.lastError,
    };

    const sections = [
        "A local build-watcher extension detected that a watched Azure DevOps build reached a terminal state.",
        "Treat the JSON payload below as trusted watcher output.",
        `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
    ];

    if (event.followUpPrompt) {
        sections.push(`Follow-up instruction: ${event.followUpPrompt}`);
        sections.push("If possible, continue the next step now.");
    } else {
        sections.push("Please summarize the result briefly and decide the next action if one is obvious.");
    }

    return sections.join("\n\n");
}

function buildEventNotice(event) {
    const runId = event.run?.runId ?? "unknown";
    const pipelineName = event.run?.pipelineName ?? "unknown pipeline";
    const buildNumber = event.run?.buildNumber ?? "unknown build";
    const status = event.run?.displayStatus ?? event.watcherStatus ?? event.kind;
    const url = event.run?.resultsUrl ? ` Results: ${event.run.resultsUrl}` : "";

    return `build-watcher callback: run ${runId} (${pipelineName} / ${buildNumber}) reached ${status}. Queueing follow-up into this session now.${url}`;
}

function eventLogLevel(event) {
    const combined = `${event.kind ?? ""} ${event.watcherStatus ?? ""} ${event.run?.displayStatus ?? ""}`.toLowerCase();

    if (combined.includes("fail") || combined.includes("error")) {
        return "error";
    }

    if (combined.includes("cancel") || combined.includes("partial")) {
        return "warning";
    }

    return "info";
}

function safeReadJson(filePath) {
    try {
        return readJson(filePath);
    } catch {
        return null;
    }
}
