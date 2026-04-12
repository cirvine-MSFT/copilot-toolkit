import { exec, execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const maxBuffer = 16 * 1024 * 1024;
const defaultWindowsAzPath = "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd";
const windowsAzCommand = existsSync(defaultWindowsAzPath) ? defaultWindowsAzPath : "az.cmd";

export function ensureStateDirs() {
    const root = join(homedir(), ".copilot", "build-watcher");
    const watchersDir = join(root, "watchers");
    const eventsDir = join(root, "events");

    mkdirSync(watchersDir, { recursive: true });
    mkdirSync(eventsDir, { recursive: true });

    return {
        root,
        watchersDir,
        eventsDir,
    };
}

export function listJsonFilePaths(directoryPath) {
    if (!existsSync(directoryPath)) {
        return [];
    }

    return readdirSync(directoryPath)
        .filter((entry) => entry.toLowerCase().endsWith(".json"))
        .map((entry) => join(directoryPath, entry))
        .sort();
}

export function readJson(filePath) {
    return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function nowIso() {
    return new Date().toISOString();
}

export function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function makeWatcherId(runId) {
    return `bw-${runId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeOptionalString(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const text = String(value).trim();
    return text.length > 0 ? text : null;
}

export function normalizeOrganizationUrl(value) {
    const text = normalizeOptionalString(value);
    return text ? text.replace(/\/+$/, "") : null;
}

export function normalizePollIntervalSeconds(value) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) {
        return 60;
    }

    return Math.min(Math.max(numeric, 15), 300);
}

export function resolveRunReference(options) {
    if (/^\d+$/.test(options.run)) {
        return {
            runId: Number(options.run),
            organizationUrl: options.organizationUrl,
            project: options.project,
        };
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(options.run);
    } catch {
        throw new Error(
            "Run reference must be a numeric run ID or an Azure DevOps build URL such as _build/results?buildId=12345.",
        );
    }

    const detectedContext = extractContextFromUrl(parsedUrl.toString());
    const runId = extractRunIdFromUrl(parsedUrl);

    if (!runId) {
        throw new Error(`Could not find a build ID in URL: ${options.run}`);
    }

    return {
        runId,
        organizationUrl: options.organizationUrl ?? detectedContext.organizationUrl,
        project: options.project ?? detectedContext.project,
    };
}

export async function fetchRun(runId, context, cwd = process.cwd()) {
    return runAzJson(buildRunsShowArgs(runId, context), cwd);
}

export function extractRunSummary(run, context) {
    const inferredContext = extractContextFromRun(run);
    const organizationUrl = context.organizationUrl ?? inferredContext.organizationUrl;
    const project = context.project ?? inferredContext.project;
    const runId = parseNumberLike(firstDefined(run?.id, run?.run?.id));
    const pipeline = run?.pipeline ?? run?.definition ?? {};
    const status = normalizeOptionalString(firstDefined(run?.status, run?.state));
    const state = normalizeOptionalString(run?.state);
    const result = normalizeOptionalString(run?.result);

    return {
        runId,
        organizationUrl,
        project,
        pipelineId: parseNumberLike(firstDefined(pipeline?.id, run?.pipelineId)),
        pipelineName: firstDefined(pipeline?.name, run?.definition?.name, "Unknown pipeline"),
        buildNumber: firstDefined(run?.name, run?.buildNumber, `Run ${runId}`),
        branch: normalizeBranch(
            firstDefined(run?.sourceBranch, run?.resources?.repositories?.self?.refName, run?.repository?.refName),
        ),
        commit: normalizeOptionalString(
            firstDefined(run?.sourceVersion, run?.resources?.repositories?.self?.version, run?.repository?.version),
        ),
        status,
        state,
        result,
        createdAt: firstDefined(run?.createdDate, run?.queueTime, run?.queuedDate, run?.startTime),
        finishedAt: firstDefined(run?.finishedDate, run?.finishTime, run?.completedDate),
        resultsUrl: firstDefined(run?._links?.web?.href, buildResultsUrl(organizationUrl, project, runId)),
        terminal: isTerminalRunState(status, state, result),
        terminalStatus: determineTerminalStatus(status, state, result),
        displayStatus: buildDisplayStatus(status, state, result),
    };
}

export function formatError(error) {
    if (!error) {
        return "Unknown error";
    }

    return String(error?.message ?? error).trim();
}

function extractRunIdFromUrl(url) {
    const direct = url.searchParams.get("buildId") ?? url.searchParams.get("runId");
    if (direct && /^\d+$/.test(direct)) {
        return Number(direct);
    }

    const pathMatch = url.pathname.match(/\/builds\/(\d+)(?:\/|$)/i);
    if (pathMatch) {
        return Number(pathMatch[1]);
    }

    return null;
}

function extractContextFromUrl(urlString) {
    try {
        const url = new URL(urlString);
        const rawParts = url.pathname.split("/").filter(Boolean);

        if (url.hostname === "dev.azure.com" && rawParts.length >= 2) {
            return {
                organizationUrl: `${url.origin}/${rawParts[0]}`,
                project: decodeURIComponent(rawParts[1]),
            };
        }

        if (url.hostname.endsWith(".visualstudio.com") && rawParts.length >= 1) {
            return {
                organizationUrl: url.origin,
                project: decodeURIComponent(rawParts[0]),
            };
        }
    } catch {
        return { organizationUrl: null, project: null };
    }

    return { organizationUrl: null, project: null };
}

function extractContextFromRun(run) {
    return extractContextFromUrl(
        firstDefined(run?.url, run?._links?.web?.href, run?._links?.self?.href) ?? "",
    );
}

function normalizeBranch(branch) {
    const text = normalizeOptionalString(branch);
    return text ? text.replace(/^refs\/heads\//, "") : null;
}

function parseNumberLike(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
}

function buildResultsUrl(organizationUrl, project, runId) {
    if (!organizationUrl || !project || runId === null) {
        return null;
    }

    return `${organizationUrl}/${encodeURIComponent(project)}/_build/results?buildId=${runId}&view=results`;
}

function buildDisplayStatus(status, state, result) {
    const parts = [result, status, state].filter(Boolean);
    return parts.length > 0 ? parts.join(" / ") : "unknown";
}

function determineTerminalStatus(status, state, result) {
    const statusText = `${status ?? ""} ${state ?? ""}`.toLowerCase();
    const resultText = String(result ?? "").toLowerCase();

    if (!isTerminalRunState(status, state, result)) {
        return "active";
    }

    if (resultText.includes("partial")) {
        return "partially_succeeded";
    }

    if (resultText.includes("succeed")) {
        return "succeeded";
    }

    if (resultText.includes("fail")) {
        return "failed";
    }

    if (resultText.includes("cancel")) {
        return "canceled";
    }

    if (statusText.includes("cancel")) {
        return "canceled";
    }

    return "completed";
}

function isTerminalRunState(status, state, result) {
    if (normalizeOptionalString(result)) {
        return true;
    }

    const combined = `${status ?? ""} ${state ?? ""}`.toLowerCase();

    return ["completed", "complete", "finished", "cancelled", "canceled"].some((token) =>
        combined.includes(token),
    );
}

async function runAzJson(args, cwd) {
    try {
        const stdout = process.platform === "win32"
            ? await runAzJsonOnWindows(args, cwd)
            : await runAzJsonOnPosix(args, cwd);

        if (!stdout || !stdout.trim()) {
            throw new Error("Command returned no JSON output.");
        }

        return JSON.parse(stdout);
    } catch (error) {
        const output = [error?.stdout, error?.stderr]
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
            .join("\n");

        const rendered = renderAzArgs(args);
        throw new Error(output ? `${rendered}\n${output}` : rendered);
    }
}

async function runAzJsonOnWindows(args, cwd) {
    const command = `${quoteWindowsArg(windowsAzCommand)} ${args.map(quoteWindowsArg).join(" ")}`;
    const { stdout } = await execAsync(command, {
        cwd,
        encoding: "utf8",
        maxBuffer,
        windowsHide: true,
    });

    return stdout;
}

async function runAzJsonOnPosix(args, cwd) {
    const { stdout } = await execFileAsync("az", args, {
        cwd,
        encoding: "utf8",
        maxBuffer,
        windowsHide: true,
    });

    return stdout;
}

function buildRunsShowArgs(runId, context) {
    const args = [
        "pipelines",
        "runs",
        "show",
        "--id",
        String(runId),
        "--output",
        "json",
        "--only-show-errors",
    ];

    if (context.organizationUrl) {
        args.push("--org", String(context.organizationUrl));
    }

    if (context.project) {
        args.push("--project", String(context.project));
    }

    if (!context.organizationUrl || !context.project) {
        args.push("--detect", "true");
    }

    return args;
}

function quoteWindowsArg(value) {
    const text = String(value);
    if (text.length === 0) {
        return '""';
    }

    if (!/[\s"&|<>^()]/.test(text)) {
        return text;
    }

    return `"${text.replace(/"/g, '\\"')}"`;
}

function renderAzArgs(args) {
    return `az ${args.join(" ")}`;
}
