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
  // ---------------------------------------------------------------------
  // WORKAROUND: @excalidraw/excalidraw 0.18.x ESM resolution bug
  // ---------------------------------------------------------------------
  // Excalidraw's dev ESM bundle (node_modules/@excalidraw/excalidraw/dist/dev/index.js)
  // imports `roughjs/bin/rough` without a file extension. roughjs@4.x has no
  // `exports` map, so Node's strict ESM resolver refuses to auto-append `.js`
  // and throws ERR_MODULE_NOT_FOUND when vitest loads Excalidraw under jsdom.
  // Vite's bundler-style resolver does the extension fill-in for us, so we
  // alias the bare specifier to the explicit `.js` path. Lives at top-level
  // resolve.alias (not test.alias) so it also rewrites imports originating
  // from inside node_modules.
  //
  // Tracking: https://github.com/cirvine-MSFT/copilot-toolkit/issues/22
  // Upstream:  Excalidraw should publish an ESM build that emits the `.js`
  //            extension on bare specifiers, or roughjs should ship an
  //            `exports` map. Either change makes this alias unnecessary.
  //
  // REMOVE THIS WORKAROUND WHEN: bumping @excalidraw/excalidraw to a version
  // whose dist/dev/index.js imports `roughjs/bin/rough.js` (verify with
  //   grep "roughjs/bin/rough" node_modules/@excalidraw/excalidraw/dist/dev/index.js
  // — the line should end in `.js`). Then delete this alias block and re-run
  // `npm run test` to confirm it still passes.
  resolve: {
    alias: [
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
    // Excalidraw 0.18's transformed dev bundle is large; the first import in
    // jsdom can exceed vitest's 5s default on slower CI runners. Bumping the
    // per-test timeout keeps the scene-restoration test stable.
    testTimeout: 30000,
    // Force vitest to transform Excalidraw (and roughjs) through its own
    // bundler-style resolver so the `roughjs/bin/rough` alias above actually
    // applies. Without inlining, Excalidraw is treated as an external ESM
    // package and goes straight to Node's strict resolver, which throws.
    // Remove these inline entries when the Excalidraw alias workaround above
    // is removed.
    server: {
      deps: {
        inline: [/@excalidraw\/excalidraw/, /^roughjs/],
      },
    },
  },
});
