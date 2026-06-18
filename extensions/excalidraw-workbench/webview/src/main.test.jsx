import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => React.createElement("div", { "data-testid": "excalidraw" }),
  exportToBlob: vi.fn(),
  exportToSvg: vi.fn(),
  restore: vi.fn((scene) => scene),
}));

class MockEventSource {
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("App load diagnostics", () => {
  it("renders API scene failures as visible errors", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.EXCALIDRAW_WORKBENCH_CONFIG = { apiToken: "test-token" };
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      statusText: "Internal Server Error",
      text: async () => JSON.stringify({ error: "Scene normalization failed" }),
    })));

    const { App } = await import("./main.jsx");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(App));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Could not load Excalidraw drawing.");
    expect(alert?.textContent).toContain("Scene normalization failed");

    await act(async () => {
      root.unmount();
    });
  });
});
