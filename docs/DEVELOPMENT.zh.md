# 开发

> **语言:** [English](DEVELOPMENT.md) | [한국어](DEVELOPMENT.ko.md) | [日本語](DEVELOPMENT.ja.md) | [中文](DEVELOPMENT.zh.md)

## 要求

- Windows 10/11 x64
- Node `22.23.2` / npm `12.0.2`（`.node-version`、`package.json#engines`）
- Rust `1.98.0` + `rustfmt`/`clippy` (`rust-toolchain.toml`)
- Tauri v2 前置条件
- 用于冒烟测试的 `llama-server.exe` 或托管运行时
- PR 构建：按后端需要的 CMake + 工具链/SDK（`cuda`→CUDA Toolkit，`vulkan`→Vulkan SDK，`rocm`→HIP SDK + `hipcc`）

升级工具链时，请同时更新 `.node-version` 与 `package.json#engines`，以及 `rust-toolchain.toml`、`src-tauri/Cargo.toml#rust-version` 和 `.github/workflows/{ci,release}.yml` 中的 `toolchain:`。

## 克隆与运行

```bash
git clone https://github.com/joowon-jang/llama-board.git
cd llama-board
npm install
npm run tauri -- dev
# 运行时：%APPDATA%/llama-board/runtimes/{build}-{backend}/
```

## 验证

```bash
npm test              # 直接脚本 + Vitest 覆盖率
npm run typecheck
npm run build
npm run lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml

# 单个 Vitest 文件
npm run test:ui -- <path>
```

### 真实模型 smoke 测试（可选）

PowerShell：

```powershell
cd src-tauri
$env:LLAMA_BOARD_SMOKE = "1"
$env:LLAMA_BOARD_SMOKE_MODEL = "C:\path\to\model.gguf"
cargo test --test smoke -- --nocapture
```

Bash / Git Bash：

```bash
cd src-tauri
LLAMA_BOARD_SMOKE=1 LLAMA_BOARD_SMOKE_MODEL='C:/path/to/model.gguf' cargo test --test smoke -- --nocapture
```

`npm test` 会运行 `test:run-direct-tests` + `test:direct` + `test:coverage`（`vitest run --coverage`）。

## 打包

```bash
npm run package:tauri
# -> src-tauri/target/release/bundle/nsis/ , .../msi/
```
