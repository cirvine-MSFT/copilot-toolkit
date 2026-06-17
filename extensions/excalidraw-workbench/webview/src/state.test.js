import { describe, expect, it } from "vitest";
import {
  activeComments,
  commentAnchorFromSelection,
  elementAtScenePoint,
  normalizeAppState,
  scenePayload,
  scenePointToViewport,
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
