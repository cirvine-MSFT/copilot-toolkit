import {
    buildPullRequestWebUrl,
    collectTrackedComments,
    fetchPullRequestPolicies,
    fetchPullRequestSnapshot,
    fetchPullRequestThreads,
    formatError,
    getEventFilePath,
    getPolicyKey,
    identityMatches,
    isAuthError,
    normalizeIdentity,
    nowIso,
    readJsonFile,
    sleep,
    writeJsonAtomic,
} from "./common.mjs";

const watcherFilePath = process.argv[2];
const maxConsecutiveErrors = 3;
const authBackoffSeconds = 120;

if (!watcherFilePath) {
    throw new Error("Missing watcher file path.");
}

function collectNegativeVoteChanges(pullRequest, baseline, watchedBy) {
    const voteChanges = [];
    const currentVotes = {};

    for (const reviewer of Array.isArray(pullRequest?.reviewers) ? pullRequest.reviewers : []) {
        if (identityMatches(reviewer, watchedBy)) {
            continue;
        }

        const reviewerId = String(reviewer.id);
        const currentVote = Number(reviewer.vote ?? 0);
        currentVotes[reviewerId] = currentVote;

        const previousVote = Number(baseline?.reviewerVotes?.[reviewerId] ?? 0);
        if (currentVote !== previousVote && currentVote < 0) {
            voteChanges.push({
                reviewer: normalizeIdentity(reviewer),
                vote: currentVote,
                previousVote,
            });
        }
    }

    return { voteChanges, currentVotes };
}

function collectRejectedBlockingPolicies(policies, baseline) {
    const currentPolicyStates = {};
    const rejectedPolicies = [];

    for (const policy of Array.isArray(policies) ? policies : []) {
        const policyKey = getPolicyKey(policy);
        const currentStatus = String(policy?.status ?? "").toLowerCase();
        const currentState = {
            status: currentStatus,
            evaluationId: policy?.evaluationId ?? null,
            completedDate: policy?.completedDate ?? null,
        };

        currentPolicyStates[policyKey] = currentState;

        if (!policy?.configuration?.isBlocking || currentStatus !== "rejected") {
            continue;
        }

        const previousState = baseline?.policyStates?.[policyKey] ?? {};
        const alreadyObserved =
            String(previousState.status ?? "").toLowerCase() === currentStatus
            && String(previousState.evaluationId ?? "") === String(currentState.evaluationId ?? "")
            && String(previousState.completedDate ?? "") === String(currentState.completedDate ?? "");

        if (alreadyObserved) {
            continue;
        }

        rejectedPolicies.push({
            policyType: policy?.configuration?.type?.displayName ?? "Unknown policy",
            status: policy?.status ?? "rejected",
            configurationId: policy?.configuration?.id ?? null,
            evaluationId: policy?.evaluationId ?? null,
            completedDate: policy?.completedDate ?? null,
            displayName: policy?.configuration?.settings?.statusName ?? policy?.configuration?.type?.displayName ?? "Unknown policy",
        });
    }

    return { rejectedPolicies, currentPolicyStates };
}

