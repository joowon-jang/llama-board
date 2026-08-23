param(
  [Parameter(Mandatory=$true)][string]$Repository,
  [string]$Version = "latest",
  [ValidateSet("cpu", "vulkan", "cuda", "hip-rocm", "sycl")]
  [string]$Backend = "cpu",
  [string]$InstallRoot = "$env:LOCALAPPDATA\LlamaForge"
)

$ErrorActionPreference = "Stop"
$headers = @{ Accept = "application/vnd.github+json"; "User-Agent" = "llama-forge-runtime-installer" }
$releaseUrl = if ($Version -eq "latest") { "https://api.github.com/repos/$Repository/releases/latest" } else { "https://api.github.com/repos/$Repository/releases/tags/$Version" }
$release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers
$assetName = "llama-runtime-$Backend-windows-x64.zip"
$asset = @($release.assets) | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
$checksums = @($release.assets) | Where-Object { $_.name -match "checksums\.txt$" } | Select-Object -First 1
if (-not $asset -or -not $checksums) { throw "Release $($release.tag_name) has no $assetName and checksum manifest." }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("llama-forge-runtime-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $zip = Join-Path $temp $assetName
  $checksumPath = Join-Path $temp "checksums.txt"
  Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $zip
  Invoke-WebRequest -Uri $checksums.browser_download_url -Headers $headers -OutFile $checksumPath
  $expectedLine = Select-String -Path $checksumPath -Pattern ([regex]::Escape($assetName)) | Select-Object -First 1
  if (-not $expectedLine) { throw "No checksum entry for $assetName." }
  $expected = ($expectedLine.Line -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { throw "SHA-256 mismatch for $assetName." }

  $versionDir = Join-Path $InstallRoot ("runtimes\windows-x64\$Backend\$($release.tag_name)")
  New-Item -ItemType Directory -Force -Path $versionDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $versionDir -Force
  $pointer = [ordered]@{ backend = $Backend; version = $release.tag_name; path = $versionDir; installed_at = (Get-Date).ToUniversalTime().ToString("o") }
  $pointer | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $InstallRoot ("runtimes\windows-x64\$Backend\current.json"))
  Write-Output "Installed llama.cpp $Backend runtime $($release.tag_name) at $versionDir"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
