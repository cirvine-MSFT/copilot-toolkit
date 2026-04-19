#!/usr/bin/env node

// Comprehensive diagnostic script for the visual-review extension web UI.
//
// Starts the dev server, launches headless Chromium via Playwright, and runs
// a battery of checks against the rendered UI.  Results are printed as JSON.
//
// Prerequisites:
//   npm install            (in this dev-tools/ directory)
//   npx playwright install chromium
//
// Usage:
//   node diagnose.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(__dirname, "..");
const repoRoot = join(extensionDir, "..", "..");
const devServerScript = join(extensionDir, "dev-server.mjs");
const fixturesDir = join(extensionDir, "test-fixtures");
const DEV_URL = "http://127.0.0.1:4242";

// Ensure fixtures dir exists for screenshots
mkdirSync(fixturesDir, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────

/** Poll a URL until it returns 200 or timeout. */
async function waitForHealth(url, timeoutMs = 15_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${url}/health`);
            if (res.ok) return true;
        } catch { /* server not up yet */ }
        await sleep(500);
    }
    return false;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
    const findings = {
        consoleMessages: [],
        tabVisibility: null,
        lineNumberCells: null,
        hoverTest: null,
        clickTest: null,
        overlapCheck: null,
        headerLayout: null,
        screenshots: [],
        errors: [],
    };

    // 1. Start dev server
    console.error("Starting dev server…");
    const server = spawn(process.execPath, [devServerScript], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });

    let serverOutput = "";
    server.stdout.on("data", (d) => { serverOutput += d.toString(); });
    server.stderr.on("data", (d) => { serverOutput += d.toString(); });

    server.on("error", (err) => {
        findings.errors.push(`Dev server spawn error: ${err.message}`);
    });

    // 2. Wait for health
    const healthy = await waitForHealth(DEV_URL, 15_000);
    if (!healthy) {
        findings.errors.push("Dev server did not become healthy within 15s");
        findings.serverOutput = serverOutput;
        console.log(JSON.stringify(findings, null, 2));
        server.kill();
        process.exit(1);
    }
    console.error("Dev server healthy.");

    // 3. Launch Chromium
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (err) {
        findings.errors.push(`Chromium launch failed: ${err.message}`);
        console.log(JSON.stringify(findings, null, 2));
        server.kill();
        process.exit(1);
    }

    try {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            colorScheme: "dark",
        });
        const page = await context.newPage();

        // 5. Capture ALL console messages
        page.on("console", (msg) => {
            findings.consoleMessages.push({
                type: msg.type(),
                text: msg.text(),
            });
        });

        page.on("pageerror", (err) => {
            findings.consoleMessages.push({
                type: "pageerror",
                text: err.message,
            });
        });

        // 4. Navigate
        console.error("Navigating to dev server…");
        await page.goto(DEV_URL, { waitUntil: "domcontentloaded" });

        // Wait for WebSocket connection to establish
        try {
            await page.waitForSelector(".vr-connection-status.connected", {
                timeout: 10_000,
            });
            console.error("WebSocket connected.");
        } catch {
            console.error("⚠ WebSocket did not connect within 10s.");
        }

        // 6. Wait for diff to load
        let diffLoaded = false;
        try {
            await page.waitForSelector(".d2h-wrapper, .d2h-file-wrapper", {
                timeout: 15_000,
            });
            diffLoaded = true;
            console.error("Diff content loaded.");
        } catch {
            console.error("⚠ Diff content did not appear within 15s — continuing with what we have.");
        }

        // Extra settle time for rendering
        await page.waitForTimeout(1500);

        // ── Screenshot: initial ──────────────────────────────────
        const ssInitial = join(fixturesDir, "screenshot-initial.png");
        await page.screenshot({ path: ssInitial, fullPage: false });
        findings.screenshots.push(ssInitial);
        console.error(`Screenshot: ${ssInitial}`);

        // ── 7a. Tab visibility ───────────────────────────────────
        try {
            const tabs = await page.$$eval(".vr-tab", (els) =>
                els.map((el) => {
                    const rect = el.getBoundingClientRect();
                    return {
                        text: el.textContent.trim(),
                        width: rect.width,
                        height: rect.height,
                        x: rect.x,
                        y: rect.y,
                        visible: rect.width > 0 && rect.height > 0,
                        classes: el.className,
                    };
                })
            );
            findings.tabVisibility = {
                count: tabs.length,
                tabs,
                allVisible: tabs.every((t) => t.visible),
            };
        } catch (err) {
            findings.tabVisibility = { error: err.message };
        }

        // ── 7b. Line number cells ────────────────────────────────
        // diff2html uses .d2h-code-linenumber in unified mode and
        // .d2h-code-side-linenumber in side-by-side mode.
        const LINE_NUM_SELECTOR = ".d2h-code-linenumber, .d2h-code-side-linenumber";
        try {
            const count = await page.$$eval(
                LINE_NUM_SELECTOR,
                (els) => els.length
            );
            findings.lineNumberCells = { count };
        } catch (err) {
            findings.lineNumberCells = { error: err.message };
        }

        // Check if comment triggers were attached (vr-line-gutter class)
        try {
            const gutterInfo = await page.evaluate(() => {
                const sideLinenums = document.querySelectorAll(".d2h-code-side-linenumber");
                const unifiedLinenums = document.querySelectorAll(".d2h-code-linenumber");
                const gutterCells = document.querySelectorAll(".vr-line-gutter");
                return {
                    sideLinenumCount: sideLinenums.length,
                    unifiedLinenumCount: unifiedLinenums.length,
                    gutterCellCount: gutterCells.length,
                    triggersBound: gutterCells.length > 0,
                    note: gutterCells.length === 0 && sideLinenums.length > 0
                        ? "BUG: side-by-side line number cells exist but no comment triggers attached (selector mismatch)"
                        : null,
                };
            });
            findings.commentTriggerAttachment = gutterInfo;
        } catch (err) {
            findings.commentTriggerAttachment = { error: err.message };
        }

        // ── 7c. Hover test ───────────────────────────────────────
        // Skip hunk header rows (.d2h-info) — look for actual code line cells
        try {
            const firstCell = await page.$(`${LINE_NUM_SELECTOR}:not(.d2h-info)`);
            if (firstCell) {
                await firstCell.hover();
                await page.waitForTimeout(500);

                // Screenshot after hover
                const ssHover = join(fixturesDir, "screenshot-hover.png");
                await page.screenshot({ path: ssHover, fullPage: false });
                findings.screenshots.push(ssHover);
                console.error(`Screenshot: ${ssHover}`);

                const btnAppeared = await page.$(".vr-add-comment-btn");
                findings.hoverTest = {
                    hovered: true,
                    commentButtonAppeared: !!btnAppeared,
                };

                // ── 7d. Click test ───────────────────────────────
                if (btnAppeared) {
                    try {
                        await btnAppeared.click();
                        await page.waitForTimeout(500);

                        const ssClick = join(fixturesDir, "screenshot-after-click.png");
                        await page.screenshot({ path: ssClick, fullPage: false });
                        findings.screenshots.push(ssClick);
                        console.error(`Screenshot: ${ssClick}`);

                        const formRow = await page.$(".vr-comment-form-row");
                        findings.clickTest = {
                            clicked: true,
                            commentFormAppeared: !!formRow,
                        };
                    } catch (err) {
                        findings.clickTest = { error: err.message };
                    }
                } else {
                    findings.clickTest = {
                        skipped: true,
                        reason: "No comment button appeared on hover",
                    };
                }
            } else {
                findings.hoverTest = {
                    skipped: true,
                    reason: "No .d2h-code-linenumber cells found",
                };
                findings.clickTest = {
                    skipped: true,
                    reason: "No .d2h-code-linenumber cells found",
                };
            }
        } catch (err) {
            findings.hoverTest = { error: err.message };
        }

        // ── 7e. Overlap check ────────────────────────────────────
        // In side-by-side mode, cells use .d2h-code-side-linenumber
        // and .d2h-code-side-line; in unified, .d2h-code-linenumber and .d2h-code-line
        try {
            const overlapData = await page.$$eval(
                ".d2h-diff-tbody tr",
                (rows) => {
                    const results = [];
                    for (const row of rows.slice(0, 20)) {
                        const lineNumCell = row.querySelector(
                            ".d2h-code-linenumber, .d2h-code-side-linenumber"
                        );
                        const codeCell = row.querySelector(
                            ".d2h-code-line, .d2h-code-side-line"
                        );
                        if (lineNumCell && codeCell) {
                            const lnRect = lineNumCell.getBoundingClientRect();
                            const codeRect = codeCell.getBoundingClientRect();
                            const overlaps =
                                lnRect.right > codeRect.left + 1 &&
                                lnRect.left < codeRect.right;
                            results.push({
                                lineNum: {
                                    x: lnRect.x,
                                    width: lnRect.width,
                                    right: lnRect.right,
                                },
                                code: {
                                    x: codeRect.x,
                                    width: codeRect.width,
                                    left: codeRect.left,
                                },
                                overlaps,
                            });
                        }
                    }
                    return results;
                }
            );
            const overlapCount = overlapData.filter((r) => r.overlaps).length;
            findings.overlapCheck = {
                rowsChecked: overlapData.length,
                overlappingRows: overlapCount,
                hasOverlap: overlapCount > 0,
                sampleRows: overlapData.slice(0, 5),
            };
        } catch (err) {
            findings.overlapCheck = { error: err.message };
        }

        // ── 7f. Header layout ────────────────────────────────────
        try {
            const headerData = await page.evaluate(() => {
                const get = (sel) => {
                    const el = document.querySelector(sel);
                    if (!el)
                        return { selector: sel, found: false };
                    const rect = el.getBoundingClientRect();
                    return {
                        selector: sel,
                        found: true,
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        right: rect.right,
                    };
                };
                return {
                    headerLeft: get(".vr-header-left"),
                    tabs: get(".vr-tabs"),
                    headerRight: get(".vr-header-right"),
                    header: get(".vr-header"),
                };
            });

            // Check if tabs have adequate space
            let tabsHaveSpace = true;
            if (
                headerData.headerLeft.found &&
                headerData.tabs.found &&
                headerData.headerRight.found
            ) {
                const usedWidth =
                    headerData.headerLeft.width +
                    headerData.tabs.width +
                    headerData.headerRight.width;
                const headerWidth = headerData.header.found
                    ? headerData.header.width
                    : 1280;
                tabsHaveSpace =
                    headerData.tabs.width >= 200 &&
                    usedWidth <= headerWidth + 50; // +50 for gaps/padding
            }

            findings.headerLayout = {
                ...headerData,
                tabsHaveSpace,
            };
        } catch (err) {
            findings.headerLayout = { error: err.message };
        }

        // ── Diff loaded flag ─────────────────────────────────────
        findings.diffLoaded = diffLoaded;

        // Filter console errors/warnings
        findings.consoleErrors = findings.consoleMessages.filter(
            (m) => m.type === "error" || m.type === "pageerror"
        );
        findings.consoleWarnings = findings.consoleMessages.filter(
            (m) => m.type === "warning"
        );
    } finally {
        await browser.close();
    }

    // 10. Output JSON to stdout
    console.log(JSON.stringify(findings, null, 2));

    // Cleanup: kill dev server
    server.kill();
    await sleep(500);
}

main().catch((err) => {
    console.error(`Fatal: ${err.stack ?? err}`);
    process.exit(1);
});
