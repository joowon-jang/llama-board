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
$scriptUrl = "https://raw.githubusercontent.com/$Repository/main/scripts/install.ps1"
$script = Invoke-WebRequest -Uri $scriptUrl -UseBasicParsing
& ([scriptblock]::Create($script.Content)) @PSBoundParameters