function buildNotification(
    watcherState,
    snapshot,
    currentComments,
    voteChanges,
    currentVotes,
    rejectedPolicies,
    currentPolicyStates,
) {
    const baseline = watcherState.baseline ?? {};
    const newlySeenComments = currentComments.filter(
        (comment) => !Array.isArray(baseline.seenCommentKeys) || !baseline.seenCommentKeys.includes(comment.key),
    );

    const publishEvent =
        watcherState.waitForPublish === true
        && baseline.lastKnownIsDraft === true
        && snapshot.pullRequest?.isDraft === false;

    const terminalEvent =
        String(snapshot.pullRequest?.status ?? "").toLowerCase() !== "active"
        && String(snapshot.pullRequest?.status ?? "").toLowerCase() !== String(baseline.lastKnownStatus ?? "");

    const hasActionableEvents =
        publishEvent
        || terminalEvent
        || newlySeenComments.length > 0
        || voteChanges.length > 0
        || rejectedPolicies.length > 0;

    const nextBaseline = {
        seenCommentKeys: currentComments.map((comment) => comment.key),
        reviewerVotes: currentVotes,
        policyStates: currentPolicyStates,
        lastKnownStatus: String(snapshot.pullRequest?.status ?? "").toLowerCase(),
        lastKnownIsDraft: Boolean(snapshot.pullRequest?.isDraft),
        lastSourceCommitId: snapshot.pullRequest?.lastMergeSourceCommit?.commitId ?? null,
    };

    if ((snapshot.pullRequest?.isDraft ?? false) && watcherState.waitForPublish === true && !terminalEvent) {
        return {
            notification: null,
            nextBaseline,
            nextStatus: "waiting_for_publish",
            terminal: false,
        };
    }

    if (!hasActionableEvents) {
        return {
            notification: null,
            nextBaseline,
            nextStatus: "running",
            terminal: false,
        };
    }

    const pullRequestSummary = {
        pullRequestId: watcherState.pullRequestId,
        title: snapshot.pullRequest?.title ?? watcherState.pullRequestTitle ?? null,
        status: snapshot.pullRequest?.status ?? null,
        isDraft: Boolean(snapshot.pullRequest?.isDraft),
        mergeStatus: snapshot.pullRequest?.mergeStatus ?? null,
        sourceRefName: snapshot.pullRequest?.sourceRefName ?? null,
        targetRefName: snapshot.pullRequest?.targetRefName ?? null,
        url: watcherState.pullRequestUrl ?? buildPullRequestWebUrl({
            organization: watcherState.organization,
            project: watcherState.project,
            repository: watcherState.repositoryName,
            pullRequestId: watcherState.pullRequestId,
        }),
        repository: {
            id: watcherState.repositoryId,
            name: watcherState.repositoryName,
            project: watcherState.project,
        },
    };

    return {
        notification: {
            generatedAt: nowIso(),
            pullRequest: pullRequestSummary,
            publishEvent,
            terminalEvent,
            newComments: newlySeenComments,
            negativeVotes: voteChanges,
            rejectedPolicies,
        },
        nextBaseline,
        nextStatus: terminalEvent ? "completed" : "running",
        terminal: terminalEvent,
    };
}

function buildNotificationSummary(notification) {
    const parts = [];

    if (notification.publishEvent) {
        parts.push("published");
    }

    if (notification.newComments.length > 0) {
        parts.push(`${notification.newComments.length} comment${notification.newComments.length === 1 ? "" : "s"}`);
    }

    if (notification.negativeVotes.length > 0) {
        parts.push(`${notification.negativeVotes.length} negative vote${notification.negativeVotes.length === 1 ? "" : "s"}`);
    }

    if (notification.rejectedPolicies.length > 0) {
        parts.push(`${notification.rejectedPolicies.length} rejected polic${notification.rejectedPolicies.length === 1 ? "y" : "ies"}`);
    }

    if (notification.terminalEvent) {
        parts.push(`status=${notification.pullRequest.status ?? "unknown"}`);
    }

    return parts.join(", ") || "activity detected";
}

