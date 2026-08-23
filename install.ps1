param(
  [string]$Repository = $(if ($env:LLAMA_FORGE_REPOSITORY) { $env:LLAMA_FORGE_REPOSITORY } else { "joowon-jang/llama-chat" }),
  [string]$Version = "latest",
  [string]$InstallDir = "$env:LOCALAPPDATA\LlamaForge",
  [ValidateSet("cpu", "vulkan", "cuda", "hip-rocm", "sycl")]
  [string]$Backend = "cpu",
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Repository) -or $Repository -eq "<owner>/llama-command-builder") {
  throw "Set -Repository owner/llama-command-builder or LLAMA_FORGE_REPOSITORY before running the installer."
}
$scriptUrl = "https://raw.githubusercontent.com/$Repository/main/scripts/install.ps1"
$script = Invoke-WebRequest -Uri $scriptUrl -UseBasicParsing
& ([scriptblock]::Create($script.Content)) @PSBoundParameters
