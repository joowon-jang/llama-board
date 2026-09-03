# 開発

> **言語:** [English](DEVELOPMENT.md) | [한국어](DEVELOPMENT.ko.md) | [日本語](DEVELOPMENT.ja.md) | [中文](DEVELOPMENT.zh.md)

## 要件

- Windows 10/11 x64
- Node `22.23.2` / npm `12.0.2`（`.node-version`, `package.json#engines`）
- Rust `1.98.0` + `rustfmt`/`clippy` (`rust-toolchain.toml`)
- Tauri v2 前提
- スモークテスト用 `llama-server.exe` または管理ランタイム
- PR ビルド: バックエンドごとの CMake + ツールチェーン/SDK（`cuda`→CUDA Toolkit、`vulkan`→Vulkan SDK、`rocm`→HIP SDK + `hipcc`）

ツールチェーンを更新するときは、`.node-version` と `package.json#engines`、`rust-toolchain.toml`、`src-tauri/Cargo.toml#rust-version`、`.github/workflows/{ci,release}.yml` の `toolchain:` を一緒に更新してください。

## クローンと実行

```bash
git clone https://github.com/joowon-jang/llama-board.git
cd llama-board
npm install
npm run tauri -- dev
# ランタイム: %APPDATA%/llama-board/runtimes/{build}-{backend}/
```

## 検証

```bash
npm test              # 直接スクリプト + Vitest カバレッジ
npm run typecheck
npm run build
npm run lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml

# 単一の Vitest ファイル
npm run test:ui -- <path>
```

### 実モデル smoke テスト（任意）

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

`npm test` は `test:run-direct-tests` + `test:direct` + `test:coverage`（`vitest run --coverage`）を実行します。

## パッケージング

```bash
npm run package:tauri
# -> src-tauri/target/release/bundle/nsis/ , .../msi/
```
