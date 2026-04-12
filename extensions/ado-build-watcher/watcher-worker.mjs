import { join } from "node:path";
import {
    ensureStateDirs,
    extractRunSummary,
    fetchRun,
    formatError,
    nowIso,
    readJson,
    sleep,
    writeJson,
} from "./common.mjs";

const watcherPath = process.argv[2];

if (!watcherPath) {
    throw new Error("watcher-worker requires a watcher state path argument.");
}

await runWatcherLoop(watcherPath);

async function runWatcherLoop(filePath) {
    ensureStateDirs();

    while (true) {
        const watcher = readJson(filePath);

        if (watcher.stopRequested) {
            watcher.status = "stopped";
            watcher.updatedAt = nowIso();
            watcher.stoppedAt = nowIso();
            watcher.worker = {
                ...(watcher.worker ?? {}),
                exitedAt: nowIso(),
            };
            writeJson(filePath, watcher);
            return;
        }

        try {
            const run = await fetchRun(
                watcher.run.runId,
                {
                    organizationUrl: watcher.run.organizationUrl,
                    project: watcher.run.project,
                },
                watcher.cwd,
            );

            const summary = extractRunSummary(run, {
                organizationUrl: watcher.run.organizationUrl,
                project: watcher.run.project,
            });

            watcher.run = {
                ...watcher.run,
                ...summary,
            };
            watcher.lastObservation = summary;
            watcher.lastObservationAt = nowIso();
            watcher.updatedAt = nowIso();
            watcher.nextPollAt = new Date(Date.now() + watcher.pollIntervalSeconds * 1000).toISOString();
            watcher.consecutiveErrors = 0;
            watcher.lastError = null;

            if (summary.terminal) {
                watcher.status = summary.terminalStatus;
                watcher.completedAt = nowIso();
                watcher.worker = {
                    ...(watcher.worker ?? {}),
                    exitedAt: nowIso(),
                };
                writeJson(filePath, watcher);
                writeWatcherEvent(watcher, {
                    kind: "ado.build.terminal",
                    lastError: null,
                });
                return;
            }

            watcher.status = "active";
            writeJson(filePath, watcher);
        } catch (error) {
            watcher.consecutiveErrors = Number(watcher.consecutiveErrors ?? 0) + 1;
            watcher.lastError = formatError(error);
            watcher.updatedAt = nowIso();
            watcher.nextPollAt = new Date(Date.now() + watcher.pollIntervalSeconds * 1000).toISOString();

            if (watcher.consecutiveErrors >= 3) {
                watcher.status = "error";
                watcher.completedAt = nowIso();
                watcher.worker = {
                    ...(watcher.worker ?? {}),
                    exitedAt: nowIso(),
                };
                writeJson(filePath, watcher);
                writeWatcherEvent(watcher, {
                    kind: "ado.build.watcher_error",
                    lastError: watcher.lastError,
                });
                return;
            }

            writeJson(filePath, watcher);
        }

        await sleep(watcher.pollIntervalSeconds * 1000);
    }
}

function writeWatcherEvent(watcher, details) {
    const { eventsDir } = ensureStateDirs();
    const eventId = `evt-${watcher.watcherId}-${Date.now().toString(36)}`;
    const eventPath = join(eventsDir, `${eventId}.json`);
    const createdAt = nowIso();

    writeJson(eventPath, {
        schemaVersion: 1,
        eventId,
        watcherId: watcher.watcherId,
        sessionId: watcher.sessionId,
        kind: details.kind,
        createdAt,
        deliveredSessionIds: [],
        lastError: details.lastError,
        followUpPrompt: watcher.followUpPrompt ?? null,
        watcherStatus: watcher.status,
        run: watcher.run,
    });
}
