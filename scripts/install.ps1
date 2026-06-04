# Install script for tila CLI (Windows)
# Usage: irm https://github.com/davebream/tila/releases/latest/download/install.ps1 | iex
#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$InstallDir = "$env:USERPROFILE\.tila\bin"
$BinaryName = "tila.exe"
$GitHubRepo = "davebream/tila"
$BaseUrl = "https://github.com/$GitHubRepo/releases/download"

# --- Platform detection ---
function Get-Platform {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($arch) {
        "X64"   { return "x64" }
        "Arm64" { return "arm64" }
        default {
            Write-Error "Unsupported architecture: $arch. Download manually from https://github.com/$GitHubRepo/releases or use: npm install -g tila-cli"
            exit 1
        }
    }
}

# --- Version resolution ---
function Get-ReleaseTag {
    if ($env:TILA_VERSION) {
        return $env:TILA_VERSION
    }

    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GitHubRepo/releases/latest" -UseBasicParsing
        return $release.tag_name
    } catch {
        Write-Error "Failed to resolve latest release version from GitHub API. This may be due to rate limiting. Set `$env:TILA_VERSION='v0.1.0'` and re-run."
        exit 1
    }
}

# --- Main ---
$PlatformArch = Get-Platform
$ReleaseTag = Get-ReleaseTag
$BinaryFilename = "tila-windows-$PlatformArch.exe"
$BinaryUrl = "$BaseUrl/$ReleaseTag/$BinaryFilename"
$ChecksumUrl = "$BaseUrl/$ReleaseTag/checksums.txt"

Write-Host "tila installer (Windows)" -ForegroundColor Cyan
Write-Host ""

# --- Upgrade check ---
$ExistingBinary = Join-Path $InstallDir $BinaryName
if (Test-Path $ExistingBinary) {
    try {
        $installedVersion = & $ExistingBinary --version 2>$null
        $tagVersion = $ReleaseTag -replace '^v', ''
        if ($installedVersion -eq $tagVersion -or $installedVersion -eq $ReleaseTag) {
            Write-Host "Already at $ReleaseTag. Reinstalling."
        } else {
            Write-Host "Upgrading $installedVersion -> $ReleaseTag."
        }
    } catch {
        Write-Host "Existing installation detected. Reinstalling."
    }
}

# --- Download ---
$TmpDir = Join-Path $env:TEMP "tila-install-$(Get-Random)"
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

try {
    Write-Host "Downloading $BinaryFilename ($ReleaseTag)..."
    Invoke-WebRequest -Uri $BinaryUrl -OutFile (Join-Path $TmpDir $BinaryFilename) -UseBasicParsing

    Write-Host "Downloading checksums..."
    Invoke-WebRequest -Uri $ChecksumUrl -OutFile (Join-Path $TmpDir "checksums.txt") -UseBasicParsing

    # --- Hash verification ---
    Write-Host "Verifying SHA-256 checksum..."
    $checksumContent = Get-Content (Join-Path $TmpDir "checksums.txt")
    $expectedLine = $checksumContent | Select-String -Pattern $BinaryFilename
    if (-not $expectedLine) {
        Write-Error "Binary $BinaryFilename not found in checksums.txt"
        exit 1
    }
    $expectedHash = ($expectedLine -split '\s+')[0]

    $actualHash = (Get-FileHash (Join-Path $TmpDir $BinaryFilename) -Algorithm SHA256).Hash.ToLower()

    if ($actualHash -ne $expectedHash) {
        Write-Error @"
SHA-256 checksum mismatch for $BinaryFilename.
  Expected: $expectedHash
  Actual:   $actualHash
Download may be corrupt or tampered. Aborting.
"@
        exit 1
    }
    Write-Host "Checksum verified." -ForegroundColor Green

    # --- Install ---
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $TmpBinary = Join-Path $TmpDir $BinaryFilename
    $FinalBinary = Join-Path $InstallDir $BinaryName
    Move-Item -Path $TmpBinary -Destination $FinalBinary -Force

    Write-Host "Installed to $FinalBinary"

    # --- PATH update ---
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*\.tila\bin*") {
        [Environment]::SetEnvironmentVariable("PATH", "$userPath;$InstallDir", "User")
        Write-Host ""
        Write-Host "Added $InstallDir to user PATH."
        Write-Host "Restart your terminal for PATH changes to take effect." -ForegroundColor Yellow
    }

    # --- SmartScreen notice ---
    Write-Host ""
    Write-Host "NOTE: Windows SmartScreen may block the unsigned binary." -ForegroundColor Yellow
    Write-Host "If blocked, right-click the file -> Properties -> check 'Unblock', or run:"
    Write-Host "  Unblock-File `"$FinalBinary`""

    # --- Final check ---
    Write-Host ""
    try {
        $versionOutput = & $FinalBinary --version 2>$null
        Write-Host "tila $versionOutput installed successfully." -ForegroundColor Green
    } catch {
        Write-Host "Installation complete. Restart terminal and run: tila --version" -ForegroundColor Green
    }
} finally {
    # Cleanup temp directory
    if (Test-Path $TmpDir) {
        Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    }
}
