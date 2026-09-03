# 安全策略

> **语言:** [English](SECURITY.md) | [한국어](SECURITY.ko.md) | [日本語](SECURITY.ja.md) | [中文](SECURITY.zh.md)

## 报告

请勿公开提交 issue。请使用 [GitHub Security Advisories](https://github.com/joowon-jang/llama-board/security/advisories/new) 或私下联系维护者。包含最小复现，敏感信息用 `[REDACTED]` 替换。

## 范围

运行时归档验证、路径遍历、PR 源码构建来源、进程生命周期、本地端点暴露、安装程序完整性、Tauri 能力。

## 本地认证

桌面管理的服务器绑定到 `127.0.0.1`，每次启动通过临时 `--api-key-file` 传递 bearer token。临时文件会在启动后删除，Token 会在停止时清除。同一 Windows 用户权限运行的进程仍可能检查或操作服务器，这是预期行为。请勿共享端点或密钥。

无头 CLI 的 `server start` 模式不同：它会有意使用 `--no-api-key`，并依赖 `127.0.0.1` 绑定。任何能访问该端口的本地进程都可以调用它，因此只能在可信计算机上使用，不要将端口暴露或转发到外部。

开发者网关同样仅限本地使用。MCP 服务器是以用户权限启动的第三方可执行文件；只添加可信程序，并按照配置的批准策略检查工具调用。

## 预构建 PR 产物

便携式 ZIP 和工作流发布的 CPU 产物会验证 platform/arch/backend/build-id、GitHub 资产 SHA-256、文件级清单 SHA-256、嵌入的 PR 仓库/提交、必需可执行文件和正常预检。接收方 PC 无需 CMake/编译器/SDK，但 GPU 运行时需要兼容 GPU 驱动。工作流默认仅发布 CPU，GPU 需从带 SDK 的机器导出。

## 从源码构建 PR

以用户权限编译第三方代码。下载前显示来源（标题/作者/仓库/分支/提交/状态）并固定到该提交 — 如果 head 移动则拒绝。通过提交固定的 HTTPS 获取 PR 源码归档并检查预期的提交目录；GitHub 不会为该源码归档发布可信摘要，因此存储的 SHA-256 为本地审计记录。发布安装程序会在可用时使用 GitHub 资产摘要，否则使用 `checksums.txt` 作为备用。构建限制在归档内（BoringSSL/libcurl/OpenSSL 关闭），需两步确认，所有 PR 状态均会明示。支持的后端：`cpu` `vulkan` `cuda` `rocm`（拒绝 SYCL/OpenVINO）。

## 子进程环境

`llama-server`、`llama-bench` 和 CMake 构建在清空的 env + 按平台的显式白名单下运行。代理/TLS 变量为企业构建而传递，敏感信息（`GITHUB_TOKEN`、`*_TOKEN`、`*_PASSWORD`、`SSH_AUTH_SOCK` 等）被排除并经过测试。Git 凭证助手已禁用。

## 支持的版本

最新版本和 `main` 会获得修复。旧版本可能需要升级。
