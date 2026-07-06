import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function redactBundledProviderKeys() {
  const secretPatterns = [
    /AIza[0-9A-Za-z_-]{35}/g,
  ];

  return {
    name: "redact-bundled-provider-keys",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          for (const pattern of secretPatterns) {
            output.code = output.code.replace(pattern, "");
          }
        }

        if (output.type === "asset" && typeof output.source === "string") {
          for (const pattern of secretPatterns) {
            output.source = output.source.replace(pattern, "");
          }
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), redactBundledProviderKeys()],
  base: "./",
  resolve: {
    alias: [
      // @excalidraw/excalidraw's dev bundle imports "roughjs/bin/rough" without the
      // ".js" extension, which Vite 8 / Vitest 4's stricter Node ESM resolver rejects.
      { find: /^roughjs\/bin\/rough$/, replacement: "roughjs/bin/rough.js" },
    ],
  },
  build: {
    outDir: "runtime",
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    testTimeout: 30000,
    server: {
      deps: {
        inline: ["@excalidraw/excalidraw"],
      },
    },
  },
});
