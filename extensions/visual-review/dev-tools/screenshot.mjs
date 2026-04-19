#!/usr/bin/env node

// Capture a screenshot of the visual-review web UI.
//
// Prerequisites:
//   1. npm install            (in this dev-tools/ directory)
//   2. npx playwright install chromium
//   3. Start the dev server:  node ../dev-server.mjs
//
// Usage:
//   node screenshot.mjs                        — default 1280×800
//   node screenshot.mjs --width 1920 --height 1080
//   node screenshot.mjs --output my-shot.png
//   node screenshot.mjs --wait-for ".d2h-wrapper"  — custom selector

import { chromium } from "@playwright/test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = join(__dirname, "..", "test-fixtures", "screenshot.png");

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = argv.slice(2);
    const opts = {
        url: "http://127.0.0.1:4242",
        width: 1280,
        height: 800,
        output: DEFAULT_OUTPUT,
        waitFor: ".d2h-wrapper",
        timeout: 30_000,
        fullPage: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--url":
                opts.url = args[++i];
                break;
            case "--width":
                opts.width = parseInt(args[++i], 10);
                break;
            case "--height":
                opts.height = parseInt(args[++i], 10);
                break;
            case "--output":
                opts.output = resolve(args[++i]);
                break;
            case "--wait-for":
                opts.waitFor = args[++i];
                break;
            case "--timeout":
                opts.timeout = parseInt(args[++i], 10);
                break;
            case "--full-page":
                opts.fullPage = true;
                break;
            default:
                break;
        }
    }

    return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const opts = parseArgs(process.argv);

    console.log(`Capturing screenshot of ${opts.url}`);
    console.log(`  Viewport: ${opts.width}×${opts.height}`);
    console.log(`  Wait for: ${opts.waitFor}`);
    console.log(`  Output:   ${opts.output}`);
    console.log();

    const browser = await chromium.launch({ headless: true });

    try {
        const context = await browser.newContext({
            viewport: { width: opts.width, height: opts.height },
            colorScheme: "dark",
        });
        const page = await context.newPage();

        await page.goto(opts.url, { waitUntil: "domcontentloaded" });

        // Wait for the WebSocket to connect and deliver diff data.
        // The app shows "Connected" once the WS is open and renders diff
        // content into a .d2h-wrapper element.  We try the requested
        // selector first, then fall back to the connection indicator.
        try {
            await page.waitForSelector(opts.waitFor, { timeout: opts.timeout });
            console.log(`✔ Selector "${opts.waitFor}" found`);
        } catch {
            console.warn(`⚠ Selector "${opts.waitFor}" not found within ${opts.timeout}ms`);
            // Fall back — at least wait for the header to be present
            try {
                await page.waitForSelector(".vr-header", { timeout: 3000 });
            } catch { /* take whatever we have */ }
            console.warn("  Taking screenshot of current state anyway.");
        }

        // Extra settle time for diff2html rendering + CSS transitions
        await page.waitForTimeout(1500);

        await page.screenshot({
            path: opts.output,
            fullPage: opts.fullPage,
        });

        console.log(`✔ Screenshot saved to ${opts.output}`);
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error(`Screenshot failed: ${err.stack ?? err}`);
    process.exit(1);
});
