import { accessSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import {
    DEFAULT_POLL_INTERVAL_SECONDS,
    buildPullRequestWebUrl,
    clampPollIntervalSeconds,
    createBaselineState,
    createWatcherId,
    ensureStateDirs,
    fetchPullRequestPolicies,
    fetchPullRequestSnapshot,
    fetchPullRequestThreads,
    formatError,
    formatTimestamp,
    getCurrentBranchName,
    getEventFilePath,
    getGitRemoteUrl,
    getLogFilePath,
    getWatcherFilePath,
    listJsonFilePaths,
    listPullRequestsBySourceBranch,
    loadWatcherEvents,
    loadWatcherStates,
    nowIso,
    parseAdoRemoteUrl,
    parsePullRequestUrl,
    readJsonFile,
    toSourceRefName,
    writeJsonAtomic,
} from "./common.mjs";
import { buildAutoStartRequestFromToolInput } from "./integration.mjs";
import { markWatching, resetWatching, unmarkWatching } from "../lib/tab-indicator.mjs";
import { resolveNodeBinary } from "../lib/resolve-node.mjs";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const workerFilePath = join(extensionDir, "worker.mjs");
const eventScanIntervalMs = 5000;
const idleEventDeliveryDelayMs = 50;
const deliveryOwnerId = String(process.pid);
const workerStartupGraceMs = 90_000;
const livenessStalenessFactor = 3;

const sessionContext = {
    cwd: process.cwd(),
};

let currentSessionId = null;
let eventScanTimer = null;
let eventDeliveryInFlight = false;

function success(textResultForLlm) {
    return { resultType: "success", textResultForLlm };
}

function failure(textResultForLlm) {
    return { resultType: "failure", textResultForLlm };
}

function currentWorkingDirectory() {
    return sessionContext.cwd || process.cwd();
}

function updateWorkingDirectory(input) {
    if (input?.cwd) {
        sessionContext.cwd = input.cwd;
    }
}

function isWatcherActive(status) {
    return !["completed", "stopped", "error"].includes(String(status ?? "").toLowerCase());
}

function isProcessAlive(pid) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) {
        return false;
    }

    try {
        process.kill(numericPid, 0);
        return true;
    }
    catch (error) {
        return error?.code === "EPERM";
    }
}

function summarizeWatcher(watcherState, pendingEventCount) {
    const status = watcherState.status ?? "unknown";
    const project = watcherState.project ?? "unknown-project";
    const repository = watcherState.repositoryName ?? watcherState.repositoryId ?? "unknown-repo";
    const title = watcherState.pullRequestTitle ? ` "${watcherState.pullRequestTitle}"` : "";
    const publishSuffix = status === "waiting_for_publish" ? " (waiting for publish)"
        : status === "waiting_for_auth" ? " (az login needed)"
        : "";
    const lines = [
        `- ${watcherState.watcherId}`,
        `  status: ${status}${publishSuffix}`,
        `  pr: ${project}/${repository}#${watcherState.pullRequestId}${title}`,
        `  poll: ${watcherState.pollIntervalSeconds}s`,
        `  next poll: ${formatTimestamp(watcherState.nextPollAt)}`,
        `  last poll: ${formatTimestamp(watcherState.lastPollAt)}`,
        `  last notify: ${formatTimestamp(watcherState.lastNotificationAt)}`,
        `  pending events: ${pendingEventCount}`,
    ];

    if (watcherState.lastNotificationSummary) {
        lines.push(`  last summary: ${watcherState.lastNotificationSummary}`);
    }

    if (watcherState.worker?.pid) {
        lines.push(`  worker: pid ${watcherState.worker.pid} (${isProcessAlive(watcherState.worker.pid) ? "running" : "missing"})`);
    }

    if (watcherState.lastError) {
        lines.push(`  last error: ${watcherState.lastError}`);
    }

    return lines.join("\n");
}

