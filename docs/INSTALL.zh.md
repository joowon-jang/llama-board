# 安装

> **语言:** [English](INSTALL.md) | [한국어](INSTALL.ko.md) | [日本語](INSTALL.ja.md) | [中文](INSTALL.zh.md)

## 一行安装 (Windows)

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

在 `cmd.exe`、Git Bash 或任何可启动 PowerShell 的终端中均可使用。

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

## 选项

```powershell
$env:LLAMA_BOARD_INSTALLER = "msi"   # 默认: nsis
$env:LLAMA_BOARD_RELEASE = "v0.1.5"  # 指定标签
$env:LLAMA_BOARD_DRY_RUN = "1"       # 仅验证
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

单行命令会下载所选发布版本中包含的 `install.ps1` 副本。当前源码: <https://github.com/joowon-jang/llama-board/blob/main/install.ps1>

## 验证下载

```powershell
$installer = Get-ChildItem -File "./llama-board_*_x64-setup.exe" | Select-Object -First 1
# 对 MSI 使用 "./llama-board_*_x64_en-US.msi"。
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
# 与同一版本的 checksums.txt 对比
(Get-AuthenticodeSignature -LiteralPath $installer.FullName).Status
# 已签名版本应为 Valid；未签名文件会显示 NotSigned。
```

发布页面: <https://github.com/joowon-jang/llama-board/releases/latest>

## Linux / macOS (计划中)

计划提供 `curl | tar` 分发。tar 路径无需 OS 签名。详见 [README.zh.md](../README.zh.md#平台支持)。
