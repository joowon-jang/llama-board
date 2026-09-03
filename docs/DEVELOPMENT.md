# Development

> **Language:** [English](DEVELOPMENT.md) | [한국어](DEVELOPMENT.ko.md) | [日本語](DEVELOPMENT.ja.md) | [中文](DEVELOPMENT.zh.md)

## Requirements

- Windows 10/11 x64
- Node `22.23.2` / npm `12.0.2` (`.node-version`, `package.json#engines`)
- Rust `1.98.0` + `rustfmt`/`clippy` (`rust-toolchain.toml`)
- Tauri v2 prerequisites
- `llama-server.exe` or managed runtime for smoke tests
- For PR builds: CMake + toolchain/SDK per backend (`cuda`→CUDA Toolkit, `vulkan`→Vulkan SDK, `rocm`→HIP SDK + `hipcc`)

Bump toolchain: `.node-version` + `package.json#engines` together; `rust-toolchain.toml` + `src-tauri/Cargo.toml#rust-version` + `.github/workflows/{ci,release}.yml` `toolchain:` together.

## Clone and run

```bash
git clone https://github.com/joowon-jang/llama-board.git
cd llama-board
npm install
npm run tauri -- dev
# Runtimes: %APPDATA%/llama-board/runtimes/{build}-{backend}/
```

## Validation

```bash
npm test              # direct scripts + vitest coverage
npm run typecheck
npm run build
npm run lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml

# Single Vitest file
npm run test:ui -- <path>

```

### Real-model smoke (opt-in)

PowerShell:

```powershell
cd src-tauri
$env:LLAMA_BOARD_SMOKE = "1"
$env:LLAMA_BOARD_SMOKE_MODEL = "C:\path\to\model.gguf"
cargo test --test smoke -- --nocapture
```

Bash / Git Bash:

```bash
cd src-tauri
LLAMA_BOARD_SMOKE=1 LLAMA_BOARD_SMOKE_MODEL='C:/path/to/model.gguf' cargo test --test smoke -- --nocapture
```

`npm test` runs `test:run-direct-tests` + `test:direct` + `test:coverage` (`vitest run --coverage`).

## Packaging

```bash
npm run package:tauri  # builds CLI first
# -> src-tauri/target/release/bundle/nsis/ , .../msi/
```
