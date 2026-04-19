// Shared Node.js binary resolution for watcher extensions.
//
// process.execPath may point to the Copilot CLI binary (e.g. copilot.exe)
// rather than a raw Node.js binary, in which case it cannot run .mjs scripts
// directly. We probe process.execPath first, and fall back to `node` on PATH.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cachedNodeBinary = null;

async function probeNode(binaryPath) {
    try {
        const { stdout } = await execFileAsync(
            binaryPath,
            ["-e", "process.stdout.write('node-ok')"],
            { timeout: 3000 },
        );
        return stdout.trim() === "node-ok";
    } catch {
        return false;
    }
}

/**
 * Resolve a Node.js binary suitable for spawning worker processes.
 * Probes process.execPath first, then falls back to `node` on PATH.
 *
 * @returns {Promise<string>} Path to a working Node.js binary
 */
export async function resolveNodeBinary() {
    if (cachedNodeBinary) {
        return cachedNodeBinary;
    }

    // Probe process.execPath — works when CLI bundles Node directly
    if (await probeNode(process.execPath)) {
        cachedNodeBinary = process.execPath;
        return cachedNodeBinary;
    }

    // Fall back to `node` on PATH
    const nodeCmd = process.platform === "win32" ? "node.exe" : "node";
    try {
        const whichCmd = process.platform === "win32" ? "where.exe" : "which";
        const { stdout } = await execFileAsync(whichCmd, [nodeCmd], { timeout: 5000 });
        const nodePath = stdout.trim().split(/\r?\n/)[0];
        if (nodePath && await probeNode(nodePath)) {
            cachedNodeBinary = nodePath;
            return cachedNodeBinary;
        }
    } catch {
        // where/which failed — node not on PATH
    }

    throw new Error(
        "Cannot find a Node.js binary for worker spawning. " +
        "process.execPath points to the Copilot CLI, and 'node' is not on PATH.",
    );
}
