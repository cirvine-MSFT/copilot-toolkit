#!/usr/bin/env bash
# install-extensions.sh — Install Copilot CLI extensions from this repo
# Works on macOS and Linux
#
# Usage:
#   ./install-extensions.sh                      # Install all extensions
#   ./install-extensions.sh ado-build-watcher    # Install only ado-build-watcher
#   ./install-extensions.sh ado-pr-watcher ado-build-watcher  # Install specific ones

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$REPO_ROOT/extensions"
# Respect COPILOT_HOME if set (same env var the Copilot CLI uses)
COPILOT_HOME="${COPILOT_HOME:-$HOME/.copilot}"
TARGET_DIR="$COPILOT_HOME/extensions"

if [ ! -d "$SOURCE_DIR" ]; then
    echo "Error: extensions/ directory not found at '$SOURCE_DIR'." >&2
    echo "Run this script from the repo root." >&2
    exit 1
fi

ALL_EXTENSIONS=("ado-pr-watcher" "ado-build-watcher" "visual-review")

if [ $# -gt 0 ]; then
    EXTENSIONS=()
    for arg in "$@"; do
        found=0
        for valid in "${ALL_EXTENSIONS[@]}"; do
            if [ "$arg" = "$valid" ]; then found=1; break; fi
        done
        if [ "$found" -eq 1 ]; then
            EXTENSIONS+=("$arg")
        else
            echo "Warning: Unknown extension '$arg'. Available: ${ALL_EXTENSIONS[*]}"
        fi
    done
    if [ ${#EXTENSIONS[@]} -eq 0 ]; then
        echo "Error: No valid extensions specified." >&2
        exit 1
    fi
else
    EXTENSIONS=("${ALL_EXTENSIONS[@]}")
fi

SHARED_DIRS=("lib")
INSTALLED=()

for ext in "${EXTENSIONS[@]}"; do
    src="$SOURCE_DIR/$ext"
    dst="$TARGET_DIR/$ext"
    if [ ! -d "$src" ]; then
        echo "Warning: Skipping '$ext' — source not found at '$src'"
        continue
    fi
    # Clean target first so stale files from previous versions are removed
    if [ -d "$dst" ]; then rm -rf "$dst"; fi
    mkdir -p "$dst"
    cp -R "$src/"* "$dst/"
    # Install npm dependencies if a package.json exists (e.g. visual-review uses ws)
    if [ -f "$dst/package.json" ] && command -v npm &>/dev/null; then
        (cd "$dst" && npm install --omit=dev --no-fund --no-audit 2>/dev/null) || true
    fi
    INSTALLED+=("$ext")
done

for dir in "${SHARED_DIRS[@]}"; do
    src="$SOURCE_DIR/$dir"
    dst="$TARGET_DIR/$dir"
    if [ ! -d "$src" ]; then
        echo "Warning: Skipping shared dir '$dir' — source not found at '$src'"
        continue
    fi
    if [ -d "$dst" ]; then rm -rf "$dst"; fi
    mkdir -p "$dst"
    cp -R "$src/"* "$dst/"
    INSTALLED+=("$dir")
done

# Preflight warnings
MISSING_TOOLS=()
if ! command -v copilot &>/dev/null; then MISSING_TOOLS+=("copilot (GitHub Copilot CLI)"); fi
if ! command -v az &>/dev/null; then MISSING_TOOLS+=("az (Azure CLI)"); fi

echo ""
echo "Installed to: $TARGET_DIR"
for item in "${INSTALLED[@]}"; do
    echo "  - $item"
done
if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
    echo ""
    echo "Warning: The following tools were not found on PATH:"
    for tool in "${MISSING_TOOLS[@]}"; do
        echo "  - $tool"
    done
    echo "Extensions require these at runtime."
fi
echo ""
echo "Run '/clear' in the Copilot CLI or restart it to load the new extensions."
