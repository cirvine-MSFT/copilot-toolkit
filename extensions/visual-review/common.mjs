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
// Node.js binary resolution for worker spawning
// ---------------------------------------------------------------------------

let cachedNodeBinary = null;

/**
 * Resolve a Node.js binary suitable for spawning worker processes.
 *
 * process.execPath may point to the Copilot CLI binary (e.g. copilot.exe)
 * rather than a raw Node.js binary, in which case it cannot run .mjs scripts
 * directly. We probe process.execPath first, and fall back to `node` on PATH.
 *
 * @returns {Promise<string>} Path to a working Node.js binary
 */
export async function resolveNodeBinary() {
    if (cachedNodeBinary) {
        return cachedNodeBinary;
    }

    // Probe process.execPath — does it behave as a Node binary?
    if (await probeNode(process.execPath)) {
        cachedNodeBinary = process.execPath;
        return cachedNodeBinary;
    }

    // Fall back to `node` on PATH
    const nodeCmd = process.platform === "win32" ? "node.exe" : "node";
    try {
        const { stdout } = await execAsync(
            process.platform === "win32" ? `where.exe ${nodeCmd}` : `which ${nodeCmd}`,
            { timeout: 5000 },
        );
        const nodePath = stdout.trim().split(/\r?\n/)[0];
        if (nodePath && await probeNode(nodePath)) {
            cachedNodeBinary = nodePath;
            return cachedNodeBinary;
        }
    } catch {
        // `where` / `which` failed — node not on PATH
    }

    throw new Error(
        "Cannot find a Node.js binary for worker spawning. " +
        "process.execPath points to the Copilot CLI, and 'node' is not on PATH.",
    );
}

async function probeNode(binaryPath) {
    try {
        const { stdout } = await execAsync(
            `"${binaryPath}" -e "process.stdout.write('node-ok')"`,
            { timeout: 3000 },
        );
        return stdout.trim() === "node-ok";
    } catch {
        return false;
    }
}

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

// ---------------------------------------------------------------------------
// Worker log files
// ---------------------------------------------------------------------------

export function getWorkerLogPath(serverId) {
    const { root } = ensureStateDirs();
    return path.join(root, "logs", `${serverId}.log`);
}

export function ensureLogDir() {
    const logDir = path.join(getStateDirectory(), "logs");
    mkdirSync(logDir, { recursive: true });
    return logDir;
}

// ---------------------------------------------------------------------------
// Worker health checking
// ---------------------------------------------------------------------------

/**
 * Poll the worker state file and HTTP /health endpoint until the worker is
 * confirmed healthy, or the timeout is exceeded.
 *
 * @param {object} opts
 * @param {string} opts.stateFilePath - Path to the server state JSON file
 * @param {string} opts.url - Base URL of the worker (e.g. http://127.0.0.1:PORT)
 * @param {string} opts.serverId - Expected server ID (verified against /health response)
 * @param {number} [opts.timeoutMs=8000] - Maximum time to wait
 * @param {number} [opts.pollMs=300] - Polling interval
 * @returns {Promise<{healthy: boolean, reason?: string}>}
 */
export async function waitForWorkerHealth({
    stateFilePath,
    url,
    serverId,
    timeoutMs = 8000,
    pollMs = 300,
}) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        // Check if the worker process is still alive via state file
        let state;
        try {
            state = await readJsonFile(stateFilePath);
        } catch {
            // Transient read/parse error — retry
        }

        if (state) {
            // Worker wrote an error status — bail early
            if (state.status === "error") {
                return {
                    healthy: false,
                    reason: `Worker reported error: ${state.error ?? "unknown"}`,
                };
            }

            // Worker process died before reaching "running" state
            if (state.worker?.pid && !isProcessAlive(state.worker.pid)) {
                return {
                    healthy: false,
                    reason: `Worker process (PID ${state.worker.pid}) exited prematurely`,
                };
            }

            // Worker is running — verify via HTTP
            if (state.status === "running") {
                const httpResult = await httpHealthCheck(url, serverId);
                if (httpResult.healthy) {
                    return { healthy: true };
                }
                // HTTP not yet responsive — keep polling briefly
            }
        }

        await sleep(pollMs);
    }

    return { healthy: false, reason: "Timed out waiting for worker to become healthy" };
}

/**
 * HTTP GET to /health, verifying the expected serverId.
 * @param {string} baseUrl
 * @param {string} expectedServerId
 * @returns {Promise<{healthy: boolean, reason?: string}>}
 */
export async function httpHealthCheck(baseUrl, expectedServerId) {
    const { get } = await import("node:http");

    return new Promise((resolve) => {
        const req = get(`${baseUrl}/health`, { timeout: 2000 }, (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => {
                try {
                    const data = JSON.parse(body);
                    if (data.serverId !== expectedServerId) {
                        resolve({
                            healthy: false,
                            reason: `Server ID mismatch: expected ${expectedServerId}, got ${data.serverId}`,
                        });
                        return;
                    }
                    resolve({ healthy: true });
                } catch {
                    resolve({ healthy: false, reason: "Invalid health response" });
                }
            });
        });

        req.on("error", () => {
            resolve({ healthy: false, reason: "HTTP connection failed" });
        });

        req.on("timeout", () => {
            req.destroy();
            resolve({ healthy: false, reason: "HTTP health check timed out" });
        });
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
