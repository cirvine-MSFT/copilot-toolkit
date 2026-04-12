import crypto from "node:crypto";
import { exec, execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const maxBuffer = 20 * 1024 * 1024;
const defaultWindowsAzPath = "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd";
const windowsAzCommand = existsSync(defaultWindowsAzPath) ? defaultWindowsAzPath : "az.cmd";

export const MIN_POLL_INTERVAL_SECONDS = 30;
export const MAX_POLL_INTERVAL_SECONDS = 300;
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;

export function nowIso() {
    return new Date().toISOString();
}

export function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function formatError(error) {
    if (!error) {
        return "Unknown error";
    }

    return String(error?.message ?? error).trim();
}

const authErrorPatterns = [
    /\baz login\b/i,
    /\bAADSTS\d+/i,
    /\brefresh token\b.*\bexpir/i,
    /\bnot\s+logged\s+in\b/i,
    /\btoken\b.*\bexpir/i,
    /\bInteractive\s+login\s+is\s+needed\b/i,
    /\bPlease\s+run\b.*\blogin\b/i,
];

export function isAuthError(error) {
    const message = formatError(error);
    return authErrorPatterns.some((pattern) => pattern.test(message));
}

export function clampPollIntervalSeconds(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return DEFAULT_POLL_INTERVAL_SECONDS;
    }

    return Math.min(
        MAX_POLL_INTERVAL_SECONDS,
        Math.max(MIN_POLL_INTERVAL_SECONDS, Math.round(numericValue)),
    );
}

export function createWatcherId() {
    return crypto.randomUUID();
}

export function getStateDirectory() {
    return path.join(os.homedir(), ".copilot", "pr-watchers");
}

export function ensureStateDirs() {
    const root = getStateDirectory();
    const watchersDir = path.join(root, "watchers");
    const eventsDir = path.join(root, "events");
    const logsDir = path.join(root, "logs");

    mkdirSync(watchersDir, { recursive: true });
    mkdirSync(eventsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    return {
        root,
        watchersDir,
        eventsDir,
        logsDir,
    };
}

export function listJsonFilePaths(directoryPath) {
    if (!existsSync(directoryPath)) {
        return [];
    }

    return readdirSync(directoryPath)
        .filter((entry) => entry.toLowerCase().endsWith(".json"))
        .map((entry) => path.join(directoryPath, entry))
        .sort();
}

export function getWatcherFilePath(watcherId) {
    const { watchersDir } = ensureStateDirs();
    return path.join(watchersDir, `${watcherId}.json`);
}

export function getEventFilePath(eventId) {
    const { eventsDir } = ensureStateDirs();
    return path.join(eventsDir, `${eventId}.json`);
}

export function getLogFilePath(watcherId) {
    const { logsDir } = ensureStateDirs();
    return path.join(logsDir, `${watcherId}.log`);
}

export async function writeJsonAtomic(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const content = `${JSON.stringify(value, null, 2)}\n`;

    await fs.writeFile(tempFilePath, content, "utf8");

    try {
        await fs.rename(tempFilePath, filePath);
    }
    catch (error) {
        if (!["EEXIST", "EPERM", "EACCES"].includes(String(error?.code ?? ""))) {
            throw error;
        }

        await fs.copyFile(tempFilePath, filePath);
        await fs.rm(tempFilePath, { force: true });
    }
}

export async function readJsonFile(filePath, options = {}) {
    const optional = options.optional !== false;
    const retries = Number.isInteger(options.retries) ? options.retries : 0;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const content = await fs.readFile(filePath, "utf8");
            return JSON.parse(content);
        }
        catch (error) {
            lastError = error;
            const transientFailure = error?.code === "ENOENT" || error instanceof SyntaxError;

            if (attempt < retries && transientFailure) {
                await sleep((attempt + 1) * 25);
                continue;
            }

            if (error?.code === "ENOENT" && optional) {
                return null;
            }

            throw error;
        }
    }

    if (optional && lastError?.code === "ENOENT") {
        return null;
    }

    throw lastError;
}

async function loadJsonRecords(directoryPath, itemKind) {
    const records = [];

    for (const filePath of listJsonFilePaths(directoryPath)) {
        try {
            const record = await readJsonFile(filePath, { optional: true, retries: 2 });
            if (record) {
                records.push(record);
            }
        }
        catch (error) {
            const idKey = itemKind === "event" ? "eventId" : "watcherId";
            records.push({
                [idKey]: path.basename(filePath, ".json"),
                createdAt: null,
                kind: itemKind === "event" ? "error" : null,
                lastError: formatError(error),
                status: "error",
                unreadable: true,
            });
        }
    }

    records.sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
    return records;
}

