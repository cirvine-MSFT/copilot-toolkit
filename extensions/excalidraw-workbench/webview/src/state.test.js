import { describe, expect, it, vi } from "vitest";
import {
  activeComments,
  commentAnchorFromSelection,
  elementAtScenePoint,
  normalizeImportedScene,
  normalizeAppState,
  scenePayload,
  sceneFingerprint,
  scenePointToViewport,
  shouldPersistSceneChange,
  viewportPointToScene,
} from "./state.js";

describe("scenePayload", () => {
  it("normalizes missing scene fields", () => {
    expect(scenePayload({ elements: [] })).toMatchObject({
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {},
    });
  });

  it("strips collaborators from persisted scene JSON", () => {
    expect(scenePayload({ elements: [], appState: { collaborators: new Map(), viewBackgroundColor: "#fff" } }).appState).toEqual({
      viewBackgroundColor: "#fff",
    });
  });

  it("restores sparse elements with Excalidraw runtime defaults", async () => {
    vi.stubGlobal("Path2D", class {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({});
    const { restore } = await import("@excalidraw/excalidraw");

    const restored = restore(normalizeImportedScene({
      elements: [
        { id: "box", type: "rectangle", x: 10, y: 20, width: 100, height: 50 },
      ],
    }), null, null, { repairBindings: true });

    const element = scenePayload(restored).elements[0];
    expect(element).toMatchObject({
      opacity: 100,
      angle: 0,
      isDeleted: false,
    });
    expect(Number.isFinite(element.seed)).toBe(true);
    expect(Number.isFinite(element.versionNonce)).toBe(true);
  });
});

describe("normalizeImportedScene", () => {
  it("coerces numeric string geometry before rendering or export", () => {
    const scene = normalizeImportedScene({
      elements: [
        {
          id: "arrow-1",
          type: "arrow",
          x: "10",
          y: "20",
          width: "120",
          height: "-93",
          points: [[0, 0], ["120", "-93"]],
        },
      ],
    });

    expect(scene.elements[0].x).toBe(10);
    expect(scene.elements[0].height).toBe(-93);
    expect(scene.elements[0].points[1]).toEqual([120, -93]);
  });

  it("identifies invalid numeric geometry by element and field", () => {
    expect(() => normalizeImportedScene({
      elements: [
        { id: "arrow-bad", type: "arrow", x: 0, y: 0, width: 120, height: "nope", points: [[0, 0], [120, -93]] },
      ],
    })).toThrow(/arrow-bad.*height.*finite number/);
  });
});

describe("sceneFingerprint", () => {
  it("ignores metadata-only element changes", () => {
    const base = {
      elements: [
        { id: "box", type: "rectangle", x: 0, y: 0, width: 100, height: 50, boundElements: null, version: 1, versionNonce: 111, updated: 1 },
      ],
      appState: { activeTool: { type: "selection" }, scrollX: 10, selectedElementIds: { box: true }, viewBackgroundColor: "#ffffff" },
    };
    const metadataOnly = {
      elements: [
        { ...base.elements[0], baseline: 42, boundElements: [], version: 2, versionNonce: 222, updated: 2 },
      ],
      appState: { activeTool: { type: "selection", lastActiveTool: null }, scrollX: 20, selectedElementIds: {}, viewBackgroundColor: "#ffffff" },
    };

    expect(sceneFingerprint(metadataOnly)).toBe(sceneFingerprint(base));
  });

  it("keeps app background changes semantic", () => {
    expect(sceneFingerprint({
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
    })).not.toBe(sceneFingerprint({
      elements: [],
      appState: { viewBackgroundColor: "#fff4ce" },
    }));
  });

  it("requires a user interaction and a semantic scene change before saving", () => {
    const base = {
      elements: [
        { id: "box", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      ],
    };
    const changed = {
      elements: [
        { ...base.elements[0], x: 25 },
      ],
    };
    const lastSceneFingerprint = sceneFingerprint(base);

    expect(shouldPersistSceneChange({ hasUserInteracted: false, lastSceneFingerprint, scene: changed })).toBe(false);
    expect(shouldPersistSceneChange({ hasUserInteracted: true, lastSceneFingerprint, scene: base })).toBe(false);
    expect(shouldPersistSceneChange({ hasUserInteracted: true, lastSceneFingerprint, scene: changed })).toBe(true);
  });
});

describe("normalizeAppState", () => {
  it("provides a collaborators Map for Excalidraw runtime", () => {
    expect(normalizeAppState({}, { forExcalidraw: true }).collaborators).toBeInstanceOf(Map);
  });
});

describe("activeComments", () => {
  it("filters resolved comments", () => {
    expect(activeComments([{ id: "a" }, { id: "b", resolved: true }])).toEqual([{ id: "a" }]);
  });
});

describe("commentAnchorFromSelection", () => {
  it("anchors comments to the selected element center", () => {
    expect(commentAnchorFromSelection(
      [{ id: "box", type: "rectangle", x: 10, y: 20, width: 80, height: 40 }],
      { selectedElementIds: { box: true } },
    )).toMatchObject({
      x: 50,
      y: 40,
      elementId: "box",
      elementType: "rectangle",
    });
  });

  describe("coordinate helpers", () => {
    it("round trips scene and viewport coordinates", () => {
      const appState = { scrollX: 10, scrollY: 20, zoom: { value: 2 } };
      const viewport = scenePointToViewport({ x: 5, y: 7 }, appState);
      expect(viewport).toEqual({ x: 30, y: 54 });
      expect(viewportPointToScene(viewport, appState)).toEqual({ x: 5, y: 7 });
    });

    it("finds the topmost element at a scene point", () => {
      const element = elementAtScenePoint([
        { id: "back", type: "rectangle", x: 0, y: 0, width: 100, height: 100 },
        { id: "front", type: "rectangle", x: 10, y: 10, width: 20, height: 20 },
      ], { x: 15, y: 15 });
      expect(element.id).toBe("front");
    });
  });
});
