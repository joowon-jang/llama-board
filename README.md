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

The repository is private, so downloading requires a GitHub account with read access and an authenticated GitHub CLI (`gh`). Check authentication first:

```bash
gh auth status
```

If needed, authenticate once with `gh auth login`.

### PowerShell — NSIS installer (recommended)

```powershell
$repo = "joowon-jang/llama-board"
$tag = gh release view --repo $repo --json tagName --jq .tagName
gh release download $tag `
  --repo $repo `
  --pattern "llama-board_*_x64-setup.exe" `
  --dir .

$installer = Get-ChildItem -File -Filter "llama-board_*_x64-setup.exe" |
  Select-Object -First 1
Start-Process -FilePath $installer.FullName
```

### PowerShell — MSI installer

```powershell
$repo = "joowon-jang/llama-board"
$tag = gh release view --repo $repo --json tagName --jq .tagName
gh release download $tag `
  --repo $repo `
  --pattern "llama-board_*_x64_en-US.msi" `
  --dir .
```

### Bash, Git Bash, or WSL

```bash
repo='joowon-jang/llama-board'
tag="$(gh release view --repo "$repo" --json tagName --jq .tagName)"
gh release download "$tag" \
  --repo "$repo" \
  --pattern 'llama-board_*_x64-setup.exe' \
  --dir .
```

To download the MSI instead:

```bash
gh release download "$tag" \
  --repo "$repo" \
  --pattern 'llama-board_*_x64_en-US.msi' \
  --dir .
```

Verify the downloaded installer:

```powershell
Get-FileHash .\llama-board_*_x64-setup.exe -Algorithm SHA256
```

```bash
sha256sum llama-board_*_x64-setup.exe
```

Release page: <https://github.com/joowon-jang/llama-board/releases/latest>

### Clone the source with GitHub CLI

```bash
gh repo clone joowon-jang/llama-board
cd llama-board
```

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
