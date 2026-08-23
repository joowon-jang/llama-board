param(
  [string]$Repository = $(if ($env:LLAMA_BOARD_REPOSITORY) { $env:LLAMA_BOARD_REPOSITORY } elseif ($env:LLAMA_FORGE_REPOSITORY) { $env:LLAMA_FORGE_REPOSITORY } else { "joowon-jang/llama-board" }),
  [string]$Version = "latest",
  [string]$InstallDir = "$env:LOCALAPPDATA\LlamaBoard",
  [ValidateSet("cpu", "vulkan", "cuda", "hip-rocm", "sycl")]
  [string]$Backend = "cpu",
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Repository) -or $Repository -eq "<owner>/llama-board") {
  throw "Set -Repository owner/llama-board or LLAMA_BOARD_REPOSITORY before running the installer."
}

$headers = @{ Accept = "application/vnd.github+json"; "User-Agent" = "llama-forge-installer" }
$releaseUrl = if ($Version -eq "latest") { "https://api.github.com/repos/$Repository/releases/latest" } else { "https://api.github.com/repos/$Repository/releases/tags/$Version" }
$release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers
$assets = @($release.assets)
$checksums = $assets | Where-Object { $_.name -match "checksums\.txt$" } | Select-Object -First 1
if (-not $checksums) { throw "Release $($release.tag_name) has no checksums.txt asset." }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("llama-forge-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $checksumPath = Join-Path $temp "checksums.txt"
  Invoke-WebRequest -Uri $checksums.browser_download_url -Headers $headers -OutFile $checksumPath
  $installer = $assets | Where-Object { $_.name -match "(?i)((setup|installer).*x64|x64.*(setup|installer)).*\.(exe|msi)$" } | Select-Object -First 1
  if (-not $installer) { throw "No Windows x64 installer found in release $($release.tag_name)." }

  $installerPath = Join-Path $temp $installer.name
  Invoke-WebRequest -Uri $installer.browser_download_url -Headers $headers -OutFile $installerPath
  $expectedLine = Select-String -Path $checksumPath -Pattern ([regex]::Escape($installer.name)) | Select-Object -First 1
  if ($installer.digest -match '^sha256:(.+)$') {
    $expected = $Matches[1].ToLowerInvariant()
  } elseif ($expectedLine) {
    $expected = ($expectedLine.Line -split '\s+')[0].ToLowerInvariant()
  } else {
    throw "No checksum or GitHub digest entry for $($installer.name)."
  }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $installerPath).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { throw "SHA-256 mismatch for $($installer.name)." }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  if ($installer.name.EndsWith('.msi')) {
    Start-Process msiexec.exe -ArgumentList "/i", $installerPath, "/qn", "/norestart" -Wait -Verb RunAs
  } else {
    Start-Process $installerPath -ArgumentList "/S" -Wait -Verb RunAs
  }

  if ($Backend -ne "cpu") {
    $runtimeScript = "https://raw.githubusercontent.com/$Repository/main/scripts/install-runtime.ps1"
    & ([scriptblock]::Create((Invoke-WebRequest -Uri $runtimeScript -Headers $headers).Content)) -Repository $Repository -Version $release.tag_name -Backend $Backend -InstallRoot $InstallDir
  }
  if (-not $NoLaunch) {
    $installed = Get-ChildItem -Path $InstallDir -Filter "Llama Board.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($installed) { Start-Process $installed.FullName }
  }
  Write-Output "Llama Board $($release.tag_name) installed successfully."
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
