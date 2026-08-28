[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 999999999999999999)]
  [UInt64]$PullRequest,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$Commit,
  [Parameter(Mandatory = $true)]
  [ValidateSet('cpu')]
  [string]$Backend,
  [Parameter(Mandatory = $true)]
  [string]$SourceRoot,
  [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
  [string]$Repository = 'ggml-org/llama.cpp',
  [ValidateLength(0, 255)]
  [string]$HeadRef = '',
  [string]$Author = '',
  [ValidateSet('open', 'closed', 'merged', 'unknown')]
  [string]$State = 'open',
  [bool]$Fork = $false,
  [Parameter(Mandatory = $true)]
  [string]$RuntimeRoot,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

function Write-Utf8Json([string]$Path, [object]$Value) {
  $json = $Value | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Find-MsvcRuntimeDirectories {
  $roots = @()
  if ($env:VCToolsRedistDir) {
    $roots += $env:VCToolsRedistDir
  }
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
    $installations = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    foreach ($installation in $installations) {
      if ($installation) {
        $roots += (Join-Path $installation 'VC\Redist\MSVC')
      }
    }
  }
  $directories = [System.Collections.Generic.List[string]]::new()
  foreach ($root in ($roots | Select-Object -Unique)) {
    $architectureRoots = Get-ChildItem -LiteralPath $root -Directory -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ieq 'x64' }
    foreach ($architectureRoot in $architectureRoots) {
      $candidates = @($architectureRoot)
      $candidates += Get-ChildItem -LiteralPath $architectureRoot.FullName -Directory -ErrorAction SilentlyContinue
      foreach ($candidate in $candidates) {
        $runtime = Join-Path $candidate.FullName 'vcruntime140.dll'
        $cpp = Join-Path $candidate.FullName 'msvcp140.dll'
        $openmp = Join-Path $candidate.FullName 'vcomp140.dll'
        if (((Test-Path -LiteralPath $runtime -PathType Leaf) -and (Test-Path -LiteralPath $cpp -PathType Leaf)) -or (Test-Path -LiteralPath $openmp -PathType Leaf)) {
          if (-not $directories.Contains($candidate.FullName)) {
            $directories.Add($candidate.FullName)
          }
        }
      }
    }
  }
  $system32 = Join-Path $env:SystemRoot 'System32'
  if ((Test-Path -LiteralPath (Join-Path $system32 'vcruntime140.dll') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $system32 'msvcp140.dll') -PathType Leaf)) {
    if (-not $directories.Contains($system32)) {
      $directories.Add($system32)
    }
  }
  if ($directories.Count -eq 0) {
    throw 'Could not locate the x64 MSVC redistributable DLL directories.'
  }
  $directories | Sort-Object -Descending
}

$sourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$runtimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$outputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$build = "pr$PullRequest"
$rootName = "$build-$Backend"
$packageParent = Join-Path ([System.IO.Path]::GetTempPath()) ("llama-board-pr-runtime-" + [Guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $packageParent $rootName
$archivePath = Join-Path $outputDirectory "llama-board-$rootName-win-x64.zip"

try {
  New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  Copy-Item -Path (Join-Path $runtimeRoot '*') -Destination $packageRoot -Recurse -Force
  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $crtDirectories = @(Find-MsvcRuntimeDirectories)
    foreach ($crtDirectory in $crtDirectories) {
      Get-ChildItem -LiteralPath $crtDirectory -File -Filter '*.dll' | Where-Object {
        $crtDirectoryName = Split-Path -Leaf $crtDirectory
        $crtDirectoryName -ine 'System32' -or $_.Name -match '^(msvcp140|vcruntime140|vcomp140|concrt140)'
      } | Copy-Item -Destination $packageRoot -Force
    }
  }

  $server = Join-Path $packageRoot 'llama-server.exe'
  $bench = Join-Path $packageRoot 'llama-bench.exe'
  if (-not (Test-Path -LiteralPath $server -PathType Leaf) -or -not (Test-Path -LiteralPath $bench -PathType Leaf)) {
    throw "The runtime directory must contain llama-server.exe and llama-bench.exe."
  }

  $checkedOutRef = ''
  try {
    $checkedOutRef = (& git -C $sourceRoot symbolic-ref --short HEAD 2>$null).Trim()
  } catch {
    $checkedOutRef = ''
  }
  $source = [ordered]@{
    pull_request = [UInt64]$PullRequest
    repository = $Repository
    head_ref = if ([string]::IsNullOrWhiteSpace($HeadRef)) { $checkedOutRef } else { $HeadRef }
    author = $Author
    state = $State
    fork = $Fork
    commit = $Commit.ToLowerInvariant()
    archive_sha256 = ''
    commit_check = 'github-actions-checkout-ref'
    url = "https://github.com/ggml-org/llama.cpp/pull/$PullRequest"
  }

  Write-Utf8Json (Join-Path $packageRoot 'llama-board-runtime-source.json') $source

  $filesByPath = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
  Get-ChildItem -LiteralPath $packageRoot -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($packageRoot.Length + 1).Replace('\', '/')
    $filesByPath.Add($relative, $_)
  }
  $relativePaths = [System.Collections.Generic.List[string]]::new()
  foreach ($relative in $filesByPath.Keys) {
    $relativePaths.Add($relative)
  }
  $relativePaths.Sort([System.StringComparer]::Ordinal)
  $manifestFiles = @(
    foreach ($relative in $relativePaths) {
      $file = $filesByPath[$relative]
      [ordered]@{
        path = $relative
        bytes = [UInt64]$file.Length
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
  )
  if ($manifestFiles.Count -eq 0) {
    throw 'The runtime package is empty.'
  }
  $manifest = [ordered]@{
    format = 1
    backend = $Backend
    build = $build
    platform = 'win'
    architecture = 'x64'
    version = $null
    source = $source
    files = $manifestFiles
  }
  $manifestPath = Join-Path $packageRoot 'llama-board-runtime-bundle.json'
  Write-Utf8Json $manifestPath $manifest

  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $packageParent,
    $archivePath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksumLine = "$hash  $(Split-Path -Leaf $archivePath)"
  $checksumLine | Set-Content -LiteralPath (Join-Path $outputDirectory 'checksums.txt') -Encoding ascii
  $checksumLine | Set-Content -LiteralPath ($archivePath + '.sha256') -Encoding ascii
  Write-Host "Created $archivePath"
  Write-Host "SHA-256 $hash"
} finally {
  if (Test-Path -LiteralPath $packageParent) {
    Remove-Item -LiteralPath $packageParent -Recurse -Force -ErrorAction SilentlyContinue
  }
}
