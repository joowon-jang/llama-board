# llama-board

Windows desktop runtime manager for `llama.cpp`.

`llama-board` wraps the official `llama-server.exe` and `llama-bench.exe` binaries instead of reimplementing llama.cpp. It provides a native Tauri v2 desktop UI for managing models, runtimes, server settings, streaming chat, and benchmarks.

## Features

- Windows x64 Tauri v2 + React + TypeScript application
- GGUF model discovery under `~/.lmstudio/models` or a selected directory
- Managed llama.cpp runtime installation and selection for CPU, Vulkan, ROCm, CUDA, SYCL, and OpenVINO
- WinGet-compatible `llama-server.exe` execution with health polling, restart, and cleanup
- OpenAI-compatible streaming chat with local Bearer authentication
- Separate collapsible reasoning (`reasoning_content`) and answer content for reasoning models
- Server-side tuning: GPU layers, context size, CPU MoE, threads, and flash attention
- Sampling tuning: temperature, top-p, and top-k
- `llama-bench` execution with CSV/TSV parsing and result tables
- Responsive layout for narrow and wide desktop windows
- NSIS and MSI Windows installers

Managed runtimes are stored separately from WinGet binaries:

```text
%APPDATA%/llama-board/runtimes/{build}-{backend}/
```

## Development

Requirements:

- Windows 10/11 x64
- Node.js and npm
- Rust toolchain
- Tauri v2 prerequisites
- A local `llama-server.exe` or an installed managed runtime for live smoke tests

Install dependencies and run the development app:

```bash
npm install
npm run tauri dev
```

Run validation and build checks:

```bash
npm run test:tuning
npx tsc --noEmit -p tsconfig.json
npm run build
cd src-tauri && cargo test
```

The real-model smoke test is gated so it does not run accidentally:

```bash
cd src-tauri
LLAMA_BOARD_SMOKE=1 \
LLAMA_BOARD_SMOKE_MODEL='C:/path/to/model.gguf' \
cargo test --test smoke -- --nocapture
```

## Packaging

Build the Windows release bundles:

```bash
npm run tauri build
```

Installers are written to:

```text
src-tauri/target/release/bundle/nsis/
src-tauri/target/release/bundle/msi/
```

## Runtime behavior

The app launches and supervises `llama-server.exe`, polls `/health`, streams `/v1/chat/completions`, and terminates the child process when the app exits. It does not bundle model files or runtime binaries in the repository.

The local server uses a fixed app-local authentication value for requests between the UI and the supervised server; no user credential is stored in the project.

## License

This project is distributed as the `llama-board` application. llama.cpp and its runtime binaries remain subject to their respective upstream licenses.
