import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const maxBuffer = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

export function nowIso() {
    return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export function formatError(error) {
    if (!error) {
        return "Unknown error";
    }

    return String(error?.message ?? error).trim();
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

export async function getDiffOutput(cwd, scope, base) {
    let command;

    switch (scope) {
        case "staged":
            command = "git diff --cached";
            break;
        case "unstaged":
            command = "git diff";
            break;
        case "branch":
        default:
            command = `git diff ${shellQuote(base)}..HEAD`;
            break;
    }

    try {
        const { stdout } = await execAsync(command, { cwd, maxBuffer });
        return stdout;
    } catch (error) {
        throw new Error(`Failed to get diff (${scope}): ${formatError(error)}`);
    }
}

export async function getChangedFiles(cwd, scope, base) {
    let command;

    switch (scope) {
        case "staged":
            command = "git diff --cached --name-status";
            break;
        case "unstaged":
            command = "git diff --name-status";
            break;
        case "branch":
        default:
            command = `git diff ${shellQuote(base)}..HEAD --name-status`;
            break;
    }

    try {
        const { stdout } = await execAsync(command, { cwd, maxBuffer });
        return stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const [status, ...rest] = line.split("\t");
                return { status: status.trim(), filePath: rest.join("\t").trim() };
            });
    } catch (error) {
        throw new Error(`Failed to list changed files: ${formatError(error)}`);
    }
}

export async function getFileContent(cwd, filePath, ref) {
    const refSpec = ref ?? "HEAD";
    const target = shellQuote(`${refSpec}:${filePath}`);
    const command = `git show ${target}`;

    try {
        const { stdout } = await execAsync(command, { cwd, maxBuffer });
        return stdout;
    } catch (error) {
        throw new Error(`Failed to get file content for ${filePath}@${refSpec}: ${formatError(error)}`);
    }
}

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}
