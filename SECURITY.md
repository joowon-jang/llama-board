# Security Policy

> **Language:** [English](SECURITY.md) | [한국어](SECURITY.ko.md) | [日本語](SECURITY.ja.md) | [中文](SECURITY.zh.md)

## Reporting

Do not open a public issue. Use [GitHub Security Advisories](https://github.com/joowon-jang/llama-board/security/advisories/new) or contact the maintainer privately. Include a minimal reproduction and no secrets (replace them with `[REDACTED]`).

## Scope

Runtime archive verification, path traversal, PR source-build provenance, process lifecycle, local endpoint exposure, installer integrity, Tauri capabilities.

## Local authentication

The desktop-managed server binds to `127.0.0.1` with a per-start bearer token delivered through a temporary `--api-key-file`. The temporary file is removed after startup and the token is cleared on stop. A process running as the same Windows user may still inspect or interact with the server — this is expected. Do not share the endpoint or key.

The headless CLI's `server start` mode is different: it intentionally passes `--no-api-key` and relies on the `127.0.0.1` bind. Any local process that can reach that port can call it, so use this mode only on a trusted machine and do not expose or forward the port.

Developer gateways are local-only as well. MCP servers are third-party executables launched with the user's permissions; add only trusted executables and review tool calls under the configured approval policy.

## Prebuilt PR artifacts

Portable ZIP and workflow-published CPU artifacts are verified for platform/arch/backend/build-id, GitHub asset SHA-256, file-level manifest SHA-256, embedded PR repo/commit, required executables, and clean preflight. Receiving PC needs no CMake/compiler/SDK but needs compatible GPU driver for GPU runtimes. Workflow publishes CPU by default; GPU must be exported from SDK-equipped machine.

## Building a PR from source

Compiles third-party code as your user. Llama-board shows provenance before download (title/author/repo/branch/commit/state) and pins the build to that commit — if head moves before build, it refuses. The PR source archive is fetched via commit-pinned HTTPS and checked for the expected commit directory. GitHub does not publish a trusted digest for that source archive, so the stored SHA-256 is a local audit record; release installer assets use the GitHub asset digest when available or `checksums.txt` as a fallback. Build is confined to the archive (BoringSSL/libcurl/OpenSSL off), two-step confirmation required, every PR state is named. Supported backends: `cpu` `vulkan` `cuda` `rocm` (SYCL/OpenVINO refused).

## Child environment

`llama-server`, `llama-bench`, and CMake builds run with cleared env + explicit allowlist per platform. Proxy/TLS vars are passed for corporate builds; secrets (`GITHUB_TOKEN`, `*_TOKEN`, `*_PASSWORD`, `SSH_AUTH_SOCK`, etc.) are excluded and tested. Git credential helpers are disabled.

## Supported versions

Latest release and `main` receive fixes. Older releases may require upgrade.

## Privacy

See [PRIVACY.md](PRIVACY.md) for network requests, local data, credentials, and third-party service handling.

