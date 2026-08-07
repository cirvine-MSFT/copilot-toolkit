import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { closeWorkbenchServer, startWorkbenchServer } from "./server.mjs";

// End-to-end smoke test against the real loopback server and the real committed
// runtime bundle. Dependency-free by design: it uses node:test and global fetch.
//
// This exists to catch a class of failure that unit tests miss entirely — a
// build that reports success but serves an incomplete runtime (missing fonts,
// locales, or stylesheet). See
// https://github.com/cirvine-MSFT/copilot-toolkit/issues/30

const extensionDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(extensionDir));
const sampleDrawing = join(repoRoot, "examples", "excalidraw", "smoke-test.excalidraw");
const apiToken = "smoke-test-token";

async function withServer(fn) {
    const directory = await mkdtemp(join(tmpdir(), "excalidraw-workbench-smoke-"));
    const filePath = join(directory, "smoke-test.excalidraw");
    await copyFile(sampleDrawing, filePath);

    const entry = {
        filePath,
        title: "Smoke test drawing",
        displayPath: "smoke-test.excalidraw",
        apiToken,
        commentState: { comments: [] },
    };

    const server = await startWorkbenchServer(entry, {});
    Object.assign(entry, server);

    try {
        await fn({ entry, url: server.url });
    } finally {
        await closeWorkbenchServer(entry);
        await rm(directory, { recursive: true, force: true });
    }
}

function referencedAssets(html) {
    return [...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)]
        .map((match) => match[1].replace(/^\.?\//, ""));
}

test("smoke: index.html serves with the expected security headers and injected config", async () => {
    await withServer(async ({ url }) => {
        const response = await fetch(url);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);

        const csp = response.headers.get("content-security-policy") ?? "";
        assert.match(csp, /default-src 'self'/);
        assert.match(csp, /connect-src 'self'/);
        assert.match(csp, /worker-src 'self' blob:/);

        const html = await response.text();
        assert.match(html, /window\.EXCALIDRAW_WORKBENCH_CONFIG=/);
        assert.match(html, /window\.EXCALIDRAW_ASSET_PATH="\/assets\/"/);
        assert.match(html, /Smoke test drawing/);
    });
});

test("smoke: every asset referenced by index.html serves 200 with a real content type", async () => {
    await withServer(async ({ url }) => {
        const html = await fetch(url).then((response) => response.text());
        const assets = referencedAssets(html);

        assert.ok(assets.length > 0, "index.html referenced no assets");
        assert.ok(
            assets.some((asset) => asset.endsWith(".js")),
            "index.html referenced no JS asset",
        );
        assert.ok(
            assets.some((asset) => asset.endsWith(".css")),
            "index.html referenced no CSS asset — the editor would render unstyled",
        );

        for (const asset of assets) {
            const response = await fetch(new URL(asset, url));
            assert.equal(response.status, 200, `${asset} did not serve 200`);

            const contentType = response.headers.get("content-type") ?? "";
            assert.notEqual(
                contentType,
                "application/octet-stream",
                `${asset} served as octet-stream — missing from the content type map`,
            );

            const body = await response.arrayBuffer();
            assert.ok(body.byteLength > 0, `${asset} served an empty body`);
        }
    });
});

test("smoke: excalidraw vendor chunk, fonts, and locales all serve", async () => {
    await withServer(async ({ url }) => {
        const { readdir } = await import("node:fs/promises");
        const assetsDir = join(extensionDir, "webview", "runtime", "assets", "excalidraw-assets");
        const names = await readdir(assetsDir);
        const localeNames = await readdir(join(assetsDir, "locales"));

        const vendor = names.find((name) => name.startsWith("vendor-") && name.endsWith(".js"));
        const font = names.find((name) => name.endsWith(".woff2"));
        const locale = localeNames.find((name) => name.endsWith(".js"));

        assert.ok(vendor, "no vendor chunk in the committed runtime");
        assert.ok(font, "no woff2 font in the committed runtime");
        assert.ok(locale, "no locale bundle in the committed runtime");

        const checks = [
            [`assets/excalidraw-assets/${vendor}`, /javascript/],
            [`assets/excalidraw-assets/${font}`, /font\/woff2/],
            [`assets/excalidraw-assets/locales/${locale}`, /javascript/],
        ];

        for (const [path, expectedType] of checks) {
            const response = await fetch(new URL(path, url));
            assert.equal(response.status, 200, `${path} did not serve 200`);
            assert.match(response.headers.get("content-type") ?? "", expectedType);
            const body = await response.arrayBuffer();
            assert.ok(body.byteLength > 0, `${path} served an empty body`);
        }
    });
});

test("smoke: API requests without a valid token are rejected", async () => {
    await withServer(async ({ url }) => {
        const noToken = await fetch(new URL("api/scene", url));
        assert.equal(noToken.status, 403);

        const badToken = await fetch(new URL("api/scene", url), {
            headers: { "X-Excalidraw-Workbench-Token": "wrong-token" },
        });
        assert.equal(badToken.status, 403);

        const goodToken = await fetch(new URL("api/scene", url), {
            headers: { "X-Excalidraw-Workbench-Token": apiToken },
        });
        assert.equal(goodToken.status, 200);
    });
});

test("smoke: static paths cannot escape the runtime directory", async () => {
    await withServer(async ({ url }) => {
        const { request } = await import("node:http");
        const target = new URL(url);

        // fetch() normalizes `..` segments before sending, which would make this
        // test vacuous. Write the raw request line directly instead.
        const rawGet = (path) => new Promise((resolvePath, reject) => {
            const req = request(
                { host: target.hostname, port: target.port, method: "GET", path },
                (res) => {
                    res.resume();
                    resolvePath(res.statusCode);
                },
            );
            req.on("error", reject);
            req.end();
        });

        const traversals = [
            "/../server.mjs",
            "/../../../server.mjs",
            "/..%2f..%2f..%2fserver.mjs",
            "/assets/../../common.mjs",
            "/assets/%2e%2e/%2e%2e/common.mjs",
        ];

        for (const path of traversals) {
            const status = await rawGet(path);
            assert.notEqual(status, 200, `${path} was served — path traversal is possible`);
        }
    });
});

test("smoke: the loaded drawing round-trips through the scene API", async () => {
    await withServer(async ({ url }) => {
        const response = await fetch(new URL("api/scene", url), {
            headers: { "X-Excalidraw-Workbench-Token": apiToken },
        });
        assert.equal(response.status, 200);

        const payload = await response.json();
        assert.ok(payload.scene, "scene payload missing");
        assert.ok(Array.isArray(payload.scene.elements), "scene elements missing");

        const onDisk = JSON.parse(await readFile(sampleDrawing, "utf8"));
        assert.equal(payload.scene.elements.length, onDisk.elements.length);
    });
});
