[CmdletBinding()]
param(
    [string]$Release = $(if ([string]::IsNullOrWhiteSpace($env:LLAMA_BOARD_RELEASE)) { "latest" } else { $env:LLAMA_BOARD_RELEASE }),
    [ValidateSet("nsis", "msi")]
    [string]$Installer = $(if ([string]::IsNullOrWhiteSpace($env:LLAMA_BOARD_INSTALLER)) { "nsis" } else { $env:LLAMA_BOARD_INSTALLER }),
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repository = "joowon-jang/llama-board"
$ApiHeaders = @{
    Accept = "application/vnd.github+json"
    "User-Agent" = "llama-board-installer"
}

if ($Release -ne "latest" -and $Release -notmatch "^[A-Za-z0-9._-]+$") {
    throw "Invalid release value: $Release"
}

if (-not $DryRun -and $env:LLAMA_BOARD_DRY_RUN -match "^(?i:1|true|yes)$") {
    $DryRun = $true
}

$releaseUri = if ($Release -eq "latest") {
    "https://api.github.com/repos/$Repository/releases/latest"
} else {
    "https://api.github.com/repos/$Repository/releases/tags/$Release"
}

Write-Host "==> Resolving llama-board release ($Release)"
$releaseMetadata = Invoke-RestMethod -UseBasicParsing -Uri $releaseUri -Headers $ApiHeaders

$assetPattern = if ($Installer -eq "msi") {
    "llama-board_*_x64_en-US.msi"
} else {
    "llama-board_*_x64-setup.exe"
}
$asset = @($releaseMetadata.assets | Where-Object { $_.name -like $assetPattern }) | Select-Object -First 1
if ($null -eq $asset) {
    throw "Could not find installer asset matching '$assetPattern' in release '$($releaseMetadata.tag_name)'."
}

$digestMatch = [regex]::Match([string]$asset.digest, "^sha256:([0-9a-fA-F]{64})$")
if (-not $digestMatch.Success) {
    throw "Release asset '$($asset.name)' does not provide a SHA-256 digest."
}
$expectedDigest = $digestMatch.Groups[1].Value.ToLowerInvariant()

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("llama-board-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$installerPath = Join-Path $tempDir $asset.name

try {
    Write-Host "==> Downloading $($asset.name)"
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $installerPath

    $actualDigest = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualDigest -ne $expectedDigest) {
        throw "Installer SHA-256 mismatch. Expected $expectedDigest but received $actualDigest."
    }
    Write-Host "==> SHA-256 verified: $actualDigest"

    if ($DryRun) {
        Write-Host "==> Dry run complete: $installerPath"
        return
    }

    if ($Installer -eq "msi") {
        $process = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $installerPath, "/passive", "/norestart") -Wait -PassThru
    } else {
        $process = Start-Process -FilePath $installerPath -ArgumentList @("/S") -Wait -PassThru
    }

    if ($process.ExitCode -ne 0) {
        throw "Installer exited with code $($process.ExitCode)."
    }
    Write-Host "llama-board installed successfully."
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
