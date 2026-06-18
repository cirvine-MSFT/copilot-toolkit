import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webviewRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeDir = join(webviewRoot, "runtime");
const packageJson = JSON.parse(await readFile(join(webviewRoot, "package.json"), "utf8"));
const lockfile = JSON.parse(await readFile(join(webviewRoot, "package-lock.json"), "utf8"));
const packages = lockfile.packages ?? {};
const directRuntimeDependencies = Object.keys(packageJson.dependencies ?? {})
  .sort()
  .map((name) => {
    const entry = packages[`node_modules/${name}`] ?? {};
    return {
      name,
      version: entry.version ?? packageJson.dependencies[name],
      license: entry.license ?? "unknown",
    };
  });

await mkdir(runtimeDir, { recursive: true });
await writeFile(join(runtimeDir, "PROVENANCE.json"), `${JSON.stringify({
  description: "Prebuilt Excalidraw Workbench webview runtime copied by Copilot extension installers.",
  runtimeDirectory: "extensions/excalidraw-workbench/webview/runtime",
  sourcePackage: {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: lockfile.lockfileVersion,
  },
  directRuntimeDependencies,
  regenerate: {
    command: "cd extensions/excalidraw-workbench/webview && npm ci && npm run build",
    lockfile: "extensions/excalidraw-workbench/webview/package-lock.json",
  },
  safetyChecks: [
    "npm run license-check",
    "node scripts/check-no-bundled-secrets.mjs",
  ],
}, null, 2)}\n`, "utf8");
