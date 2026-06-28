import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

class MockEventSource {
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = "";
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
    vi.doMock("@excalidraw/excalidraw", () => ({
      Excalidraw: () => React.createElement("div", { "data-testid": "excalidraw" }),
      exportToBlob: vi.fn(),
      exportToSvg: vi.fn(),
      restore: vi.fn((scene) => scene),
    }));
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
    vi.doMock("@excalidraw/excalidraw", () => ({
      Excalidraw: () => React.createElement("div", { "data-testid": "excalidraw" }),
      exportToBlob: vi.fn(),
      exportToSvg: vi.fn(),
      restore: vi.fn(() => {
        throw new Error("appStateForInitialViewport is not defined");
      }),
    }));
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
    vi.doMock("@excalidraw/excalidraw", () => ({
      Excalidraw: () => React.createElement("div"),
      exportToBlob: vi.fn(),
      exportToSvg: vi.fn(),
      restore: vi.fn((scene) => scene),
    }));
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
