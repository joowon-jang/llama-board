# llama-board

> **语言:** [English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md)

`llama.cpp` 的 Windows 桌面运行时管理器。通过 Tauri v2 桌面 UI 封装 `llama-server` / `llama-bench`，管理模型、运行时、聊天和基准测试。

## 功能

- GGUF 模型发现与安全管理
- 运行时管理（CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO）与便携式 ZIP 支持
- 通过编号/URL 进行 PR 构建与来源审核
- 流式聊天、本地线程、文档上下文与嵌入
- 项目、Hugging Face Discover、开发者/MCP 网关
- 服务器/采样调优

## 平台支持

目前支持 Windows x64。**计划支持 Linux（包括 NVIDIA DGX）和 macOS**。Linux/macOS 将使用 `curl | tar`，Windows 使用 `NSIS`/`MSI`。完成 SignPath Foundation 接入并获得手动批准后，Windows 发布安装程序会由 GitHub 托管的 CI 使用 Authenticode 签名；请验证发布的签名和 SHA-256 校验和。

## 下载

从 [GitHub Releases](https://github.com/joowon-jang/llama-board/releases) 获取最新版本。

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

高级安装选项、验证、开发环境和 CLI 用法请参见 [docs/INSTALL.zh.md](docs/INSTALL.zh.md)、[docs/DEVELOPMENT.zh.md](docs/DEVELOPMENT.zh.md) 和 [docs/CLI.zh.md](docs/CLI.zh.md)。

## 代码签名政策 (Code signing policy)

请参阅 [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) 和 [PRIVACY.md](PRIVACY.md)，了解签名范围、角色、发布审批、隐私和卸载政策。

## 安全

请参见 [SECURITY.zh.md](SECURITY.zh.md)。

## 许可证

MIT — 见 [LICENSE](LICENSE)。llama.cpp 二进制文件 — 见 [NOTICE](NOTICE)。