function summarizeEvent(event, sessionId) {
    const pullRequest = event.notification?.pullRequest ?? event.pullRequest ?? {};
    const repository = pullRequest.repository ?? {};
    const delivered = Array.isArray(event.deliveredSessionIds)
        && sessionId
        && event.deliveredSessionIds.includes(sessionId);

    return [
        `- ${event.eventId} [${event.kind}]`,
        `  watcher: ${event.watcherId}`,
        `  pr: ${repository.project ?? "unknown-project"}/${repository.name ?? "unknown-repo"}#${pullRequest.pullRequestId ?? "unknown"}`,
        `  created: ${formatTimestamp(event.createdAt)}`,
        `  summary: ${event.summary ?? event.lastError ?? "activity detected"}`,
        `  delivered here: ${delivered ? "yes" : "no"}`,
    ].join("\n");
}

async function startWatcher(args, invocation, options = {}) {
    const cwd = options.cwd ?? currentWorkingDirectory();
    const resolvedTarget = await resolvePullRequestTarget(args, cwd);

    if (resolvedTarget.resultType === "failure") {
        return resolvedTarget;
    }

    const {
        organization,
        project,
        repository,
        repositoryId,
        pullRequest,
        pullRequestId,
        pullRequestUrl,
    } = resolvedTarget;

    const watcherStates = await loadWatcherStates();
    const existingWatcher = watcherStates.find((watcherState) =>
        watcherState.sessionId === invocation.sessionId
        && Number(watcherState.pullRequestId) === pullRequestId
        && String(watcherState.repositoryId ?? "") === String(repositoryId ?? "")
        && isWatcherActive(watcherState.status),
    );

    if (existingWatcher) {
        return success(`Watcher ${existingWatcher.watcherId} is already ${existingWatcher.status} for ADO PR ${pullRequestId}.`);
    }

    const ignoreSystemThreads = args.ignoreSystemThreads !== false;
    const threads = await fetchPullRequestThreads({
        cwd,
        organization,
        project,
        repositoryId,
        pullRequestId,
    });
    const policies = await fetchPullRequestPolicies({
        cwd,
        organization,
        project,
        pullRequestId,
    });

    const watchedBy = {
        id: pullRequest?.createdBy?.id ?? null,
        uniqueName: pullRequest?.createdBy?.uniqueName ?? null,
        displayName: pullRequest?.createdBy?.displayName ?? null,
    };

    const baseline = createBaselineState({
        pullRequest,
        threads,
        policies,
        watchedBy,
        ignoreSystemThreads,
    });

    const watcherId = createWatcherId();
    const watcherFilePath = getWatcherFilePath(watcherId);
    const createdAt = nowIso();
    const pollIntervalSeconds = clampPollIntervalSeconds(args.pollIntervalSeconds);

    try {
        accessSync(workerFilePath);
    }
    catch {
        return failure(`The PR watcher worker file could not be found at ${workerFilePath}.`);
    }

    const watcherState = {
        schemaVersion: 2,
        watcherId,
        sessionId: invocation.sessionId,
        createdAt,
        updatedAt: createdAt,
        status: pullRequest.isDraft && args.waitForPublish === true ? "waiting_for_publish" : "starting",
        workingDirectory: cwd,
        organization,
        project,
        repositoryName: repository,
        repositoryId,
        pullRequestId,
        pullRequestTitle: pullRequest.title ?? null,
        pullRequestUrl,
        waitForPublish: args.waitForPublish === true,
        ignoreSystemThreads,
        pollIntervalSeconds,
        watchedBy,
        baseline,
        startedAt: null,
        stoppedAt: null,
        completedAt: null,
        stopRequestedAt: null,
        lastPollAt: null,
        nextPollAt: new Date(Date.now() + pollIntervalSeconds * 1000).toISOString(),
        lastNotificationAt: null,
        lastNotificationSummary: null,
        lastError: null,
        consecutiveErrors: 0,
        worker: {
            pid: null,
            startedAt: null,
            exitedAt: null,
        },
    };

    await writeJsonAtomic(watcherFilePath, watcherState);

    let worker;
    try {
        const logPath = getLogFilePath(watcherId);
        const logFd = openSync(logPath, "a");
        const nodeBinary = await resolveNodeBinary();
        worker = spawn(nodeBinary, [workerFilePath, watcherFilePath], {
            cwd,
            detached: true,
            stdio: ["ignore", "ignore", logFd],
            windowsHide: true,
        });
        worker.unref();
        closeSync(logFd);
    }
    catch (error) {
        watcherState.status = "error";
        watcherState.lastError = formatError(error);
        watcherState.completedAt = nowIso();
        await writeJsonAtomic(watcherFilePath, watcherState);
        return failure(`Failed to start watcher for ADO PR ${pullRequestId}: ${watcherState.lastError}`);
    }

    watcherState.startedAt = nowIso();
    watcherState.updatedAt = nowIso();
    watcherState.worker = {
        pid: worker.pid ?? null,
        startedAt: watcherState.startedAt,
        exitedAt: null,
    };
    await writeJsonAtomic(watcherFilePath, watcherState);

    ensureEventMonitor();
    markWatching(watcherId);

    const publishSuffix = pullRequest.isDraft
        ? " It will stay quiet until the PR is published."
        : "";

    return success(
        `Started watcher ${watcherId} for ADO PR ${pullRequestId} (${project}/${repository}). Polling every ${pollIntervalSeconds}s.${publishSuffix} Use pr_watcher_list to inspect it or pr_watcher_stop to stop it.`,
    );
}

