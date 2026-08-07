import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Asserts that the built runtime is actually complete.
//
// This exists because a dependency bump once produced a build that reported
// success while emitting a runtime with no fonts, no locales, and no stylesheet.
// Every check below is a floor, not an exact match — they are meant to catch a
// silently empty or truncated build, not to pin byte-for-byte output.
//
// See https://github.com/cirvine-MSFT/copilot-toolkit/issues/30

const webviewRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeDir = join(webviewRoot, "runtime");
const assetsDir = join(runtimeDir, "assets");
const excalidrawAssetsDir = join(assetsDir, "excalidraw-assets");

const failures = [];

function fail(message) {
  failures.push(message);
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function listFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

// --- index.html exists and references an emitted JS *and* CSS asset ----------

const indexPath = join(runtimeDir, "index.html");
let html = "";
if (!existsSync(indexPath)) {
  fail(`runtime/index.html is missing (${indexPath})`);
} else {
  html = await readFile(indexPath, "utf8");

  const referenced = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map(
    (match) => match[1],
  );

  const referencedJs = referenced.filter((ref) => ref.endsWith(".js"));
  const referencedCss = referenced.filter((ref) => ref.endsWith(".css"));

  if (referencedJs.length === 0) {
    fail("runtime/index.html does not reference any emitted .js asset");
  }
  if (referencedCss.length === 0) {
    fail(
      "runtime/index.html does not reference any emitted .css asset — " +
        "the editor would render unstyled",
    );
  }

  for (const ref of referenced) {
    const refPath = join(runtimeDir, ref);
    const size = await sizeOf(refPath);
    if (size < 0) {
      fail(`runtime/index.html references ${ref}, which does not exist on disk`);
    } else if (size === 0) {
      fail(`referenced asset ${ref} is empty`);
    }
  }
}

// --- the app bundle and stylesheet are non-trivial ---------------------------

const emitted = await listFiles(assetsDir);
const appJs = emitted.filter((name) => name.startsWith("index-") && name.endsWith(".js"));
const appCss = emitted.filter((name) => name.startsWith("index-") && name.endsWith(".css"));

if (appJs.length === 0) {
  fail("no emitted application JS bundle found under runtime/assets/");
} else {
  const size = await sizeOf(join(assetsDir, appJs[0]));
  // The Excalidraw editor bundle is megabytes; anything under 500 KB means the
  // library failed to bundle in.
  if (size < 500_000) {
    fail(`application JS bundle ${appJs[0]} is only ${size} bytes (expected >= 500 KB)`);
  }
}

if (appCss.length === 0) {
  fail("no emitted application CSS bundle found under runtime/assets/");
} else {
  const size = await sizeOf(join(assetsDir, appCss[0]));
  if (size < 1_000) {
    fail(`application CSS bundle ${appCss[0]} is only ${size} bytes (expected >= 1 KB)`);
  }
}

// --- excalidraw-assets: vendor chunk, fonts, locales -------------------------

if (!existsSync(excalidrawAssetsDir)) {
  fail(
    "runtime/assets/excalidraw-assets/ is missing — the Excalidraw asset copy " +
      "did not run or silently produced nothing",
  );
} else {
  const assetFiles = await listFiles(excalidrawAssetsDir);

  const vendorChunks = assetFiles.filter(
    (name) => name.startsWith("vendor-") && name.endsWith(".js"),
  );
  if (vendorChunks.length === 0) {
    fail("no Excalidraw vendor-*.js chunk found in runtime/assets/excalidraw-assets/");
  } else {
    const size = await sizeOf(join(excalidrawAssetsDir, vendorChunks[0]));
    if (size < 1_000_000) {
      fail(`Excalidraw vendor chunk ${vendorChunks[0]} is only ${size} bytes (expected >= 1 MB)`);
    }
  }

  const fonts = assetFiles.filter((name) => name.endsWith(".woff2"));
  if (fonts.length < 5) {
    fail(`only ${fonts.length} .woff2 font(s) in excalidraw-assets (expected at least 5)`);
  }

  // Hand-drawn text renders with Virgil; its absence is the most visible
  // symptom of a broken asset copy.
  if (!fonts.some((name) => name.toLowerCase().startsWith("virgil"))) {
    fail("Virgil font is missing from excalidraw-assets");
  }

  const locales = assetFiles.filter((name) => name.includes("-json-") && name.endsWith(".js"));
  if (locales.length < 40) {
    fail(`only ${locales.length} locale bundle(s) in excalidraw-assets (expected at least 40)`);
  }
}

// --- provenance --------------------------------------------------------------

const provenancePath = join(runtimeDir, "PROVENANCE.json");
if (!existsSync(provenancePath)) {
  fail("runtime/PROVENANCE.json is missing");
} else {
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  const excalidraw = (provenance.directRuntimeDependencies ?? []).find(
    (dependency) => dependency.name === "@excalidraw/excalidraw",
  );
  if (!excalidraw?.version) {
    fail("PROVENANCE.json does not record an @excalidraw/excalidraw version");
  }
}

// --- report ------------------------------------------------------------------

if (failures.length > 0) {
  console.error("Runtime asset check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error("");
  console.error("The built runtime under webview/runtime/ is incomplete.");
  console.error("Do not commit it. See https://github.com/cirvine-MSFT/copilot-toolkit/issues/30");
  process.exit(1);
}

console.log("Runtime asset check passed.");
