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

## 코드 서명 정책

[CODE_SIGNING_POLICY.md](../CODE_SIGNING_POLICY.md)를 참조하세요. SignPath Foundation 연동 후에는 GitHub 호스팅 CI에서 릴리스 인스톨러를 제출하고, Authenticode 서명 전에 수동 승인을 받습니다. 연동 전 부트스트랩 릴리스는 명시적으로 미서명일 수 있으므로 설치 전에 `checksums.txt`와 Authenticode 상태를 확인하세요.

## 제거

**설정 → 앱 → 설치된 앱 → llama-board → 제거**를 선택하거나 **제어판 → 프로그램 및 기능**에서 제거하세요. 앱을 제거해도 사용자가 관리하는 모델·런타임·프로젝트·채팅 데이터는 자동으로 삭제되지 않으므로, 필요하면 해당 폴더를 별도로 삭제하세요.

## Linux / macOS (예정)

`curl | tar` 배포를 계획 중입니다. tar 경로는 OS 서명이 필요 없습니다. 자세한 내용은 [README.ko.md](../README.ko.md#플랫폼-지원)를 참조하세요.

