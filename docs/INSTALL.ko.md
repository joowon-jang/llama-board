# 설치

> **언어:** [English](INSTALL.md) | [한국어](INSTALL.ko.md) | [日本語](INSTALL.ja.md) | [中文](INSTALL.zh.md)

## 원라이너 설치 (Windows)

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

`cmd.exe`, Git Bash 등 PowerShell을 실행할 수 있는 모든 셸에서 동일합니다.

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

## 옵션

```powershell
$env:LLAMA_BOARD_INSTALLER = "msi"   # 기본: nsis
$env:LLAMA_BOARD_RELEASE = "v0.1.5"  # 특정 태그
$env:LLAMA_BOARD_DRY_RUN = "1"       # 검증만, 설치 안 함
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

원라이너는 선택한 릴리스에 포함된 `install.ps1` 사본을 다운로드합니다. 현재 원본: <https://github.com/joowon-jang/llama-board/blob/main/install.ps1>

## 다운로드 검증

```powershell
$installer = Get-ChildItem -File "./llama-board_*_x64-setup.exe" | Select-Object -First 1
# MSI는 "./llama-board_*_x64_en-US.msi"를 사용하세요.
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
# 같은 릴리스의 checksums.txt와 비교
(Get-AuthenticodeSignature -LiteralPath $installer.FullName).Status
# 서명된 릴리스는 Valid, 미서명 파일은 NotSigned가 나옵니다.
```

릴리스 페이지: <https://github.com/joowon-jang/llama-board/releases/latest>

## Linux / macOS (예정)

`curl | tar` 배포를 계획 중입니다. tar 경로는 OS 서명이 필요 없습니다. 자세한 내용은 [README.ko.md](../README.ko.md#플랫폼-지원)를 참조하세요.
