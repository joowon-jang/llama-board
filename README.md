# llama-board

> **Language:** [English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md)

Windows desktop runtime manager for `llama.cpp`. Wraps `llama-server` / `llama-bench` with a Tauri v2 desktop UI for models, runtimes, chat, and benchmarks.

## Features

- GGUF model discovery and safe management
- Managed runtimes (CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO) with portable ZIP support
- PR builds by number/URL with provenance review
- Streaming chat with local threads, document context, and embeddings
- Projects, Hugging Face Discover, and Developer/MCP gateways
- Tuning for server and sampling parameters

## Platform support

Windows x64 is supported today. **Linux (including NVIDIA DGX) and macOS support is planned**. Linux/macOS will use `curl | tar`; Windows uses `NSIS`/`MSI`. Windows release installers are Authenticode-signed when the release-publish certificate is configured; verify the published signature and SHA-256 checksum.

## Download

Get the latest release from [GitHub Releases](https://github.com/joowon-jang/llama-board/releases).

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

For advanced install options, verification, development setup, and CLI usage, see [docs/INSTALL.md](docs/INSTALL.md), [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), and [docs/CLI.md](docs/CLI.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE). llama.cpp binaries — see [NOTICE](NOTICE).
