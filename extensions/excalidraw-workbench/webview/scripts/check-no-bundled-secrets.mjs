import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../runtime/", import.meta.url));

const secretPatterns = [
  { name: "Google API key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "GitHub token", pattern: /(?:github_pat_[A-Za-z0-9_]{50,}|gh[pousr]_[A-Za-z0-9_]{30,})/g },
  { name: "AWS access key ID", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "private key block", pattern: /-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/g },
];

const findings = [];

async function scanDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(entryPath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const content = await readFile(entryPath, "utf8").catch(() => null);
    if (content === null) {
      continue;
    }

    for (const { name, pattern } of secretPatterns) {
      pattern.lastIndex = 0;
      const matches = content.match(pattern);
      if (matches?.length) {
        findings.push({ path: relative(root, entryPath), name, count: matches.length });
      }
    }
  }
}

await scanDirectory(root);

if (findings.length > 0) {
  console.error("Bundled webview secret scan failed:");
  for (const finding of findings) {
    console.error(`- ${finding.path}: ${finding.name} (${finding.count})`);
  }
  process.exit(1);
}

console.log("Bundled webview secret scan passed.");
