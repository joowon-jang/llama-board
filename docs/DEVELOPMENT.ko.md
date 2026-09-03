# 개발

> **언어:** [English](DEVELOPMENT.md) | [한국어](DEVELOPMENT.ko.md) | [日本語](DEVELOPMENT.ja.md) | [中文](DEVELOPMENT.zh.md)

## 요구사항

- Windows 10/11 x64
- Node `22.23.2` / npm `12.0.2` (`.node-version`, `package.json#engines`)
- Rust `1.98.0` + `rustfmt`/`clippy` (`rust-toolchain.toml`)
- Tauri v2 사전 요구사항
- 스모크 테스트용 `llama-server.exe` 또는 관리형 런타임
- PR 빌드: 백엔드별 CMake + 툴체인/SDK (`cuda`→CUDA Toolkit, `vulkan`→Vulkan SDK, `rocm`→HIP SDK + `hipcc`)

툴체인을 올릴 때는 `.node-version`와 `package.json#engines`를 함께 수정하고, `rust-toolchain.toml`, `src-tauri/Cargo.toml#rust-version`, `.github/workflows/{ci,release}.yml`의 `toolchain:`도 함께 수정하세요.

## 클론 및 실행

```bash
git clone https://github.com/joowon-jang/llama-board.git
cd llama-board
npm install
npm run tauri -- dev
# 런타임: %APPDATA%/llama-board/runtimes/{build}-{backend}/
```

## 검증

```bash
npm test              # 직접 스크립트 + Vitest 커버리지
npm run typecheck
npm run build
npm run lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml

# 단일 Vitest 파일
npm run test:ui -- <path>
```

### 실제 모델 smoke 테스트 (선택)

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

`npm test`는 `test:run-direct-tests` + `test:direct` + `test:coverage`(`vitest run --coverage`)를 실행합니다.

## 패키징

```bash
npm run package:tauri
# -> src-tauri/target/release/bundle/nsis/ , .../msi/
```
