import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
    addReply,
    applyElementPatch,
    commentMarkerScenePoint,
    createComment,
    loadCommentState,
    loadDiagram,
    renderSvg,
    resolveComment,
    resolveWorkspacePath,
    saveCommentState,
    saveDiagram,
} from "./common.mjs";

async function withTempDir(fn) {
    const directory = await mkdtemp(join(tmpdir(), "excalidraw-workbench-"));
    try {
        await fn(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test("resolveWorkspacePath accepts supported files under workspace", async () => {
    await withTempDir(async (root) => {
        assert.equal(resolveWorkspacePath(root, "drawing.excalidraw"), join(root, "drawing.excalidraw"));
    });
});

test("resolveWorkspacePath rejects traversal outside workspace", async () => {
    await withTempDir(async (root) => {
        assert.throws(() => resolveWorkspacePath(root, join("..", "outside.excalidraw")), /outside the workspace/);
    });
});

test("saveDiagram and loadDiagram preserve Excalidraw scene basics", async () => {
    await withTempDir(async (root) => {
        const filePath = join(root, "drawing.excalidraw");
        await saveDiagram(filePath, {
            type: "excalidraw",
            elements: [{ id: "text-1", type: "text", x: 1, y: 2, width: 30, height: 20, text: "Hello" }],
        });

        const loaded = await loadDiagram(filePath);
        assert.equal(loaded.type, "excalidraw");
        assert.equal(loaded.elements[0].text, "Hello");
    });
});

test("saveDiagram coerces numeric-string element geometry", async () => {
    await withTempDir(async (root) => {
        const filePath = join(root, "drawing.excalidraw");
        await saveDiagram(filePath, {
            elements: [{
                id: "arrow",
                type: "arrow",
                x: "10",
                y: "20",
                width: "120",
                height: "-93",
                points: [[0, 0], ["120", "-93"]],
            }],
        });

        const loaded = await loadDiagram(filePath);
        assert.equal(loaded.elements[0].x, 10);
        assert.equal(loaded.elements[0].height, -93);
        assert.deepEqual(loaded.elements[0].points[1], [120, -93]);
    });
});

test("saveDiagram rejects invalid numeric element geometry", async () => {
    await withTempDir(async (root) => {
        const filePath = join(root, "drawing.excalidraw");
        await assert.rejects(
            () => saveDiagram(filePath, {
                elements: [{
                    id: "arrow-bad",
                    type: "arrow",
                    x: 10,
                    y: 20,
                    width: 120,
                    height: "nope",
                    points: [[0, 0], [120, -93]],
                }],
            }),
            /arrow-bad.*height.*finite number/,
        );
    });
});

test("comment sidecar stores comments, replies, and resolution", async () => {
    await withTempDir(async (root) => {
        const filePath = join(root, "drawing.excalidraw");
        const state = await loadCommentState(filePath);
        const comment = createComment({ body: "Check spacing", x: 10, y: 20 });
        state.comments.push(comment);
        const { reply } = addReply(state, comment.id, "Looks good", "agent");
        resolveComment(state, comment.id);
        await saveCommentState(filePath, state);

        const loaded = await loadCommentState(filePath);
        assert.equal(loaded.comments[0].resolved, true);
        assert.equal(loaded.comments[0].replies[0].id, reply.id);
    });
});

test("applyElementPatch updates supported element fields", async () => {
    const diagram = {
        elements: [{ id: "text-1", type: "text", x: 1, y: 2, width: 30, height: 20, text: "Old" }],
    };

    const element = applyElementPatch(diagram, "text-1", { x: 5, text: "New" });
    assert.equal(element.x, 5);
    assert.equal(element.text, "New");
    assert.equal(element.originalText, "New");
});

test("renderSvg produces an inspectable SVG snapshot", async () => {
    const svg = renderSvg({
        elements: [{ id: "box", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }],
        appState: { viewBackgroundColor: "#ffffff" },
    }, [createComment({ body: "Look here", x: 10, y: 15 })]);

    assert.match(svg, /<svg /);
    assert.match(svg, /comment-marker/);
});

test("renderSvg keeps numeric-string arrow geometry finite", async () => {
    const svg = renderSvg({
        elements: [{
            id: "arrow",
            type: "arrow",
            x: 10,
            y: 20,
            width: "120",
            height: "-93",
            points: [[0, 0], ["120", "-93"]],
        }],
    });

    assert.doesNotMatch(svg, /NaN/);
    assert.match(svg, /viewBox="[-0-9.]+ [-0-9.]+ [-0-9.]+ [-0-9.]+"/);
});

test("commentMarkerScenePoint anchors to live element top-right when elementId matches", () => {
    const box = { id: "box", type: "rectangle", x: 10, y: 20, width: 80, height: 40 };
    assert.deepEqual(
        commentMarkerScenePoint({ elementId: "box", x: 999, y: 999 }, [box]),
        { x: 90, y: 20 },
    );
});

test("commentMarkerScenePoint tracks element after move and resize", () => {
    const moved = { id: "box", type: "rectangle", x: 200, y: 300, width: 160, height: 100 };
    assert.deepEqual(
        commentMarkerScenePoint({ elementId: "box", x: 50, y: 40 }, [moved]),
        { x: 360, y: 300 },
    );
});

test("commentMarkerScenePoint falls back to stored x/y when element is missing, deleted, or unidentified", () => {
    const stored = { elementId: "box", x: 42, y: 84 };
    assert.deepEqual(commentMarkerScenePoint(stored, []), { x: 42, y: 84 });
    assert.deepEqual(
        commentMarkerScenePoint(stored, [{ id: "box", type: "rectangle", x: 0, y: 0, width: 10, height: 10, isDeleted: true }]),
        { x: 42, y: 84 },
    );
    assert.deepEqual(
        commentMarkerScenePoint({ x: 7, y: 9 }, [{ id: "box", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }]),
        { x: 7, y: 9 },
    );
});

test("renderSvg places marker at element top-right when elementId matches", () => {
    const svg = renderSvg({
        elements: [{ id: "box", type: "rectangle", x: 10, y: 20, width: 80, height: 40 }],
        appState: { viewBackgroundColor: "#ffffff" },
    }, [createComment({ body: "On the box", x: 999, y: 999, elementId: "box" })]);

    assert.match(svg, /<circle cx="90" cy="20"/);
});

test("renderSvg falls back to stored point when elementId is missing", () => {
    const svg = renderSvg({
        elements: [{ id: "box", type: "rectangle", x: 10, y: 20, width: 80, height: 40 }],
        appState: { viewBackgroundColor: "#ffffff" },
    }, [createComment({ body: "Floating", x: 5, y: 7 })]);

    assert.match(svg, /<circle cx="5" cy="7"/);
});

test("saveDiagram writes formatted JSON", async () => {
    await withTempDir(async (root) => {
        const filePath = join(root, "drawing.excalidraw");
        await writeFile(filePath, "{}", "utf8");
        await saveDiagram(filePath, { elements: [] });
        assert.match(await readFile(filePath, "utf8"), /"elements": \[\]/);
    });
});
