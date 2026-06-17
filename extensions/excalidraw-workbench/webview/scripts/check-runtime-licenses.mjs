import { readFile } from "node:fs/promises";

const allowedLicensePatterns = [
  /^MIT$/i,
  /^ISC$/i,
  /^BSD-\d-Clause$/i,
  /^Apache-2\.0$/i,
];

const lockfile = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const packages = lockfile.packages ?? {};
const violations = [];

for (const [path, entry] of Object.entries(packages)) {
  if (path === "" || entry.dev) {
    continue;
  }

  const license = String(entry.license ?? "").trim();
  if (!allowedLicensePatterns.some((pattern) => pattern.test(license))) {
    violations.push(`${path}: ${license || "missing license"}`);
  }
}

if (violations.length > 0) {
  console.error("Runtime dependency license check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Runtime dependency licenses are compatible.");
