import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(root, "node_modules", "@excalidraw", "excalidraw");

// `dist/excalidraw-assets` holds the vendor chunk, the woff2 font set, and every
// locale bundle. It is REQUIRED — a missing source directory must fail the build
// rather than silently emit a runtime with no fonts, no locales, and no vendor
// chunk.
//
// Upstream 0.18 deprecated this folder entirely (see
// https://github.com/cirvine-MSFT/copilot-toolkit/issues/30). When the previous
// version of this script guarded the copy with a bare `existsSync` skip, a major
// bump produced a "successful" build with an empty runtime. Do not reintroduce
// that behavior.
const source = join(packageRoot, "dist", "excalidraw-assets");
const target = join(root, "runtime", "assets", "excalidraw-assets");
const minFiles = 40;

if (!existsSync(source)) {
  console.error("Excalidraw asset copy failed — required source directory is missing:");
  console.error(`  ${source}`);
  console.error("");
  console.error("This means @excalidraw/excalidraw changed its dist layout.");
  console.error("Upstream 0.18 deprecated the `excalidraw-assets` folder in favor of");
  console.error("ESM chunks under `dist/prod/`, which needs a rewrite of this script.");
  console.error("Do NOT relax this check — a silent skip ships a canvas with no fonts or locales.");
  console.error("See https://github.com/cirvine-MSFT/copilot-toolkit/issues/30");
  process.exit(1);
}

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

const entries = await readdir(target, { recursive: true, withFileTypes: true });
const fileCount = entries.filter((entry) => entry.isFile()).length;
if (fileCount < minFiles) {
  console.error(
    `Excalidraw asset copy produced too few files: ${fileCount} ` +
      `(expected at least ${minFiles}).`,
  );
  process.exit(1);
}

console.log(`Excalidraw assets copied (${fileCount} files).`);
