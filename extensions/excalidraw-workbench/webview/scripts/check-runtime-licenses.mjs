import { readFile } from "node:fs/promises";

const allowedLicensePatterns = [
  /^MIT$/i,
  /^ISC$/i,
  /^BSD-\d-Clause$/i,
  /^Apache-2\.0$/i,
  /^MPL-2\.0$/i,
  /^CC0-1\.0$/i,
  /^Unlicense$/i,
  /^0BSD$/i,
  /^Zlib$/i,
  // SPDX compound expressions bundled by transitive Excalidraw deps.
  /^\(MPL-2\.0 OR Apache-2\.0\)$/i, // dompurify
  /^\(MIT AND Zlib\)$/i,             // pako
];

// Packages that ship a LICENSE file (verified manually) but omit the
// "license" field in package.json. Keep this list narrow and re-audit
// on every dep bump.
const allowedMissingLicensePackages = new Set([
  "node_modules/fuzzy",  // ships LICENSE-MIT (MIT)
  "node_modules/khroma", // ships LICENSE-MIT (MIT)
]);

const lockfile = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const packages = lockfile.packages ?? {};
const violations = [];

for (const [path, entry] of Object.entries(packages)) {
  if (path === "" || entry.dev) {
    continue;
  }

  const license = String(entry.license ?? "").trim();
  if (allowedLicensePatterns.some((pattern) => pattern.test(license))) {
    continue;
  }

  if (!license && allowedMissingLicensePackages.has(path)) {
    continue;
  }

  violations.push(`${path}: ${license || "missing license"}`);
}

if (violations.length > 0) {
  console.error("Runtime dependency license check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Runtime dependency licenses are compatible.");
