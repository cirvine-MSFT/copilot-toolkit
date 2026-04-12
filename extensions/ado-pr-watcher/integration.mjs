function matchesToolName(toolName, expectedName) {
    const actualName = String(toolName ?? "").trim().toLowerCase();
    const normalizedExpectedName = String(expectedName ?? "").trim().toLowerCase();

    return actualName === normalizedExpectedName || actualName.endsWith(normalizedExpectedName);
}

function safeParseJson(jsonText) {
    if (typeof jsonText !== "string" || jsonText.trim() === "") {
        return null;
    }

    try {
        return JSON.parse(jsonText);
    }
    catch {
        return null;
    }
}

function parseInteger(value) {
    const numericValue = Number(value);
    return Number.isInteger(numericValue) ? numericValue : null;
}

function extractPullRequestIdFromText(text) {
    const match = String(text ?? "").match(/"pullRequestId"\s*:\s*(\d+)/i)
        ?? String(text ?? "").match(/\bpullRequestId\b[^0-9]*(\d+)/i)
        ?? String(text ?? "").match(/\bpull request\b[^0-9]*(\d+)/i);

    return match ? Number(match[1]) : null;
}

function extractPullRequestUrlFromText(text) {
    const match = String(text ?? "").match(
        /https:\/\/(?:dev\.azure\.com\/[^/\s"']+|[^/\s"']+\.visualstudio\.com)\/[^\s"']+\/_git\/[^\s"']+\/pullrequest\/\d+/i,
    );
    return match ? match[0] : null;
}

function tokenizeShellCommand(commandText) {
    const tokens = [];
    const matcher = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
    let match;

    while ((match = matcher.exec(commandText)) !== null) {
        tokens.push(match[1] ?? match[2] ?? match[3]);
    }

    return tokens;
}

function findFlagValue(tokens, flagNames) {
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];

        for (const flagName of flagNames) {
            if (token === flagName) {
                return tokens[index + 1] ?? null;
            }

            if (token.startsWith(`${flagName}=`)) {
                return token.slice(flagName.length + 1);
            }
        }
    }

    return null;
}

function findBooleanFlagValue(tokens, flagNames) {
    const value = findFlagValue(tokens, flagNames);
    if (value === null) {
        return null;
    }

    if (/^(true|1|yes)$/i.test(value)) {
        return true;
    }

    if (/^(false|0|no)$/i.test(value)) {
        return false;
    }

    return null;
}

function normalizeShellToken(token) {
    const normalizedToken = String(token ?? "").trim().toLowerCase();
    const lastPathSegment = normalizedToken.split(/[\\/]/).pop() ?? normalizedToken;
    return lastPathSegment.replace(/\.(cmd|exe|bat)$/i, "");
}

function containsCommandSequence(tokens, sequence) {
    const normalizedTokens = tokens.map(normalizeShellToken);
    const normalizedSequence = sequence.map((token) => String(token).toLowerCase());

    for (let startIndex = 0; startIndex <= normalizedTokens.length - normalizedSequence.length; startIndex += 1) {
        let matches = true;

        for (let offset = 0; offset < normalizedSequence.length; offset += 1) {
            if (normalizedTokens[startIndex + offset] !== normalizedSequence[offset]) {
                matches = false;
                break;
            }
        }

        if (matches) {
            return true;
        }
    }

    return false;
}

function buildCreateRequest(baseArgs, toolResultText, reason) {
    const parsedResult = safeParseJson(toolResultText);
    const pullRequestId = parseInteger(
        parsedResult?.pullRequestId
        ?? parsedResult?.codeReviewId
        ?? extractPullRequestIdFromText(toolResultText),
    );

    return {
        reason,
        startArgs: {
            organization: baseArgs.organization ?? null,
            project: baseArgs.project ?? null,
            repository: baseArgs.repository ?? null,
            pullRequestId: pullRequestId ?? undefined,
            pullRequestUrl: extractPullRequestUrlFromText(toolResultText) ?? undefined,
            sourceBranch: baseArgs.sourceBranch ?? undefined,
            waitForPublish: baseArgs.waitForPublish,
        },
    };
}

