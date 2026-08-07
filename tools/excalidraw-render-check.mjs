#!/usr/bin/env node
/**
 * Contributor-only render check for the Excalidraw Workbench canvas.
 *
 * This is the ONLY check that actually proves the canvas renders. The unit tests
 * and the serve smoke test both pass against a runtime with no stylesheet,
 * because neither one paints pixels. Run this before accepting any webview
 * dependency update.
 *
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *   node tools/excalidraw-render-check.mjs
 *
 * Playwright is deliberately NOT a dependency of this repo, and this file lives
 * outside extensions/ so the install scripts never copy it into a user's
 * ~/.copilot/extensions directory.
 *
 * Options:
 *   --drawing <path>     drawing to open (default: examples/excalidraw/smoke-test.excalidraw)
 *   --screenshot <path>  where to write the screenshot
 *   --headed             show the browser
 *   --keep-open          leave the browser open until Ctrl+C, for eyeballing
 *
 * See https://github.com/cirvine-MSFT/copilot-toolkit/issues/30
 */

import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    closeWorkbenchServer,
    startWorkbenchServer,
} from "../extensions/excalidraw-workbench/server.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
    const options = {
        drawing: join(repoRoot, "examples", "excalidraw", "smoke-test.excalidraw"),
        screenshot: join(repoRoot, ".render-check", "canvas.png"),
        headed: false,
        keepOpen: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--drawing") {
            index += 1;
            options.drawing = resolve(argv[index]);
        } else if (arg === "--screenshot") {
            index += 1;
            options.screenshot = resolve(argv[index]);
        } else if (arg === "--headed") {
            options.headed = true;
        } else if (arg === "--keep-open") {
            options.keepOpen = true;
            options.headed = true;
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: node tools/excalidraw-render-check.mjs " +
                    "[--drawing <path>] [--screenshot <path>] [--headed] [--keep-open]",
            );
            process.exit(0);
        }
    }

    return options;
}

async function loadPlaywright() {
    try {
        return await import("playwright");
    } catch {
        console.error("Playwright is not available.");
        console.error("");
        console.error("It is deliberately not a dependency of this repo. Install it on demand:");
        console.error("  npm install --no-save playwright");
        console.error("  npx playwright install chromium");
        console.error("");
        console.error("Then re-run this script.");
        process.exit(2);
    }
}

const options = parseArgs(process.argv.slice(2));
const { chromium } = await loadPlaywright();

const workingDir = await mkdtemp(join(tmpdir(), "excalidraw-render-check-"));
const drawingCopy = join(workingDir, "render-check.excalidraw");
await copyFile(options.drawing, drawingCopy);

const entry = {
    filePath: drawingCopy,
    title: "Render check",
    displayPath: "render-check.excalidraw",
    apiToken: "render-check-token",
    commentState: { comments: [] },
};

const failures = [];
const consoleErrors = [];
const failedRequests = [];

const server = await startWorkbenchServer(entry, {});
Object.assign(entry, server);
console.log(`Serving ${options.drawing}`);
console.log(`  ${server.url}`);

const browser = await chromium.launch({ headless: !options.headed });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

page.on("console", (message) => {
    if (message.type() === "error") {
        consoleErrors.push(message.text());
    }
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("requestfailed", (request) => {
    // The /events SSE stream is long-lived and is always reported as aborted
    // when the page tears down. That is normal shutdown, not a failure.
    if (new URL(request.url()).pathname === "/events") {
        return;
    }
    failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText}`);
});
page.on("response", (response) => {
    if (response.status() >= 400) {
        failedRequests.push(`${response.status()} ${response.url()}`);
    }
});

try {
    await page.goto(server.url, { waitUntil: "networkidle", timeout: 30_000 });

    // 1. The Excalidraw canvas mounts and has real dimensions.
    try {
        await page.waitForSelector("canvas.excalidraw__canvas", { timeout: 20_000 });
        const box = await page.locator("canvas.excalidraw__canvas").first().boundingBox();
        if (!box || box.width < 100 || box.height < 100) {
            failures.push(`Excalidraw canvas has no meaningful size: ${JSON.stringify(box)}`);
        } else {
            console.log(`  canvas mounted (${Math.round(box.width)}x${Math.round(box.height)})`);
        }
    } catch {
        failures.push("Excalidraw canvas element never mounted");
    }

    // 2. The toolbar renders with real height. This is the CSS proof: without the
    //    stylesheet the island collapses even though the DOM nodes exist. This is
    //    exactly how the 0.18 upgrade broke the canvas.
    try {
        await page.waitForSelector(".App-toolbar, .Island", { timeout: 10_000 });
        const box = await page.locator(".App-toolbar, .Island").first().boundingBox();
        if (!box || box.height < 20) {
            failures.push(
                `Toolbar has no height (${JSON.stringify(box)}) — the stylesheet almost ` +
                    "certainly failed to load",
            );
        } else {
            console.log(`  toolbar rendered (${Math.round(box.width)}x${Math.round(box.height)})`);
        }
    } catch {
        failures.push("Excalidraw toolbar never rendered — stylesheet likely missing");
    }

    // 3. Web fonts actually resolved from the copied asset bundle.
    const fontsLoaded = await page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].filter((font) => font.status === "loaded").length;
    });
    if (fontsLoaded === 0) {
        console.warn("  warning: no web fonts reported as loaded");
    } else {
        console.log(`  ${fontsLoaded} font face(s) loaded`);
    }

    // 4. The error boundary did not trip.
    const alerts = await page.locator("[role='alert']").allTextContents();
    if (alerts.length > 0) {
        failures.push(`error boundary tripped: ${alerts.join(" | ")}`);
    }

    await mkdir(dirname(options.screenshot), { recursive: true });
    await page.screenshot({ path: options.screenshot });
    console.log(`  screenshot: ${options.screenshot}`);

    if (options.keepOpen) {
        console.log("\n--keep-open set; press Ctrl+C to exit.");
        await new Promise(() => {});
    }
} finally {
    if (!options.keepOpen) {
        await browser.close();
        await closeWorkbenchServer(entry);
        await rm(workingDir, { recursive: true, force: true });
    }
}

if (consoleErrors.length > 0) {
    failures.push(`console errors:\n    ${consoleErrors.join("\n    ")}`);
}
if (failedRequests.length > 0) {
    failures.push(`failed requests:\n    ${failedRequests.join("\n    ")}`);
}

if (failures.length > 0) {
    console.error("\nRender check FAILED:");
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    console.error("\nDo not ship this runtime.");
    process.exit(1);
}

console.log("\nRender check passed.");
