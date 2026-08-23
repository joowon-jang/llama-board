# Llama Board

Llama Board is a Windows-first desktop app for running `llama.cpp`, monitoring its local endpoint, and chatting with the model without leaving the app.

## Main features

- Direct `llama-server` launch with no shell interpolation.
- Backend/device discovery for CPU, Vulkan, CUDA/cuBLAS, HIP/ROCm, SYCL/oneAPI, and future runtime-reported devices.
- OpenAI-compatible native endpoint:
  - `http://127.0.0.1:8080/v1/chat/completions`
- Anthropic Messages-compatible local gateway:
  - `http://127.0.0.1:8081/v1/messages`
  - headers: `x-api-key`, `anthropic-version`
  - translates to/from llama.cpp's OpenAI-compatible endpoint.
- Streaming chat with reasoning traces, tool-use blocks, cancellation, conversations, and runtime logs.
- Secondary command builder for PowerShell, CMD, and POSIX previews.
- GitHub release/update workflow and checksum-verified PowerShell installation scripts.

## Development

```powershell
pnpm install --ignore-scripts
pnpm build
scripts\\build-msvc.cmd
scripts\\test-msvc.cmd
scripts\\build-tauri.cmd
```

The Windows Tauri build requires Rust, Visual Studio C++ Build Tools, and WebView2.

## Endpoint usage

Start the app, choose a GGUF and runtime, then click **Start llama.cpp**. The native OpenAI-compatible endpoint is served by llama.cpp. The app's Anthropic gateway listens on `127.0.0.1:8081` and forwards official Messages API requests to the selected local llama.cpp endpoint.

Example Anthropic request:

```powershell
$body = @{
  model = "local-model"
  max_tokens = 512
  messages = @(@{ role = "user"; content = "Hello from Anthropic format" })
  stream = $true
} | ConvertTo-Json -Depth 8

Invoke-RestMethod http://127.0.0.1:8081/v1/messages `
  -Method Post `
  -Headers @{ "anthropic-version" = "2023-06-01"; "x-api-key" = "local" } `
  -ContentType "application/json" `
  -Body $body
```

## GitHub installation

After the repository owner is configured and a release is published:

```powershell
irm https://raw.githubusercontent.com/joowon-jang/llama-board/main/install.ps1 | iex
```

The root-level public URL should be used after `scripts/install.ps1` is promoted to `install.ps1` in the repository root. The installer verifies the release checksum before running the Windows installer.
