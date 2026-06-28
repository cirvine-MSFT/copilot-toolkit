import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restore } from "@excalidraw/excalidraw";
import { sceneRevision } from "../../scene-normalize.mjs";

const { excalidrawCapture } = vi.hoisted(() => ({
  excalidrawCapture: { onChange: null, excalidrawAPI: null },
}));

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: (props) => {
    excalidrawCapture.onChange = props.onChange ?? null;
    return React.createElement("div", { "data-testid": "excalidraw" });
  },
  exportToBlob: vi.fn(),
  exportToSvg: vi.fn(),
  restore: vi.fn((scene) => scene),
}));
class MockEventSource {
  close() {}
}

function mockResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    statusText: init.statusText ?? "OK",
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

function makeFixtureScene() {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://github.com/cirvine-msft/copilot-toolkit",
    elements: [
      {
        id: "box",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        angle: 0,
        strokeColor: "#000",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        roughness: 1,
        opacity: 100,
        version: 1,
        versionNonce: 111,
        updated: 1,
        isDeleted: false,
        boundElements: null,
        seed: 1,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.useRealTimers();
  vi.mocked(restore).mockImplementation((scene) => scene);
  document.body.innerHTML = "";
  excalidrawCapture.onChange = null;
  excalidrawCapture.excalidrawAPI = null;
});

async function renderApp() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("EventSource", MockEventSource);
  const { App } = await import("./main.jsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(App));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  return { container, root };
}

describe("App load diagnostics", () => {
  it("renders API scene failures as visible errors", async () => {
    window.EXCALIDRAW_WORKBENCH_CONFIG = { apiToken: "test-token" };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      statusText: "Internal Server Error",
      text: async () => JSON.stringify({ error: "Scene normalization failed" }),
    })));

    const { container, root } = await renderApp();

    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Could not load Excalidraw drawing.");
    expect(alert?.textContent).toContain("Scene normalization failed");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders scene normalization failures as visible errors", async () => {
    vi.mocked(restore).mockImplementation(() => {
      throw new Error("appStateForInitialViewport is not defined");
    });
    window.EXCALIDRAW_WORKBENCH_CONFIG = { apiToken: "test-token" };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      statusText: "OK",
      text: async () => JSON.stringify({ scene: { elements: [], appState: {}, files: {} }, comments: [] }),
    })));

    const { container, root } = await renderApp();

    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Could not load Excalidraw drawing.");
    expect(alert?.textContent).toContain("appStateForInitialViewport is not defined");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("ErrorBoundary", () => {
  it("renders the fallback when a child throws during render", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { ErrorBoundary } = await import("./main.jsx");
    const Boom = () => {
      throw new Error("appStateForInitialViewport is not defined");
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      root.render(React.createElement(ErrorBoundary, null, React.createElement(Boom)));
    });

    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Excalidraw Workbench failed to render.");
    expect(alert?.textContent).toContain("appStateForInitialViewport is not defined");
    expect(container.querySelector("button")?.textContent).toBe("Reload");

    consoleError.mockRestore();
    await act(async () => {
      root.unmount();
    });
  });
});

describe("App scene save gating (issue #8)", () => {
  let fetchMock;
  let container;
  let root;
  let App;

  async function mountApp(initialScene) {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.EXCALIDRAW_WORKBENCH_CONFIG = { apiToken: "test-token" };
    vi.stubGlobal("EventSource", MockEventSource);

    const baseRevision = sceneRevision(initialScene);

    fetchMock = vi.fn(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init.method ?? "GET").toUpperCase();

      if (method === "GET" && url.startsWith("/api/scene")) {
        return mockResponse({
          scene: initialScene,
          revision: baseRevision,
          comments: [],
          title: "Fixture",
          displayPath: "/tmp/fixture.excalidraw",
        });
      }

      if (method === "POST" && url.startsWith("/api/scene")) {
        return mockResponse({ saved: true, revision: `${baseRevision}-next` });
      }

      if (method === "GET" && url.startsWith("/api/comments")) {
        return mockResponse({ comments: [] });
      }

      return mockResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    ({ App } = await import("./main.jsx"));

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(App));
      await Promise.resolve();
      await Promise.resolve();
    });

    return { baseRevision };
  }

  function postSceneCalls() {
    return fetchMock.mock.calls.filter(([url, init]) => {
      const u = typeof url === "string" ? url : url.url;
      const method = (init?.method ?? "GET").toUpperCase();
      return method === "POST" && u.startsWith("/api/scene");
    });
  }

  async function fireOnChange(elements, appState = { viewBackgroundColor: "#ffffff" }, files = {}) {
    expect(excalidrawCapture.onChange, "Excalidraw onChange not captured").toBeTypeOf("function");
    await act(async () => {
      excalidrawCapture.onChange(elements, appState, files);
    });
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function simulateCanvasInteraction() {
    const canvas = document.querySelector(".canvas");
    expect(canvas, ".canvas element not in DOM").not.toBeNull();
    const target = canvas.querySelector("[data-testid='excalidraw']") ?? canvas;
    const event = new window.Event("pointerdown", { bubbles: true });
    Object.defineProperty(event, "target", { value: target });
    window.dispatchEvent(event);
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
      root = null;
    }
    container = null;
  });

  it("does not POST /api/scene before any user interaction", async () => {
    const scene = makeFixtureScene();
    await mountApp(scene);

    // Excalidraw fires onChange during initial load/normalization with metadata-only
    // differences. That MUST NOT dirty the source drawing.
    const normalized = scene.elements.map((element) => ({
      ...element,
      version: element.version + 1,
      versionNonce: element.versionNonce + 999,
      updated: element.updated + 1,
    }));

    await fireOnChange(normalized);

    expect(postSceneCalls()).toHaveLength(0);
  });

  it("does not POST /api/scene for metadata-only changes even after interaction", async () => {
    const scene = makeFixtureScene();
    await mountApp(scene);

    simulateCanvasInteraction();

    const metadataOnly = scene.elements.map((element) => ({
      ...element,
      version: element.version + 5,
      versionNonce: element.versionNonce + 4242,
      updated: element.updated + 7,
      baseline: 42,
    }));

    await fireOnChange(metadataOnly);

    expect(postSceneCalls()).toHaveLength(0);
  });

  it("POSTs /api/scene after a real user edit on the canvas", async () => {
    const scene = makeFixtureScene();
    const { baseRevision } = await mountApp(scene);

    simulateCanvasInteraction();

    const edited = scene.elements.map((element) => ({
      ...element,
      x: element.x + 25,
      version: element.version + 1,
      versionNonce: element.versionNonce + 1,
      updated: element.updated + 1,
    }));

    await fireOnChange(edited);

    const posts = postSceneCalls();
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0][1].body);
    expect(body.baseRevision).toBe(baseRevision);
    expect(body.scene.elements[0].x).toBe(25);
    expect(typeof body.clientId).toBe("string");
  });
});

