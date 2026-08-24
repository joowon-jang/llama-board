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

## Download

The repository is public. The one-line installer downloads the latest Windows NSIS release, verifies its SHA-256 digest, and installs it silently.

### PowerShell — one-line install (recommended)

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/joowon-jang/llama-board/main/install.ps1 | iex"
```

The same command works from `cmd.exe`, Git Bash, or another terminal that can start PowerShell:

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/joowon-jang/llama-board/main/install.ps1 | iex"
```

The installer defaults to the NSIS package. To install the MSI package instead, set the environment variable first:

```powershell
$env:LLAMA_BOARD_INSTALLER = "msi"
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/joowon-jang/llama-board/main/install.ps1 | iex"
```

Useful installer options:

```powershell
# Install a specific release tag
$env:LLAMA_BOARD_RELEASE = "v0.1.0-llama-board"

# Download and verify without running the installer
$env:LLAMA_BOARD_DRY_RUN = "1"
```

Installer source: <https://github.com/joowon-jang/llama-board/blob/main/install.ps1>

Release page: <https://github.com/joowon-jang/llama-board/releases/latest>

### Clone the source

```bash
git clone https://github.com/joowon-jang/llama-board.git
cd llama-board
```

Managed runtimes are stored separately from WinGet binaries. Runtime archives are staged, required binaries are checked, and the GitHub-published SHA-256 digest is verified before activation:

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
cd src-tauri && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test
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

The app launches and supervises `llama-server.exe`, binds it to loopback, polls both `/health` and `/v1/models`, streams `/v1/chat/completions`, and terminates/reaps the child process when the app exits. It does not bundle model files or runtime binaries in the repository.

Each server start receives a fresh process-local bearer token. The token is returned only to the current WebView through the server status command and is never printed in logs or installer output.

## Security and updates

- Runtime downloads require HTTPS GitHub hosts and a release asset SHA-256 digest; unverified archives are refused.
- The app uses a restrictive Tauri CSP and only connects to the local loopback server plus the GitHub release APIs.
- The convenience bootstrap command below executes the `main` branch script. For a reproducible install, prefer a release-pinned asset after a release workflow has published it:

  ```powershell
  powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
  ```

- App updates are currently manual: download a new signed release installer when signing is configured, or verify its published SHA-256 digest before installing. The app installer and llama.cpp runtime updates are independent.

In managed environments, use a reviewed script file instead of piping a moving branch directly into `iex`.

## License

This project is distributed under the MIT License; see [`LICENSE`](LICENSE). llama.cpp and its runtime binaries remain subject to their respective upstream licenses; see [`NOTICE`](NOTICE).