function buildWatcherEventId(watcherId) {
    return `evt-${watcherId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function writeWatcherEvent(watcherState, details) {
    const eventId = buildWatcherEventId(watcherState.watcherId);
    const eventPath = getEventFilePath(eventId);
    const createdAt = nowIso();

    await writeJsonAtomic(eventPath, {
        schemaVersion: 1,
        eventId,
        watcherId: watcherState.watcherId,
        sessionId: watcherState.sessionId,
        kind: details.kind,
        createdAt,
        deliveredSessionIds: [],
        lastError: details.lastError ?? null,
        summary: details.summary ?? null,
        watcherStatus: watcherState.status,
        pullRequest: {
            pullRequestId: watcherState.pullRequestId,
            title: watcherState.pullRequestTitle ?? null,
            url: watcherState.pullRequestUrl ?? null,
            repository: {
                id: watcherState.repositoryId,
                name: watcherState.repositoryName,
                project: watcherState.project,
            },
        },
        notification: details.notification ?? null,
    });
}

async function loadState() {
    const watcherState = await readJsonFile(watcherFilePath, { optional: false, retries: 2 });
    if (!watcherState) {
        throw new Error(`Watcher state file not found: ${watcherFilePath}`);
    }

    return watcherState;
}

function mergeLatestState(latestState, nextState) {
    const mergedState = {
        ...latestState,
        ...nextState,
        worker: {
            ...(latestState?.worker ?? {}),
            ...(nextState?.worker ?? {}),
        },
    };

    if (latestState?.stopRequestedAt) {
        mergedState.stopRequestedAt = latestState.stopRequestedAt;

        if (!["completed", "error", "stopped"].includes(String(mergedState.status ?? ""))) {
            mergedState.status = "stopping";
        }
    }

    return mergedState;
}

async function saveState(watcherState) {
    const latestState = await readJsonFile(watcherFilePath, { optional: true, retries: 2 });
    const mergedState = latestState ? mergeLatestState(latestState, watcherState) : watcherState;
    mergedState.updatedAt = nowIso();
    await writeJsonAtomic(watcherFilePath, mergedState);
    return mergedState;
}

async function finalizeWatcher(watcherState, status, lastError = null) {
    watcherState.status = status;
    watcherState.lastError = lastError;

    if (status === "stopped") {
        watcherState.stoppedAt = nowIso();
    }

    if (status === "completed" || status === "error") {
        watcherState.completedAt = nowIso();
    }

    watcherState.worker = {
        ...(watcherState.worker ?? {}),
        pid: null,
        exitedAt: nowIso(),
    };

    await saveState(watcherState);
}

async function pollOnce(watcherState) {
    if (watcherState.stopRequestedAt) {
        await finalizeWatcher(watcherState, "stopped");
        return true;
    }

    const snapshot = {
        pullRequest: await fetchPullRequestSnapshot({
            cwd: watcherState.workingDirectory,
            organization: watcherState.organization,
            project: watcherState.project,
            pullRequestId: watcherState.pullRequestId,
        }),
        threads: await fetchPullRequestThreads({
            cwd: watcherState.workingDirectory,
            organization: watcherState.organization,
            project: watcherState.project,
            repositoryId: watcherState.repositoryId,
            pullRequestId: watcherState.pullRequestId,
        }),
        policies: await fetchPullRequestPolicies({
            cwd: watcherState.workingDirectory,
            organization: watcherState.organization,
            project: watcherState.project,
            pullRequestId: watcherState.pullRequestId,
        }),
    };

    const currentComments = collectTrackedComments(
        snapshot.threads,
        watcherState.watchedBy,
        watcherState.ignoreSystemThreads !== false,
    );

    const { voteChanges, currentVotes } = collectNegativeVoteChanges(
        snapshot.pullRequest,
        watcherState.baseline,
        watcherState.watchedBy,
    );
    const { rejectedPolicies, currentPolicyStates } = collectRejectedBlockingPolicies(
        snapshot.policies,
        watcherState.baseline,
    );

    const notificationOutcome = buildNotification(
        watcherState,
        snapshot,
        currentComments,
        voteChanges,
        currentVotes,
        rejectedPolicies,
        currentPolicyStates,
    );

    watcherState.lastPollAt = nowIso();
    watcherState.nextPollAt = new Date(Date.now() + (watcherState.pollIntervalSeconds ?? 60) * 1000).toISOString();
    watcherState.pullRequestTitle = snapshot.pullRequest?.title ?? watcherState.pullRequestTitle;
    watcherState.pullRequestUrl = watcherState.pullRequestUrl ?? buildPullRequestWebUrl({
        organization: watcherState.organization,
        project: watcherState.project,
        repository: watcherState.repositoryName,
        pullRequestId: watcherState.pullRequestId,
    });
    watcherState.status = notificationOutcome.nextStatus;
    watcherState.baseline = notificationOutcome.nextBaseline;
    watcherState.consecutiveErrors = 0;
    watcherState.lastError = null;

    if (notificationOutcome.notification) {
        const summary = buildNotificationSummary(notificationOutcome.notification);

        await writeWatcherEvent(watcherState, {
            kind: "ado.pr.activity",
            notification: notificationOutcome.notification,
            summary,
        });

        watcherState.lastNotificationAt = nowIso();
        watcherState.lastNotificationSummary = summary;
    }

    await saveState(watcherState);

    if (notificationOutcome.terminal) {
        await finalizeWatcher(watcherState, "completed");
        return true;
    }

    return false;
}

async function runWatcherLoop() {
    let watcherState = await loadState();
    watcherState.startedAt = watcherState.startedAt ?? nowIso();
    watcherState.status = ["waiting_for_publish", "waiting_for_auth"].includes(watcherState.status) ? watcherState.status : "running";
    watcherState.worker = {
        ...(watcherState.worker ?? {}),
        pid: process.pid,
        startedAt: watcherState.worker?.startedAt ?? watcherState.startedAt,
        exitedAt: null,
    };
    watcherState.nextPollAt = new Date(Date.now() + (watcherState.pollIntervalSeconds ?? 60) * 1000).toISOString();
    await saveState(watcherState);

    while (true) {
        watcherState = await loadState();
        if (watcherState.stopRequestedAt) {
            await finalizeWatcher(watcherState, "stopped");
            return;
        }

        try {
            const shouldExit = await pollOnce(watcherState);
            if (shouldExit) {
                return;
            }
        }
        catch (error) {
            watcherState = await loadState();

            if (isAuthError(error)) {
                const alreadyWaitingForAuth = watcherState.status === "waiting_for_auth";
                watcherState.status = "waiting_for_auth";
                watcherState.lastError = formatError(error);
                watcherState.nextPollAt = new Date(Date.now() + authBackoffSeconds * 1000).toISOString();

                if (!alreadyWaitingForAuth) {
                    await writeWatcherEvent(watcherState, {
                        kind: "ado.pr.auth_required",
                        lastError: watcherState.lastError,
                        summary: "Azure CLI authentication expired — run az login to resume",
                    });
                    watcherState.lastNotificationAt = nowIso();
                    watcherState.lastNotificationSummary = "auth expired";
                }

                watcherState.consecutiveErrors = 0;
                await saveState(watcherState);
                await sleep(authBackoffSeconds * 1000);
                continue;
            }

            watcherState.consecutiveErrors = Number(watcherState.consecutiveErrors ?? 0) + 1;
            watcherState.lastError = formatError(error);
            watcherState.nextPollAt = new Date(Date.now() + (watcherState.pollIntervalSeconds ?? 60) * 1000).toISOString();

            if (watcherState.consecutiveErrors >= maxConsecutiveErrors) {
                watcherState.status = "error";
                watcherState.lastNotificationSummary = "watcher polling failed";

                await writeWatcherEvent(watcherState, {
                    kind: "ado.pr.watcher_error",
                    lastError: watcherState.lastError,
                    summary: `Polling failed ${watcherState.consecutiveErrors} times`,
                });

                await finalizeWatcher(watcherState, "error", watcherState.lastError);
                return;
            }

            await saveState(watcherState);
        }

        watcherState = await loadState();
        if (watcherState.stopRequestedAt) {
            await finalizeWatcher(watcherState, "stopped");
            return;
        }

        await sleep((watcherState.pollIntervalSeconds ?? 60) * 1000);
    }
}

async function handleFatalError(error, source) {
    try {
        const watcherState = await readJsonFile(watcherFilePath, { optional: true, retries: 2 });
        if (watcherState) {
            await writeWatcherEvent(watcherState, {
                kind: "ado.pr.watcher_error",
                lastError: `${source}: ${formatError(error)}`,
                summary: `Worker ${source}: ${formatError(error)}`,
            });
            await finalizeWatcher(watcherState, "error", `${source}: ${formatError(error)}`);
        }
    }
    catch {
        // Best-effort cleanup
    }
    process.exit(1);
}

process.on("uncaughtException", (error) => {
    handleFatalError(error, "uncaughtException");
});

process.on("unhandledRejection", (reason) => {
    handleFatalError(reason, "unhandledRejection");
});

try {
    await runWatcherLoop();
}
catch (error) {
    const watcherState = await readJsonFile(watcherFilePath, { optional: true, retries: 2 });
    if (watcherState) {
        try {
            await writeWatcherEvent(watcherState, {
                kind: "ado.pr.watcher_error",
                lastError: formatError(error),
                summary: `Worker crashed: ${formatError(error)}`,
            });
        }
        catch {
            // Best-effort event emission
        }
        await finalizeWatcher(watcherState, "error", formatError(error));
    }
    else {
        throw error;
    }
}
