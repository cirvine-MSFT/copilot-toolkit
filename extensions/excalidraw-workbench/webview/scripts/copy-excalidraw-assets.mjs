import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceFonts = join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
const targetFonts = join(root, "runtime", "assets", "fonts");
const sourceAssets = join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "excalidraw-assets");
const targetAssets = join(root, "runtime", "assets", "excalidraw-assets");

if (existsSync(sourceFonts)) {
  await mkdir(targetFonts, { recursive: true });
  await cp(sourceFonts, targetFonts, { recursive: true });
}

if (existsSync(sourceAssets)) {
  await mkdir(targetAssets, { recursive: true });
  await cp(sourceAssets, targetAssets, { recursive: true });
}
