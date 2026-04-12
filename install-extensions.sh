#!/usr/bin/env bash
# install-extensions.sh — Install Copilot CLI extensions from this repo
# Works on macOS and Linux

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$REPO_ROOT/extensions"
TARGET_DIR="$HOME/.copilot/extensions"

if [ ! -d "$SOURCE_DIR" ]; then
    echo "Error: extensions/ directory not found at '$SOURCE_DIR'." >&2
    echo "Run this script from the repo root." >&2
    exit 1
fi

EXTENSIONS=("ado-pr-watcher" "ado-build-watcher")
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
