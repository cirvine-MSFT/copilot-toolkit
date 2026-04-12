# install-extensions.ps1 — Install Copilot CLI extensions from this repo
# Works on Windows PowerShell 5.1+ and pwsh 7+

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

$extensions = @("ado-pr-watcher", "ado-build-watcher")
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
