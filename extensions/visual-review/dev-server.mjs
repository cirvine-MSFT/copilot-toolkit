#!/usr/bin/env node

// Dev server launcher for the visual-review extension.
//
// Starts server-worker.mjs directly (no Copilot CLI host required) on a fixed
// port so the UI can be opened in a browser for manual or automated testing.
//
// Usage:
//   node dev-server.mjs [dark|light]           — uses git branch diff
//   node dev-server.mjs [dark|light] --fixture — uses synthetic diff from test-fixtures/

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    createServerId,
    ensureStateDirs,
    getServerStatePath,
    writeJsonAtomic,
    waitForWorkerHealth,
} from "./common.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const extensionDir = dirname(__filename);
const workerPath = join(extensionDir, "server-worker.mjs");
const fixtureDir = join(extensionDir, "test-fixtures");

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const theme = ["dark", "light"].includes(args[0]) ? args[0] : "dark";
const useFixture = args.includes("--fixture");

const PORT = 4242;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const serverId = createServerId();
    ensureStateDirs();
    const statePath = getServerStatePath(serverId);
    const url = `http://127.0.0.1:${PORT}`;

    const now = new Date().toISOString();

    await writeJsonAtomic(statePath, {
        schemaVersion: 1,
        serverId,
        sessionId: "dev-session",
        createdAt: now,
        updatedAt: now,
        status: "active",
        stopRequested: false,
        port: PORT,
        cwd: process.cwd(),
        theme,
        scope: useFixture ? "unstaged" : "branch",
        base: "main",
        url,
        worker: { pid: null, startedAt: null },
        connectedClients: 0,
    });

    if (useFixture) {
        injectFixtureDiff(statePath);
    }

    console.log(`Starting visual-review dev server (${theme} theme)…`);
    console.log(`  Worker:  ${workerPath}`);
    console.log(`  State:   ${statePath}`);
    console.log(`  Fixture: ${useFixture}`);
    console.log();

    // Use process.execPath directly — this script is run with `node`, not
    // the Copilot CLI binary.
    const child = spawn(process.execPath, [workerPath, statePath], {
        cwd: process.cwd(),
        stdio: ["ignore", "inherit", "inherit"],
    });

    child.on("exit", (code) => {
        console.error(`Worker exited with code ${code}`);
        process.exit(code ?? 1);
    });

    // Wait for the server to become healthy
    const health = await waitForWorkerHealth({
        stateFilePath: statePath,
        url,
        serverId,
        timeoutMs: 10_000,
    });

    if (health.healthy) {
        console.log(`✔ Dev server running at ${url}`);
        console.log(`  Open in browser: ${url}`);
        console.log(`  Health check:    ${url}/health`);
        console.log();
        console.log("Press Ctrl+C to stop.");
    } else {
        console.error(`✖ Server failed to start: ${health.reason}`);
        child.kill();
        process.exit(1);
    }

    // Keep running until Ctrl+C
    const shutdown = () => {
        console.log("\nShutting down…");
        child.kill();
        // Give worker a moment to clean up
        setTimeout(() => process.exit(0), 500);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Fixture diff injection
//
// When --fixture is used, we don't rely on git. Instead we generate a unified
// diff from the test-fixtures/ files and monkey-patch the server state so the
// worker's `git diff` will see unstaged changes. However, since the worker
// actually runs `git diff` itself, we instead print instructions and rely on
// the worker's error-tolerant diff path to show an empty diff — the user can
// stage real changes or the screenshot script can POST a diff via the API.
//
// A better approach: generate the diff text here and print it so the user
// knows it is available. The dev-tools/screenshot.mjs script will push the
// fixture diff via the /api/diff endpoint or WebSocket.
// ---------------------------------------------------------------------------

function injectFixtureDiff(statePath) {
    const beforePath = join(fixtureDir, "sample-before.txt");
    const afterPath = join(fixtureDir, "sample-after.txt");

    try {
        readFileSync(beforePath, "utf8");
        readFileSync(afterPath, "utf8");
    } catch (err) {
        console.warn(`Warning: fixture files not found (${err.message})`);
        console.warn("The diff viewer will show the actual git diff instead.");
    }
}

main().catch((err) => {
    console.error(`Fatal: ${err.stack ?? err}`);
    process.exit(1);
});
