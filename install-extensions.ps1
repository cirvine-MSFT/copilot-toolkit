# install-extensions.ps1 — Install Copilot CLI extensions from this repo
# Works on Windows PowerShell 5.1+ and pwsh 7+
#
# Usage:
#   .\install-extensions.ps1                      # Install all extensions
#   .\install-extensions.ps1 ado-build-watcher    # Install only ado-build-watcher
#   .\install-extensions.ps1 ado-pr-watcher ado-build-watcher  # Install specific ones

param(
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$Only
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$sourceDir = Join-Path $repoRoot "extensions"
# Respect COPILOT_HOME if set (same env var the Copilot CLI uses)
if ($env:COPILOT_HOME) {
    $copilotHome = $env:COPILOT_HOME
} else {
    $copilotHome = Join-Path $HOME ".copilot"
}
$targetDir = Join-Path $copilotHome "extensions"

if (-not (Test-Path $sourceDir)) {
    Write-Error "extensions/ directory not found at '$sourceDir'. Run this script from the repo root."
    exit 1
}

$allExtensions = @("ado-pr-watcher", "ado-build-watcher", "visual-review")
if ($Only -and $Only.Count -gt 0) {
    $extensions = @($Only | Where-Object { $allExtensions -contains $_ })
    $invalid = @($Only | Where-Object { $allExtensions -notcontains $_ })
    if ($invalid.Count -gt 0) {
        Write-Warning "Unknown extension(s): $($invalid -join ', '). Available: $($allExtensions -join ', ')"
    }
    if ($extensions.Count -eq 0) {
        Write-Error "No valid extensions specified."
        exit 1
    }
} else {
    $extensions = $allExtensions
}
$sharedDirs = @("lib")
[string[]]$installed = @()

foreach ($ext in $extensions) {
    $src = Join-Path $sourceDir $ext
    $dst = Join-Path $targetDir $ext
    if (-not (Test-Path $src)) {
        Write-Warning "Skipping '$ext' - source not found at '$src'"
        continue
    }
    # Clean target first so stale files from previous versions are removed
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    Get-ChildItem $src | Copy-Item -Destination $dst -Recurse -Force
    # Install npm dependencies if a package.json exists (e.g. visual-review has runtime deps)
    $pkgJson = Join-Path $dst "package.json"
    if (Test-Path $pkgJson) {
        $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
        if ($npmCmd) {
            Push-Location $dst
            & npm install --omit=dev --no-fund --no-audit 2>$null | Out-Null
            Pop-Location
        }
    }
    $installed += [string]$ext
}

foreach ($dir in $sharedDirs) {
    $src = Join-Path $sourceDir $dir
    $dst = Join-Path $targetDir $dir
    if (-not (Test-Path $src)) {
        Write-Warning "Skipping shared dir '$dir' - source not found at '$src'"
        continue
    }
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    Get-ChildItem $src | Copy-Item -Destination $dst -Recurse -Force
    $installed += [string]$dir
}

# Preflight warnings
[string[]]$missingTools = @()
if (-not (Get-Command copilot -ErrorAction SilentlyContinue)) { $missingTools += "copilot (GitHub Copilot CLI)" }
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { $missingTools += "az (Azure CLI)" }

Write-Host ""
Write-Host "Installed to: $targetDir" -ForegroundColor Green
foreach ($item in $installed) {
    Write-Host "  - $item" -ForegroundColor Cyan
}
if ($missingTools.Count -gt 0) {
    Write-Host ""
    Write-Host "Warning: The following tools were not found on PATH:" -ForegroundColor Yellow
    foreach ($tool in $missingTools) { Write-Host "  - $tool" -ForegroundColor Yellow }
    Write-Host "Extensions require these at runtime." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Run '/clear' in the Copilot CLI or restart it to load the new extensions." -ForegroundColor Yellow
