# llama-board

> **언어:** [English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md)

`llama.cpp`용 Windows 데스크톱 런타임 매니저. `llama-server` / `llama-bench`를 Tauri v2 데스크톱 UI로 감싸 모델, 런타임, 채팅, 벤치마크를 관리합니다.

## 기능

- GGUF 모델 탐색 및 안전한 관리
- 런타임 관리(CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO)와 휴대용 ZIP 지원
- 번호/URL로 PR 빌드 및 출처 리뷰
- 스트리밍 채팅, 로컬 스레드, 문서 컨텍스트, 임베딩
- 프로젝트, Hugging Face Discover, 개발자/MCP 게이트웨이
- 서버/샘플링 튜닝

## 플랫폼 지원

현재 Windows x64를 지원합니다. **Linux(NVIDIA DGX 포함) 및 macOS 지원을 계획 중**입니다. Linux/macOS는 `curl | tar`, Windows는 `NSIS`/`MSI`를 사용합니다. Windows 릴리스 인스톨러는 SignPath Foundation 온보딩과 수동 승인 후 GitHub 호스팅 CI에서 Authenticode로 서명됩니다. 게시된 서명과 SHA-256 체크섬을 확인하세요.

## 다운로드

최신 릴리스는 [GitHub Releases](https://github.com/joowon-jang/llama-board/releases)에서 받으세요.

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

고급 설치 옵션, 검증, 개발 환경, CLI 사용법은 [docs/INSTALL.ko.md](docs/INSTALL.ko.md), [docs/DEVELOPMENT.ko.md](docs/DEVELOPMENT.ko.md), [docs/CLI.ko.md](docs/CLI.ko.md)를 참조하세요.

## 코드 서명 정책 (Code signing policy)

[CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)와 [PRIVACY.md](PRIVACY.md)에서 서명 범위, 역할, 릴리스 승인, 개인정보 및 제거 정책을 확인하세요. 관리자는 [SignPath Foundation 신청 체크리스트](docs/SIGNPATH_FOUNDATION.md)를 따라 설정할 수 있습니다.

## 보안

[SECURITY.ko.md](SECURITY.ko.md) 참조.

## 라이선스

MIT — [LICENSE](LICENSE) 참조. llama.cpp 바이너리 — [NOTICE](NOTICE) 참조.