function buildFromDirectMcpTool(input) {
    const toolArgs = input.toolArgs ?? {};
    const toolResultText = input.toolResult?.textResultForLlm ?? "";

    if (matchesToolName(input.toolName, "repo_create_pull_request")) {
        return buildCreateRequest(
            {
                organization: null,
                project: toolArgs.project ?? null,
                repository: toolArgs.repositoryId ?? null,
                sourceBranch: toolArgs.sourceRefName ?? null,
                waitForPublish: false,
            },
            toolResultText,
            "PR creation",
        );
    }

    if (matchesToolName(input.toolName, "repo_update_pull_request") && toolArgs.isDraft === false) {
        return {
            reason: "PR publish",
            startArgs: {
                organization: null,
                project: toolArgs.project ?? null,
                repository: toolArgs.repositoryId ?? null,
                pullRequestId: parseInteger(toolArgs.pullRequestId) ?? undefined,
                waitForPublish: false,
            },
        };
    }

    return null;
}

function buildFromPowerShell(input) {
    if (!matchesToolName(input.toolName, "powershell")) {
        return null;
    }

    const commandText = String(input.toolArgs?.command ?? "");
    if (!commandText) {
        return null;
    }

    const tokens = tokenizeShellCommand(commandText);

    if (containsCommandSequence(tokens, ["az", "repos", "pr", "create"])) {
        const isDraft = findBooleanFlagValue(tokens, ["--draft"]);

        return buildCreateRequest(
            {
                organization: findFlagValue(tokens, ["--org", "--organization"]),
                project: findFlagValue(tokens, ["--project", "-p"]),
                repository: findFlagValue(tokens, ["--repository", "-r"]),
                sourceBranch: findFlagValue(tokens, ["--source-branch", "-s"]),
                waitForPublish: false,
            },
            input.toolResult?.textResultForLlm ?? "",
            "PR creation",
        );
    }

    if (containsCommandSequence(tokens, ["az", "repos", "pr", "update"])) {
        const isDraft = findBooleanFlagValue(tokens, ["--draft"]);
        if (isDraft !== false) {
            return null;
        }

        return {
            reason: "PR publish",
            startArgs: {
                organization: findFlagValue(tokens, ["--org", "--organization"]),
                project: findFlagValue(tokens, ["--project", "-p"]),
                repository: findFlagValue(tokens, ["--repository", "-r"]),
                pullRequestId: parseInteger(findFlagValue(tokens, ["--id"])) ?? undefined,
                waitForPublish: false,
            },
        };
    }

    return null;
}

function buildFromBash(input) {
    if (!matchesToolName(input.toolName, "bash")) {
        return null;
    }

    const commandText = String(input.toolArgs?.command ?? "");
    if (!commandText) {
        return null;
    }

    const tokens = tokenizeShellCommand(commandText);

    if (containsCommandSequence(tokens, ["az", "repos", "pr", "create"])) {
        const isDraft = findBooleanFlagValue(tokens, ["--draft"]);

        return buildCreateRequest(
            {
                organization: findFlagValue(tokens, ["--org", "--organization"]),
                project: findFlagValue(tokens, ["--project", "-p"]),
                repository: findFlagValue(tokens, ["--repository", "-r"]),
                sourceBranch: findFlagValue(tokens, ["--source-branch", "-s"]),
                waitForPublish: false,
            },
            input.toolResult?.textResultForLlm ?? "",
            "PR creation",
        );
    }

    if (containsCommandSequence(tokens, ["az", "repos", "pr", "update"])) {
        const isDraft = findBooleanFlagValue(tokens, ["--draft"]);
        if (isDraft !== false) {
            return null;
        }

        return {
            reason: "PR publish",
            startArgs: {
                organization: findFlagValue(tokens, ["--org", "--organization"]),
                project: findFlagValue(tokens, ["--project", "-p"]),
                repository: findFlagValue(tokens, ["--repository", "-r"]),
                pullRequestId: parseInteger(findFlagValue(tokens, ["--id"])) ?? undefined,
                waitForPublish: false,
            },
        };
    }

    return null;
}

export function buildAutoStartRequestFromToolInput(input) {
    if (input?.toolResult?.resultType !== "success") {
        return null;
    }

    return (
        buildFromDirectMcpTool(input)
        ?? buildFromPowerShell(input)
        ?? buildFromBash(input)
    );
}