async function handleAutoStartIfNeeded(input, invocation) {
    const autoStartRequest = buildAutoStartRequestFromToolInput(input);
    if (!autoStartRequest) {
        return undefined;
    }

    const result = await startWatcher(
        {
            ...autoStartRequest.startArgs,
            ignoreSystemThreads: true,
            pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
        },
        invocation,
        {
            cwd: input.cwd,
        },
    );

    if (result.resultType === "success") {
        await session.log(`pr-watcher auto-registered after ${autoStartRequest.reason}. ${result.textResultForLlm}`, {
            ephemeral: true,
        });

        return {
            additionalContext: `The pr-watcher extension auto-registered the watcher after ${autoStartRequest.reason}. ${result.textResultForLlm} Do not call pr_watcher_start again unless you want different watcher options.`,
        };
    }

    await session.log(`pr-watcher could not auto-register after ${autoStartRequest.reason}: ${result.textResultForLlm}`, {
        level: "warning",
        ephemeral: true,
    });

    return {
        additionalContext: `The pr-watcher extension could not auto-register after ${autoStartRequest.reason}. ${result.textResultForLlm} If ongoing PR participation still matters, call pr_watcher_start explicitly once the PR ID or URL is available.`,
    };
}

async function resolvePullRequestTarget(args, cwd) {
    const remoteContext = parseAdoRemoteUrl(await getGitRemoteUrl(cwd));
    const urlContext = parsePullRequestUrl(args.pullRequestUrl);

    const organization = args.organization ?? urlContext?.organization ?? remoteContext?.organization ?? null;
    const project = args.project ?? urlContext?.project ?? remoteContext?.project ?? null;
    const repository = args.repository ?? urlContext?.repository ?? remoteContext?.repository ?? null;

    let pullRequestId = Number(args.pullRequestId ?? urlContext?.pullRequestId ?? Number.NaN);

    if (!Number.isInteger(pullRequestId)) {
        const sourceBranch = toSourceRefName(args.sourceBranch ?? await getCurrentBranchName(cwd));
        if (!sourceBranch) {
            return failure("An active Azure DevOps pull request could not be resolved from the current branch. Pass pullRequestId or pullRequestUrl explicitly.");
        }

        const pullRequests = await listPullRequestsBySourceBranch({
            cwd,
            organization,
            project,
            repository,
            sourceRefName: sourceBranch,
        });

        if (pullRequests.length === 0) {
            return failure(`No active Azure DevOps pull request was found for ${sourceBranch}. Pass pullRequestId or pullRequestUrl explicitly.`);
        }

        if (pullRequests.length > 1) {
            return failure(`More than one active pull request matched ${sourceBranch}. Pass pullRequestId explicitly.`);
        }

        pullRequestId = Number(pullRequests[0].pullRequestId);
    }

    if (!Number.isInteger(pullRequestId)) {
        return failure("A valid Azure DevOps pull request ID is required.");
    }

    const pullRequest = await fetchPullRequestSnapshot({
        cwd,
        organization,
        project,
        pullRequestId,
    });

    if (!pullRequest?.pullRequestId) {
        return failure(`Azure DevOps pull request ${pullRequestId} could not be resolved.`);
    }

    return {
        organization,
        project: pullRequest?.repository?.project?.name ?? project ?? null,
        repository: pullRequest?.repository?.name ?? repository ?? null,
        repositoryId: pullRequest?.repository?.id ?? repository ?? null,
        pullRequest,
        pullRequestId,
        pullRequestUrl: parsePullRequestUrl(pullRequest?.url)?.pullRequestUrl
            ?? buildPullRequestWebUrl({
                organization,
                project: pullRequest?.repository?.project?.name ?? project,
                repository: pullRequest?.repository?.name ?? repository,
                pullRequestId,
            }),
    };
}

