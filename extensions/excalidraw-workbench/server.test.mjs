import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { loadDiagram } from "./common.mjs";
import { assertWebviewRuntimeAssets, closeWorkbenchServer, startWorkbenchServer } from "./server.mjs";

async function withTempDir(fn) {
    const directory = await mkdtemp(join(tmpdir(), "excalidraw-workbench-assets-"));
    try {
        await fn(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test("assertWebviewRuntimeAssets reports actionable missing asset guidance", async () => {
    await withTempDir(async (root) => {
        await assert.rejects(
            () => assertWebviewRuntimeAssets(root),
            /webview assets are missing.*install script.*npm ci && npm run build/i,
        );
    });
});

test("scene saves include the originating client id in refresh events", async () => {
    await withTempDir(async (root) => {
        const filePath = join(root, "drawing.excalidraw");
        await writeFile(filePath, JSON.stringify({ type: "excalidraw", elements: [] }), "utf8");
        const entry = {
            filePath,
            title: "Test drawing",
            displayPath: "drawing.excalidraw",
            apiToken: "test-token",
            commentState: { comments: [] },
        };
        const server = await startWorkbenchServer(entry, {});
        Object.assign(entry, server);

        const events = await fetch(`${server.url}events?token=${encodeURIComponent(entry.apiToken)}`);
        const reader = events.body.getReader();
        const decoder = new TextDecoder();
        try {
            const response = await fetch(`${server.url}api/scene`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Excalidraw-Workbench-Token": entry.apiToken,
                },
                body: JSON.stringify({
                    clientId: "client-under-test",
                    scene: { type: "excalidraw", elements: [] },
                }),
            });
            assert.equal(response.status, 200, await response.text());

            let text = "";
            for (let attempt = 0; attempt < 5 && !text.includes("scene-saved"); attempt += 1) {
                const chunk = await reader.read();
                assert.equal(chunk.done, false);
                text += decoder.decode(chunk.value);
            }

            assert.match(text, /"reason":"scene-saved"/);
            assert.match(text, /"clientId":"client-under-test"/);
        } finally {
            await reader.cancel();
            await closeWorkbenchServer(entry);
        }
    });
});

test("stale scene saves are rejected", async () => {
    await withTempDir(async (root) => {
        const filePath = join(root, "drawing.excalidraw");
        await writeFile(filePath, JSON.stringify({
            type: "excalidraw",
            elements: [{ id: "box", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }],
        }), "utf8");
        const entry = {
            filePath,
            title: "Test drawing",
            displayPath: "drawing.excalidraw",
            apiToken: "test-token",
            commentState: { comments: [] },
        };
        const server = await startWorkbenchServer(entry, {});
        Object.assign(entry, server);

        try {
            const current = await fetch(`${server.url}api/scene`, {
                headers: { "X-Excalidraw-Workbench-Token": entry.apiToken },
            }).then((response) => response.json());

            const firstSave = await fetch(`${server.url}api/scene`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Excalidraw-Workbench-Token": entry.apiToken,
                },
                body: JSON.stringify({
                    baseRevision: current.revision,
                    scene: {
                        type: "excalidraw",
                        elements: [{ id: "box", type: "rectangle", x: 10, y: 0, width: 100, height: 50 }],
                    },
                }),
            });
            assert.equal(firstSave.status, 200, await firstSave.text());

            const staleSave = await fetch(`${server.url}api/scene`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Excalidraw-Workbench-Token": entry.apiToken,
                },
                body: JSON.stringify({
                    baseRevision: current.revision,
                    scene: {
                        type: "excalidraw",
                        elements: [{ id: "box", type: "rectangle", x: 20, y: 0, width: 100, height: 50 }],
                    },
                }),
            });
            assert.equal(staleSave.status, 409);

            const persisted = await loadDiagram(filePath);
            assert.equal(persisted.elements[0].x, 10);
        } finally {
            await closeWorkbenchServer(entry);
        }
    });
});

test("concurrent scene saves with the same base revision cannot both win", async () => {
    await withTempDir(async (root) => {
        const filePath = join(root, "drawing.excalidraw");
        await writeFile(filePath, JSON.stringify({
            type: "excalidraw",
            elements: [{ id: "box", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }],
        }), "utf8");
        const entry = {
            filePath,
            title: "Test drawing",
            displayPath: "drawing.excalidraw",
            apiToken: "test-token",
            commentState: { comments: [] },
        };
        const server = await startWorkbenchServer(entry, {});
        Object.assign(entry, server);

        try {
            const current = await fetch(`${server.url}api/scene`, {
                headers: { "X-Excalidraw-Workbench-Token": entry.apiToken },
            }).then((response) => response.json());

            const save = (x) => fetch(`${server.url}api/scene`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Excalidraw-Workbench-Token": entry.apiToken,
                },
                body: JSON.stringify({
                    baseRevision: current.revision,
                    scene: {
                        type: "excalidraw",
                        elements: [{ id: "box", type: "rectangle", x, y: 0, width: 100, height: 50 }],
                    },
                }),
            });

            const responses = await Promise.all([save(10), save(20)]);
            const statuses = responses.map((response) => response.status).sort();
            assert.deepEqual(statuses, [200, 409]);
        } finally {
            await closeWorkbenchServer(entry);
        }
    });
});
