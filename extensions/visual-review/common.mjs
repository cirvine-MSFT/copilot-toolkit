import crypto from "node:crypto";
import { exec } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const maxBuffer = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// State directory management
// ---------------------------------------------------------------------------

export function getStateDirectory() {
    return path.join(os.homedir(), ".copilot", "visual-review");
}

export function ensureStateDirs() {
    const root = getStateDirectory();
    const serversDir = path.join(root, "servers");
    const eventsDir = path.join(root, "events");
    const vizDir = path.join(root, "viz");

    mkdirSync(serversDir, { recursive: true });
    mkdirSync(eventsDir, { recursive: true });
    mkdirSync(vizDir, { recursive: true });

    return { root, serversDir, eventsDir, vizDir };
}

export function getServerStatePath(serverId) {
    const { serversDir } = ensureStateDirs();
    return path.join(serversDir, `${serverId}.json`);
}

export function getEventFilePath(eventId) {
    const { eventsDir } = ensureStateDirs();
    return path.join(eventsDir, `${eventId}.json`);
}

// ---------------------------------------------------------------------------
// JSON I/O
// ---------------------------------------------------------------------------

export async function writeJsonAtomic(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const content = `${JSON.stringify(value, null, 2)}\n`;

    await fs.writeFile(tempFilePath, content, "utf8");

    try {
        await fs.rename(tempFilePath, filePath);
    } catch (error) {
        if (!["EEXIST", "EPERM", "EACCES"].includes(String(error?.code ?? ""))) {
            await fs.rm(tempFilePath, { force: true }).catch(() => {});
            throw error;
        }

        try {
            await fs.copyFile(tempFilePath, filePath);
        } finally {
            await fs.rm(tempFilePath, { force: true }).catch(() => {});
        }
    }
}

export async function readJsonFile(filePath) {
    try {
        const content = await fs.readFile(filePath, "utf8");
        return JSON.parse(content);
    } catch (error) {
        if (error?.code === "ENOENT") {
            return null;
        }

        throw error;
    }
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

// ---------------------------------------------------------------------------
// Timestamps and IDs
// ---------------------------------------------------------------------------

export function nowIso() {
    return new Date().toISOString();
}

export function createServerId() {
    return `vr-${crypto.randomUUID()}`;
}

export function createEventId() {
    return `evt-${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export function formatError(error) {
    if (!error) {
        return "Unknown error";
    }

    return String(error?.message ?? error).trim();
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

export async function getDiffOutput(cwd, scope, base) {
    let command;

    switch (scope) {
        case "staged":
            command = "git diff --cached";
            break;
        case "unstaged":
            command = "git diff";
            break;
        case "branch":
        default:
            command = `git diff ${shellQuote(base)}..HEAD`;
            break;
    }

    try {
        const { stdout } = await execAsync(command, { cwd, maxBuffer });
        return stdout;
    } catch (error) {
        throw new Error(`Failed to get diff (${scope}): ${formatError(error)}`);
    }
}

export async function getChangedFiles(cwd, scope, base) {
    let command;

    switch (scope) {
        case "staged":
            command = "git diff --cached --name-status";
            break;
        case "unstaged":
            command = "git diff --name-status";
            break;
        case "branch":
        default:
            command = `git diff ${shellQuote(base)}..HEAD --name-status`;
            break;
    }

    try {
        const { stdout } = await execAsync(command, { cwd, maxBuffer });
        return stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const [status, ...rest] = line.split("\t");
                return { status: status.trim(), filePath: rest.join("\t").trim() };
            });
    } catch (error) {
        throw new Error(`Failed to list changed files: ${formatError(error)}`);
    }
}

export async function getFileContent(cwd, filePath, ref) {
    const refSpec = ref ?? "HEAD";
    const target = shellQuote(`${refSpec}:${filePath}`);
    const command = `git show ${target}`;

    try {
        const { stdout } = await execAsync(command, { cwd, maxBuffer });
        return stdout;
    } catch (error) {
        throw new Error(`Failed to get file content for ${filePath}@${refSpec}: ${formatError(error)}`);
    }
}

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Port management
// ---------------------------------------------------------------------------

export function findFreePort(preferredPort) {
    return new Promise((resolve, reject) => {
        const server = createServer();

        server.on("error", (error) => {
            if (error?.code === "EADDRINUSE" && preferredPort !== 0) {
                // Preferred port in use — fall back to auto-select
                findFreePort(0).then(resolve, reject);
            } else {
                reject(error);
            }
        });

        server.listen(preferredPort, "127.0.0.1", () => {
            const address = server.address();
            const port = address.port;
            server.close(() => resolve(port));
        });
    });
}

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

export function openBrowser(url) {
    const platform = process.platform;

    if (platform === "win32") {
        exec(`start "" "${url}"`);
    } else if (platform === "darwin") {
        exec(`open "${url}"`);
    } else {
        exec(`xdg-open "${url}"`);
    }
}

export function isProcessAlive(pid) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) {
        return false;
    }

    try {
        process.kill(numericPid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}
