# install-extensions.ps1 — Install Copilot CLI extensions from this repo
# Works on Windows PowerShell 5.1+ and pwsh 7+

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$sourceDir = Join-Path $repoRoot "extensions"
$targetDir = Join-Path $HOME ".copilot" "extensions"

if (-not (Test-Path $sourceDir)) {
    Write-Error "extensions/ directory not found at '$sourceDir'. Run this script from the repo root."
    exit 1
}

$extensions = @("ado-pr-watcher", "ado-build-watcher")
$sharedDirs = @("lib")
$installed = @()

foreach ($ext in $extensions) {
    $src = Join-Path $sourceDir $ext
    $dst = Join-Path $targetDir $ext
    if (-not (Test-Path $src)) {
        Write-Warning "Skipping '$ext' — source not found at '$src'"
        continue
    }
    if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
    Copy-Item (Join-Path $src "*") $dst -Force -Recurse
    $installed += $ext
}

foreach ($dir in $sharedDirs) {
    $src = Join-Path $sourceDir $dir
    $dst = Join-Path $targetDir $dir
    if (-not (Test-Path $src)) {
        Write-Warning "Skipping shared dir '$dir' — source not found at '$src'"
        continue
    }
    if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
    Copy-Item (Join-Path $src "*") $dst -Force -Recurse
    $installed += $dir
}

Write-Host ""
Write-Host "Installed to: $targetDir" -ForegroundColor Green
foreach ($item in $installed) {
    Write-Host "  - $item" -ForegroundColor Cyan
}
Write-Host ""
Write-Host "Run '/clear' in the Copilot CLI or restart it to load the new extensions." -ForegroundColor Yellow