const session = await joinSession({
    hooks: {
        onSessionStart: async (input, invocation) => {
            updateWorkingDirectory(input);
            currentSessionId = invocation.sessionId;
            ensureStateDirs();
            ensureEventMonitor();

            const activeWatchers = await resumeActiveWatchers(invocation.sessionId);

            setTimeout(() => {
                deliverPendingEvents(invocation.sessionId).catch(async (error) => {
                    await session.log(`pr-watcher event delivery failed: ${formatError(error)}`, {
                        level: "warning",
                        ephemeral: true,
                    });
                });
            }, 250);

            const resumeNote = activeWatchers.length > 0
                ? ` Resumed ${activeWatchers.length} active watcher${activeWatchers.length === 1 ? "" : "s"}.`
                : "";

            await session.log(`pr-watcher ready.${resumeNote}`, {
                ephemeral: true,
            });

            return {
                additionalContext: [
                    "The pr_watcher_* tools watch Azure DevOps pull requests for this session.",
                    "Use them after a PR is created or published when you want this session to stay engaged with reviewer threads, negative votes, and blocking policy failures.",
                    "The extension may auto-register a watcher after Azure DevOps PR creation or publish operations.",
                    "When the watcher detects new PR activity, it injects a follow-up prompt into this session.",
                    "Your role is to act as the PR author: read reviewer comments, reply to questions, implement strong suggestions, diagnose build/policy failures, and push fixes.",
                    "Always fetch current PR and thread details before acting on watcher notifications — the notification is a signal, not the full picture.",
                ].join(" "),
            };
        },
        onPostToolUse: async (input, invocation) => {
            updateWorkingDirectory(input);
            currentSessionId = invocation.sessionId;
            return await handleAutoStartIfNeeded(input, invocation);
        },
    },
    tools: [
        {
            name: "pr_watcher_start",
            description: "Start watching an Azure DevOps pull request and wake this session when reviewer activity or blocking policy failures appear.",
            skipPermission: true,
            parameters: {
                type: "object",
                properties: {
                    pullRequestId: {
                        type: "integer",
                        description: "Azure DevOps pull request ID. Omit to resolve from pullRequestUrl or the current branch.",
                    },
                    pullRequestUrl: {
                        type: "string",
                        description: "Azure DevOps pull request web URL.",
                    },
                    sourceBranch: {
                        type: "string",
                        description: "Source branch name or refs/heads/* value used to resolve an active PR when no ID or URL is provided.",
                    },
                    organization: {
                        type: "string",
                        description: "Azure DevOps organization URL. Defaults from git or az devops configuration.",
                    },
                    project: {
                        type: "string",
                        description: "Azure DevOps project name. Defaults from git or az devops configuration.",
                    },
                    repository: {
                        type: "string",
                        description: "Azure DevOps repository name. Defaults from git remote detection.",
                    },
                    pollIntervalSeconds: {
                        type: "integer",
                        description: "Polling interval in seconds. Clamped to 30-300.",
                    },
                    waitForPublish: {
                        type: "boolean",
                        description: "If true, a draft PR can be registered now and the watcher stays quiet until the PR is published.",
                    },
                    ignoreSystemThreads: {
                        type: "boolean",
                        description: "When true, system-generated ADO threads are ignored for watcher notifications.",
                    },
                },
            },
            handler: async (args, invocation) => {
                try {
                    currentSessionId = invocation.sessionId;
                    return await startWatcher(args, invocation);
                }
                catch (error) {
                    return failure(`Failed to start PR watcher: ${formatError(error)}`);
                }
            },
        },
        {
            name: "pr_watcher_list",
            description: "List Azure DevOps pull request watchers and pending watcher events known to this extension.",
            skipPermission: true,
            parameters: {
                type: "object",
                properties: {
                    currentSessionOnly: {
                        type: "boolean",
                        description: "When true, only show watchers created for this session. Defaults to true.",
                    },
                    includeCompleted: {
                        type: "boolean",
                        description: "When true, include completed, stopped, and errored watchers.",
                    },
                    includeEvents: {
                        type: "boolean",
                        description: "When true, include pending watcher event files.",
                    },
                },
            },
            handler: async (args, invocation) => {
                try {
                    currentSessionId = invocation.sessionId;
                    const currentSessionOnly = args.currentSessionOnly !== false;
                    const includeCompleted = args.includeCompleted === true;
                    const includeEvents = args.includeEvents !== false;
                    const watcherStates = await loadWatcherStates();
                    const watcherEvents = includeEvents ? await loadWatcherEvents() : [];

                    const filteredWatchers = watcherStates.filter((watcherState) => {
                        if (currentSessionOnly && watcherState.sessionId !== invocation.sessionId) {
                            return false;
                        }

                        if (!includeCompleted && !isWatcherActive(watcherState.status)) {
                            return false;
                        }

                        return true;
                    });

                    const filteredEvents = watcherEvents.filter((event) => !currentSessionOnly || event.sessionId === invocation.sessionId);
                    const pendingEventCounts = new Map();

                    for (const event of filteredEvents) {
                        const delivered = Array.isArray(event.deliveredSessionIds)
                            && invocation.sessionId
                            && event.deliveredSessionIds.includes(invocation.sessionId);

                        if (!delivered) {
                            pendingEventCounts.set(
                                event.watcherId,
                                Number(pendingEventCounts.get(event.watcherId) ?? 0) + 1,
                            );
                        }
                    }

                    const lines = [];

                    if (filteredWatchers.length === 0) {
                        lines.push("No matching Azure DevOps PR watchers were found.");
                    }
                    else {
                        lines.push("Azure DevOps PR watchers:");
                        for (const watcherState of filteredWatchers) {
                            lines.push(summarizeWatcher(watcherState, Number(pendingEventCounts.get(watcherState.watcherId) ?? 0)));
                        }
                    }

                    if (includeEvents) {
                        lines.push("");

                        if (filteredEvents.length === 0) {
                            lines.push("Watcher events: none.");
                        }
                        else {
                            lines.push("Watcher events:");
                            for (const event of filteredEvents) {
                                lines.push(summarizeEvent(event, invocation.sessionId));
                            }
                        }
                    }

                    return success(lines.join("\n"));
                }
                catch (error) {
                    return failure(`Failed to list PR watchers: ${formatError(error)}`);
                }
            },
        },
        {
            name: "pr_watcher_stop",
            description: "Request a graceful stop for an Azure DevOps pull request watcher.",
            skipPermission: true,
            parameters: {
                type: "object",
                properties: {
                    watcherId: {
                        type: "string",
                        description: "Watcher ID returned by pr_watcher_start.",
                    },
                },
                required: ["watcherId"],
            },
            handler: async (args, invocation) => {
                try {
                    currentSessionId = invocation.sessionId;
                    const watcherFilePath = getWatcherFilePath(args.watcherId);
                    const watcherState = await readJsonFile(watcherFilePath, { optional: true, retries: 2 });

                    if (!watcherState) {
                        return failure(`Watcher ${args.watcherId} was not found.`);
                    }

                    if (watcherState.sessionId !== invocation.sessionId) {
                        return failure(`Watcher ${args.watcherId} belongs to a different session.`);
                    }

                    if (!isWatcherActive(watcherState.status)) {
                        return success(`Watcher ${args.watcherId} is already ${watcherState.status}.`);
                    }

                    if (!isProcessAlive(watcherState.worker?.pid)) {
                        watcherState.status = "stopped";
                        watcherState.stoppedAt = nowIso();
                        watcherState.updatedAt = nowIso();
                        watcherState.worker = {
                            ...(watcherState.worker ?? {}),
                            pid: null,
                            exitedAt: watcherState.worker?.exitedAt ?? nowIso(),
                        };

                        await writeJsonAtomic(watcherFilePath, watcherState);
                        unmarkWatching(args.watcherId);
                        return success(`Watcher ${args.watcherId} was not running. Marked it stopped.`);
                    }

                    watcherState.stopRequestedAt = nowIso();
                    watcherState.status = "stopping";
                    watcherState.updatedAt = nowIso();

                    await writeJsonAtomic(watcherFilePath, watcherState);
                    unmarkWatching(args.watcherId);
                    return success(`Stop requested for watcher ${args.watcherId}. It should stop on its next poll cycle (within about ${watcherState.pollIntervalSeconds}s).`);
                }
                catch (error) {
                    return failure(`Failed to stop PR watcher: ${formatError(error)}`);
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
            await session.log(`pr-watcher idle delivery failed: ${formatError(error)}`, {
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

function ensureEventMonitor() {
    if (eventScanTimer) {
        return;
    }

    eventScanTimer = setInterval(() => {
        if (!currentSessionId) {
            return;
        }

        deliverPendingEvents(currentSessionId).catch(async (error) => {
            await session.log(`pr-watcher event scan failed: ${formatError(error)}`, {
                level: "warning",
                ephemeral: true,
            });
        });
    }, eventScanIntervalMs);
}

async function resumeActiveWatchers(sessionId) {
    const watcherStates = await loadWatcherStates();
    const activeWatchers = watcherStates.filter((watcherState) =>
        watcherState.sessionId === sessionId && isWatcherActive(watcherState.status),
    );

    for (const watcherState of activeWatchers) {
        markWatching(watcherState.watcherId);
    }

    return activeWatchers;
}

async function checkWatcherLiveness(sessionId) {
    const watcherStates = await loadWatcherStates();

    for (const watcherState of watcherStates) {
        if (watcherState.sessionId !== sessionId || !isWatcherActive(watcherState.status)) {
            continue;
        }

        if (["starting", "stopping", "waiting_for_publish", "waiting_for_auth"].includes(watcherState.status)) {
            continue;
        }

        const createdAtMs = Date.parse(watcherState.createdAt ?? "");
        if (!Number.isNaN(createdAtMs) && (Date.now() - createdAtMs) < workerStartupGraceMs) {
            continue;
        }

        const workerPid = watcherState.worker?.pid;
        const pidDead = workerPid && !isProcessAlive(workerPid);

        const updatedAtMs = Date.parse(watcherState.updatedAt ?? watcherState.lastPollAt ?? "");
        const stalenessThresholdMs = (watcherState.pollIntervalSeconds ?? 60) * livenessStalenessFactor * 1000;
        const heartbeatStale = !Number.isNaN(updatedAtMs) && (Date.now() - updatedAtMs) > stalenessThresholdMs;

        if (!pidDead && !heartbeatStale) {
            continue;
        }

        const freshState = await readJsonFile(getWatcherFilePath(watcherState.watcherId), { optional: true, retries: 2 });
        if (!freshState || !isWatcherActive(freshState.status)) {
            continue;
        }

        const reason = pidDead ? "worker process died" : "worker heartbeat stale";

        try {
            const eventId = `evt-${freshState.watcherId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const eventPath = getEventFilePath(eventId);
            await writeJsonAtomic(eventPath, {
                schemaVersion: 1,
                eventId,
                watcherId: freshState.watcherId,
                sessionId: freshState.sessionId,
                kind: "ado.pr.watcher_error",
                createdAt: nowIso(),
                deliveredSessionIds: [],
                lastError: reason,
                summary: `Watcher detected dead: ${reason}`,
                watcherStatus: "error",
                pullRequest: {
                    pullRequestId: freshState.pullRequestId,
                    title: freshState.pullRequestTitle ?? null,
                    url: freshState.pullRequestUrl ?? null,
                    repository: {
                        id: freshState.repositoryId,
                        name: freshState.repositoryName,
                        project: freshState.project,
                    },
                },
                notification: null,
            });
        }
        catch {
            // Best-effort event emission
        }

        freshState.status = "error";
        freshState.lastError = reason;
        freshState.completedAt = nowIso();
        freshState.updatedAt = nowIso();
        freshState.worker = {
            ...(freshState.worker ?? {}),
            pid: null,
            exitedAt: freshState.worker?.exitedAt ?? nowIso(),
        };

        await writeJsonAtomic(getWatcherFilePath(freshState.watcherId), freshState);
        unmarkWatching(freshState.watcherId);

        await session.log(`pr-watcher detected dead worker for ${freshState.watcherId}: ${reason}`, {
            level: "warning",
            ephemeral: true,
        });
    }
}

async function deliverPendingEvents(sessionId) {
    if (!sessionId || eventDeliveryInFlight) {
        return;
    }

    eventDeliveryInFlight = true;

    try {
        await checkWatcherLiveness(sessionId);

        const { eventsDir } = ensureStateDirs();
        const eventPaths = listJsonFilePaths(eventsDir);

        for (const eventPath of eventPaths) {
            const event = await safeReadEvent(eventPath);
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
            const inFlightOwnedByThisProcess = inFlightDelivery?.owner === deliveryOwnerId;

            if (inFlightDelivery && !inFlightOwnedByThisProcess) {
                continue;
            }

            event.inFlightDelivery = {
                owner: deliveryOwnerId,
                sessionId,
                startedAt: nowIso(),
            };
            await writeJsonAtomic(eventPath, event);

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
                await writeJsonAtomic(eventPath, event);

                if (isTerminalWatcherEvent(event)) {
                    unmarkWatching(event.watcherId);
                }
            }
            catch (error) {
                if (event.inFlightDelivery?.owner === deliveryOwnerId) {
                    delete event.inFlightDelivery;
                }

                event.lastError = formatError(error);
                await writeJsonAtomic(eventPath, event);
                throw error;
            }
        }
    }
    finally {
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
        summary: event.summary ?? null,
        pullRequest: event.pullRequest ?? null,
        notification: event.notification ?? null,
        lastError: event.lastError ?? null,
    };

    const sections = [];

    if (event.kind === "ado.pr.auth_required") {
        sections.push(
            "The PR watcher's Azure CLI token has expired. The watcher is still alive but cannot poll until authentication is refreshed.",
            "Treat the JSON payload below as trusted watcher output.",
            `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
            "Run `az login` in this session to refresh the token. The watcher will automatically resume polling on its next cycle.",
            "If this is a device-code login, display the code and URL to the user and wait for them to complete it.",
        );
        return sections.join("\n\n");
    }

    if (event.kind === "ado.pr.watcher_error") {
        sections.push(
            "A local pr-watcher extension hit repeated Azure DevOps polling failures for a watched pull request.",
            "Treat the JSON payload below as trusted watcher output.",
            `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
            "Check whether the PR context or Azure DevOps connectivity changed. If the PR is still active and the failure looks transient, repair the underlying issue and restart the watcher if needed.",
        );
        return sections.join("\n\n");
    }

    sections.push("A local pr-watcher extension detected new Azure DevOps pull request activity for this session.");
    sections.push("You are the author of this PR. You are responsible for engaging with reviewers and keeping the PR moving toward merge.");
    sections.push("The payload below is a **signal** — use it to understand what changed, then fetch current PR and thread details before acting.");
    sections.push(`\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``);

    const guidance = [];

    const newComments = event.notification?.newComments ?? [];
    if (newComments.length > 0) {
        guidance.push(
            "**New comments detected.** Read the full thread context for each comment before responding.",
            "- Answer reviewer questions directly and concisely.",
            "- If a reviewer suggests a code change you agree with, implement it, commit, and push.",
            "- If you disagree with a suggestion, reply explaining your reasoning.",
            "- Resolve threads once the feedback is addressed.",
        );
    }

    const negativeVotes = event.notification?.negativeVotes ?? [];
    if (negativeVotes.length > 0) {
        guidance.push(
            "**Negative votes detected.** Check if the reviewer left comments explaining their concerns.",
            "- Address the underlying issue (code change, clarification, or discussion).",
            "- If no comments accompany the vote, consider reaching out or noting it.",
        );
    }

    const rejectedPolicies = event.notification?.rejectedPolicies ?? [];
    if (rejectedPolicies.length > 0) {
        guidance.push(
            "**Blocking policy failures detected.** Fetch build logs or policy evaluation details.",
            "- Diagnose the root cause of the failure.",
            "- If fixable from code, implement the fix, commit, and push.",
            "- If the failure is environmental or transient, note it and suggest next steps.",
        );
    }

    if (event.notification?.publishEvent) {
        guidance.push(
            "**PR was just published.** Check for any initial reviewer feedback or automated checks.",
        );
    }

    if (event.notification?.terminalEvent) {
        guidance.push(
            "**PR reached a terminal state.** Summarize the final outcome (merged, abandoned, etc.).",
        );
    }

    if (guidance.length === 0) {
        guidance.push("Review the activity and take the appropriate next action.");
    }

    sections.push(guidance.join("\n"));
    sections.push("For Azure DevOps thread actions, use the available ADO repo comment/thread tools if present, or fall back to `az devops invoke`.");

    return sections.join("\n\n");
}

function buildEventNotice(event) {
    const pullRequest = event.notification?.pullRequest ?? event.pullRequest ?? {};
    const repository = pullRequest.repository ?? {};
    const project = repository.project ?? "unknown-project";
    const repositoryName = repository.name ?? "unknown-repo";
    const pullRequestId = pullRequest.pullRequestId ?? "unknown";
    const summary = event.summary ?? event.lastError ?? event.kind;

    return `pr-watcher callback: PR ${project}/${repositoryName}#${pullRequestId} has new activity (${summary}). Injecting follow-up into this session now.`;
}

function eventLogLevel(event) {
    if (event.kind === "ado.pr.auth_required") {
        return "warning";
    }

    if (event.kind === "ado.pr.watcher_error" || event.lastError) {
        return "error";
    }

    if (event.notification?.rejectedPolicies?.length > 0) {
        return "error";
    }

    if (event.notification?.negativeVotes?.length > 0 || event.notification?.terminalEvent) {
        return "warning";
    }

    return "info";
}

function isTerminalWatcherEvent(event) {
    return event.kind === "ado.pr.watcher_error"
        || event.notification?.terminalEvent === true;
}

async function safeReadEvent(eventPath) {
    try {
        return await readJsonFile(eventPath, { optional: true, retries: 2 });
    }
    catch {
        return null;
    }
}
