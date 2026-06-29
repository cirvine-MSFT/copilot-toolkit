import { readFile } from "node:fs/promises";

// Permissive licenses we accept anywhere in the runtime dep tree.
const allowedLicensePatterns = [
  /^MIT$/i,
  /^MIT-0$/i,
  /^ISC$/i,
  /^BSD-\d-Clause$/i,
  /^0BSD$/i,
  /^Apache-2\.0$/i,
  /^MPL-2\.0$/i,        // weak copyleft, fine to bundle unmodified (dompurify)
  /^CC0-1\.0$/i,        // public domain dedication (fractional-indexing)
  /^Unlicense$/i,       // public domain (robust-predicates)
  /^Python-2\.0$/i,
  /^BlueOak-1\.0\.0$/i,
  /^Zlib$/i,            // permissive; used by pako via "(MIT AND Zlib)"
];

// Packages whose package.json omits a `license` field but which ship a real
// LICENSE file we have audited. Keep this list short and re-verify when
// bumping any entry here.
const verifiedMissingLicenseAllowlist = new Map([
  // Verified MIT via node_modules/fuzzy/LICENSE-MIT (Copyright (c) 2012 Matt York).
  ["node_modules/fuzzy", "MIT"],
  // Verified MIT via node_modules/khroma/license (Copyright (c) 2019-present Fabio Spampinato).
  ["node_modules/khroma", "MIT"],
]);

function isLicenseAllowed(license) {
  const trimmed = license.trim();
  if (!trimmed) return false;

  // Compound expressions: "(X OR Y)" / "(X AND Y)". OR -> any one allowed
  // is enough; AND -> every part must be allowed.
  const compound = trimmed.replace(/^\(/, "").replace(/\)$/, "");
  if (/\sOR\s/i.test(compound)) {
    return compound.split(/\sOR\s/i).some((part) => isLicenseAllowed(part));
  }
  if (/\sAND\s/i.test(compound)) {
    return compound.split(/\sAND\s/i).every((part) => isLicenseAllowed(part));
  }

  return allowedLicensePatterns.some((pattern) => pattern.test(compound));
}

const lockfile = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const packages = lockfile.packages ?? {};
const violations = [];

for (const [path, entry] of Object.entries(packages)) {
  if (path === "" || entry.dev) {
    continue;
  }

  const declared = String(entry.license ?? "").trim();
  const effective = declared || verifiedMissingLicenseAllowlist.get(path) || "";

  if (!isLicenseAllowed(effective)) {
    violations.push(`${path}: ${effective || "missing license"}`);
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