export async function loadWatcherStates() {
    const { watchersDir } = ensureStateDirs();
    return await loadJsonRecords(watchersDir, "watcher");
}

export async function loadWatcherEvents() {
    const { eventsDir } = ensureStateDirs();
    return await loadJsonRecords(eventsDir, "event");
}

function appendJsonOutput(args) {
    const renderedArgs = [...args];

    if (!renderedArgs.includes("--output") && !renderedArgs.includes("-o")) {
        renderedArgs.push("--output", "json");
    }

    if (!renderedArgs.includes("--only-show-errors")) {
        renderedArgs.push("--only-show-errors");
    }

    return renderedArgs;
}

function normalizeCommandName(command) {
    return path.basename(String(command ?? ""))
        .replace(/\.(cmd|exe|bat)$/i, "")
        .toLowerCase();
}

function quoteWindowsArg(value) {
    const text = String(value);

    if (text.length === 0) {
        return "\"\"";
    }

    if (!/[\s"&|<>^()]/.test(text)) {
        return text;
    }

    return `"${text.replace(/"/g, "\\\"")}"`;
}

async function execText(command, args, options = {}) {
    const executionOptions = {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer,
        windowsHide: true,
    };

    if (process.platform === "win32" && normalizeCommandName(command) === "az") {
        const renderedCommand = `${quoteWindowsArg(windowsAzCommand)} ${args.map(quoteWindowsArg).join(" ")}`;
        const { stdout } = await execAsync(renderedCommand, executionOptions);
        return stdout.trim();
    }

    const { stdout } = await execFileAsync(command, args, executionOptions);
    return stdout.trim();
}

export async function execJson(command, args, options = {}) {
    const renderedArgs = appendJsonOutput(args);

    try {
        const output = await execText(command, renderedArgs, options);
        if (!output) {
            return null;
        }

        return JSON.parse(output);
    }
    catch (error) {
        const output = [error?.stdout, error?.stderr]
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
            .join("\n");
        const renderedCommand = `${command} ${renderedArgs.join(" ")}`;
        throw new Error(output ? `${renderedCommand}\n${output}` : renderedCommand);
    }
}

function pushOptionalFlag(args, flagName, value) {
    if (value === undefined || value === null || value === "") {
        return;
    }

    args.push(flagName, String(value));
}

function appendDetectArgs(args, options = {}) {
    if (!options.organization || !options.project) {
        args.push("--detect", "true");
    }
}

function parseHttpsPullRequestUrl(parsedUrl) {
    const hostName = parsedUrl.hostname.toLowerCase();
    const pathParts = parsedUrl.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
    const pullRequestIndex = pathParts.findIndex((part) => part.toLowerCase() === "pullrequest");
    const gitIndex = pathParts.findIndex((part) => part.toLowerCase() === "_git");

    if (pullRequestIndex < 0 || pullRequestIndex + 1 >= pathParts.length || gitIndex < 0 || gitIndex + 1 >= pathParts.length) {
        return null;
    }

    const pullRequestId = Number(pathParts[pullRequestIndex + 1]);
    if (!Number.isInteger(pullRequestId)) {
        return null;
    }

    if (hostName === "dev.azure.com" && gitIndex === 2 && pathParts.length >= 5) {
        return {
            organization: `${parsedUrl.protocol}//${parsedUrl.host}/${pathParts[0]}`,
            project: pathParts[1],
            repository: pathParts[gitIndex + 1],
            pullRequestId,
            pullRequestUrl: parsedUrl.toString(),
        };
    }

    if (hostName.endsWith(".visualstudio.com") && gitIndex === 1 && pathParts.length >= 4) {
        return {
            organization: `${parsedUrl.protocol}//${parsedUrl.host}`,
            project: pathParts[0],
            repository: pathParts[gitIndex + 1],
            pullRequestId,
            pullRequestUrl: parsedUrl.toString(),
        };
    }

    return null;
}

export function parsePullRequestUrl(pullRequestUrl) {
    if (!pullRequestUrl) {
        return null;
    }

    try {
        return parseHttpsPullRequestUrl(new URL(pullRequestUrl));
    }
    catch {
        return null;
    }
}

export function buildPullRequestWebUrl({ organization, project, repository, pullRequestId }) {
    if (!organization || !project || !repository || !pullRequestId) {
        return null;
    }

    return `${organization.replace(/\/$/, "")}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${encodeURIComponent(String(pullRequestId))}`;
}

export async function getCurrentBranchName(cwd) {
    return await execText("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
}

export function toSourceRefName(branchOrRef) {
    if (!branchOrRef) {
        return null;
    }

    if (branchOrRef.startsWith("refs/")) {
        return branchOrRef;
    }

    return `refs/heads/${branchOrRef}`;
}

export async function getGitRemoteUrl(cwd) {
    try {
        return await execText("git", ["remote", "get-url", "origin"], { cwd });
    }
    catch {
        return null;
    }
}

function parseHttpsAdoRemoteUrl(remoteUrl) {
    let parsedUrl;

    try {
        parsedUrl = new URL(remoteUrl);
    }
    catch {
        return null;
    }

    const hostName = parsedUrl.hostname.toLowerCase();
    const pathParts = parsedUrl.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
    const gitIndex = pathParts.findIndex((part) => part.toLowerCase() === "_git");

    if (gitIndex < 0 || gitIndex + 1 >= pathParts.length) {
        return null;
    }

    if (hostName === "dev.azure.com" && gitIndex === 2 && pathParts.length >= 4) {
        return {
            organization: `${parsedUrl.protocol}//${parsedUrl.host}/${pathParts[0]}`,
            project: pathParts[1],
            repository: pathParts[gitIndex + 1],
        };
    }

    if (hostName.endsWith(".visualstudio.com") && gitIndex === 1 && pathParts.length >= 3) {
        return {
            organization: `${parsedUrl.protocol}//${parsedUrl.host}`,
            project: pathParts[0],
            repository: pathParts[gitIndex + 1],
        };
    }

    return null;
}

function parseSshAdoRemoteUrl(remoteUrl) {
    const trimmedRemoteUrl = String(remoteUrl ?? "").trim();

    const devAzureMatch = trimmedRemoteUrl.match(
        /^(?:ssh:\/\/)?(?:[^@]+@)?ssh\.dev\.azure\.com(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    );
    if (devAzureMatch) {
        return {
            organization: `https://dev.azure.com/${decodeURIComponent(devAzureMatch[1])}`,
            project: decodeURIComponent(devAzureMatch[2]),
            repository: decodeURIComponent(devAzureMatch[3]),
        };
    }

    const visualStudioMatch = trimmedRemoteUrl.match(
        /^(?:ssh:\/\/)?(?:[^@]+@)?vs-ssh\.visualstudio\.com(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    );
    if (visualStudioMatch) {
        return {
            organization: `https://${decodeURIComponent(visualStudioMatch[1])}.visualstudio.com`,
            project: decodeURIComponent(visualStudioMatch[2]),
            repository: decodeURIComponent(visualStudioMatch[3]),
        };
    }

    return null;
}

export function parseAdoRemoteUrl(remoteUrl) {
    if (!remoteUrl) {
        return null;
    }

    return parseHttpsAdoRemoteUrl(remoteUrl) ?? parseSshAdoRemoteUrl(remoteUrl);
}

export async function listPullRequestsBySourceBranch({ cwd, organization, project, repository, sourceRefName }) {
    const args = [
        "repos",
        "pr",
        "list",
        "--creator",
        "me",
        "--status",
        "active",
        "--top",
        "2",
        "--source-branch",
        sourceRefName,
    ];

    pushOptionalFlag(args, "--org", organization);
    pushOptionalFlag(args, "--project", project);
    pushOptionalFlag(args, "--repository", repository);
    appendDetectArgs(args, { organization, project });

    const result = await execJson("az", args, { cwd });
    return Array.isArray(result) ? result : [];
}

export async function fetchPullRequestSnapshot({ cwd, organization, pullRequestId }) {
    const args = ["repos", "pr", "show", "--id", String(pullRequestId)];
    pushOptionalFlag(args, "--org", organization);
    if (!organization) {
        args.push("--detect", "true");
    }
    return await execJson("az", args, { cwd });
}

export async function fetchPullRequestPolicies({ cwd, organization, pullRequestId }) {
    const args = ["repos", "pr", "policy", "list", "--id", String(pullRequestId)];
    pushOptionalFlag(args, "--org", organization);
    if (!organization) {
        args.push("--detect", "true");
    }

    const result = await execJson("az", args, { cwd });
    if (Array.isArray(result)) {
        return result;
    }

    return Array.isArray(result?.value) ? result.value : [];
}

export async function fetchPullRequestThreads({ cwd, organization, project, repositoryId, pullRequestId }) {
    const args = [
        "devops",
        "invoke",
        "--area",
        "git",
        "--resource",
        "pullRequestThreads",
        "--route-parameters",
        `project=${project}`,
        `repositoryId=${repositoryId}`,
        `pullRequestId=${pullRequestId}`,
        "--query-parameters",
        "api-version=7.1",
    ];

    pushOptionalFlag(args, "--org", organization);

    const result = await execJson("az", args, { cwd });
    if (Array.isArray(result)) {
        return result;
    }

    return Array.isArray(result?.value) ? result.value : [];
}

export function normalizeIdentity(identity) {
    return {
        id: identity?.id ?? null,
        uniqueName: String(identity?.uniqueName ?? "").trim().toLowerCase(),
        displayName: identity?.displayName ?? null,
    };
}

export function identityMatches(left, right) {
    if (!left || !right) {
        return false;
    }

    const normalizedLeft = normalizeIdentity(left);
    const normalizedRight = normalizeIdentity(right);

    if (normalizedLeft.id && normalizedRight.id && normalizedLeft.id === normalizedRight.id) {
        return true;
    }

    return Boolean(
        normalizedLeft.uniqueName
        && normalizedRight.uniqueName
        && normalizedLeft.uniqueName === normalizedRight.uniqueName,
    );
}

export function buildCommentKey(threadId, commentId) {
    return `${threadId}:${commentId}`;
}

function getThreadType(thread) {
    return thread?.properties?.CodeReviewThreadType?.$value
        ?? thread?.properties?.CodeReviewThreadType
        ?? null;
}

function getThreadFilePath(thread) {
    return thread?.threadContext?.filePath
        ?? thread?.pullRequestThreadContext?.filePath
        ?? null;
}

function getThreadLine(thread) {
    return thread?.threadContext?.rightFileStart?.line
        ?? thread?.threadContext?.rightFileEnd?.line
        ?? thread?.pullRequestThreadContext?.changeTrackingId
        ?? null;
}

export function collectTrackedComments(threads, watchedBy, ignoreSystemThreads = true) {
    const trackedComments = [];

    for (const thread of Array.isArray(threads) ? threads : []) {
        const threadType = getThreadType(thread);
        const comments = Array.isArray(thread?.comments) ? thread.comments : [];

        for (const comment of comments) {
            const author = normalizeIdentity(comment?.author);

            if (identityMatches(author, watchedBy)) {
                continue;
            }

            if ((comment?.commentType ?? "").toLowerCase() === "system") {
                continue;
            }

            if (ignoreSystemThreads && threadType) {
                continue;
            }

            trackedComments.push({
                key: buildCommentKey(thread?.id, comment?.id),
                threadId: thread?.id ?? null,
                commentId: comment?.id ?? null,
                author,
                content: comment?.content ?? "",
                publishedDate: comment?.publishedDate ?? comment?.lastUpdatedDate ?? null,
                updatedDate: comment?.lastUpdatedDate ?? null,
                status: thread?.status ?? "unknown",
                threadType,
                filePath: getThreadFilePath(thread),
                line: getThreadLine(thread),
            });
        }
    }

    trackedComments.sort((left, right) => String(left.publishedDate ?? "").localeCompare(String(right.publishedDate ?? "")));
    return trackedComments;
}

export function getPolicyKey(policy) {
    return String(
        policy?.configuration?.id
        ?? policy?.evaluationId
        ?? `${policy?.configuration?.type?.id ?? "policy"}:${policy?.configuration?.type?.displayName ?? "unknown"}`,
    );
}

export function createBaselineState({ pullRequest, threads, policies, watchedBy, ignoreSystemThreads = true }) {
    const trackedComments = collectTrackedComments(threads, watchedBy, ignoreSystemThreads);
    const reviewerVotes = {};

    for (const reviewer of Array.isArray(pullRequest?.reviewers) ? pullRequest.reviewers : []) {
        if (identityMatches(reviewer, watchedBy)) {
            continue;
        }

        reviewerVotes[String(reviewer.id)] = Number(reviewer.vote ?? 0);
    }

    const policyStates = {};
    for (const policy of Array.isArray(policies) ? policies : []) {
        policyStates[getPolicyKey(policy)] = {
            status: String(policy?.status ?? "").toLowerCase(),
            evaluationId: policy?.evaluationId ?? null,
            completedDate: policy?.completedDate ?? null,
        };
    }

    return {
        seenCommentKeys: trackedComments.map((comment) => comment.key),
        reviewerVotes,
        policyStates,
        lastKnownStatus: String(pullRequest?.status ?? "").toLowerCase(),
        lastKnownIsDraft: Boolean(pullRequest?.isDraft),
        lastSourceCommitId: pullRequest?.lastMergeSourceCommit?.commitId ?? null,
    };
}

export function formatTimestamp(timestamp) {
    if (!timestamp) {
        return "never";
    }

    const parsedTimestamp = Date.parse(timestamp);
    if (Number.isNaN(parsedTimestamp)) {
        return String(timestamp);
    }

    return new Date(parsedTimestamp).toISOString();
}
