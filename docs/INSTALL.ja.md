# インストール

> **言語:** [English](INSTALL.md) | [한국어](INSTALL.ko.md) | [日本語](INSTALL.ja.md) | [中文](INSTALL.zh.md)

## ワンライナーインストール (Windows)

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

`cmd.exe`、Git Bash など PowerShell を起動できるすべてのシェルで同様です。

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

## オプション

```powershell
$env:LLAMA_BOARD_INSTALLER = "msi"   # 既定: nsis
$env:LLAMA_BOARD_RELEASE = "v0.1.5"  # 特定タグ
$env:LLAMA_BOARD_DRY_RUN = "1"       # 検証のみ
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

ワンライナーは選択したリリースに含まれる `install.ps1` のコピーをダウンロードします。現在のソース: <https://github.com/joowon-jang/llama-board/blob/main/install.ps1>

## ダウンロード検証

```powershell
$installer = Get-ChildItem -File "./llama-board_*_x64-setup.exe" | Select-Object -First 1
# MSI の場合は "./llama-board_*_x64_en-US.msi" を使用します。
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
# 同じリリースの checksums.txt と比較
(Get-AuthenticodeSignature -LiteralPath $installer.FullName).Status
# 署名済みリリースは Valid、未署名ファイルは NotSigned です。
```

リリースページ: <https://github.com/joowon-jang/llama-board/releases/latest>

## Linux / macOS (予定)

`curl | tar` 配布を予定しています。tar パスは OS 署名不要です。詳しくは [README.ja.md](../README.ja.md#プラットフォーム対応) を参照してください。
