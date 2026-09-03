# CLI

> **言語:** [English](CLI.md) | [한국어](CLI.ko.md) | [日本語](CLI.ja.md) | [中文](CLI.zh.md)

開発中の `llama-board-cli.exe` は `src-tauri/target/release/llama-board-cli.exe` に生成されます。パッケージ版では Tauri リソースとして含まれるため、インストール後はアプリのリソースディレクトリにあります。出力は JSON、サーバーは loopback 専用で、認証情報は保存されません。

```powershell
./llama-board-cli.exe --help
./llama-board-cli.exe config get
./llama-board-cli.exe config set <field> <value>
./llama-board-cli.exe models list
./llama-board-cli.exe models delete <path>
./llama-board-cli.exe runtime list   # `runtimes` も別名として使用可能
./llama-board-cli.exe runtime device
./llama-board-cli.exe runtime probe <backend> <build>
./llama-board-cli.exe server start   # loopback、headless モードでは API-key 認証なし
./llama-board-cli.exe server status
./llama-board-cli.exe server logs [lines]
./llama-board-cli.exe server stop
./llama-board-cli.exe server unload  # stop の別名
./llama-board-cli.exe server restart
./llama-board-cli.exe doctor
```

## 初回起動

ヘッドレスサーバーを起動する前にモデルを設定してください。サーバー実行ファイルは、選択した管理ランタイムまたは `PATH` から解決されます。

```powershell
./llama-board-cli.exe config set models_dir "C:\Models"
./llama-board-cli.exe config set active_model "C:\Models\model.gguf"
./llama-board-cli.exe server start
```

- `config set` は認証情報に見えるフィールドと未知のフィールドを拒否します。
- `config get` は認証情報に見える値を伏せ字にします。`server_args`、`chat_options`、`lora_adapters` の設定値には JSON が必要です。
- `models delete` は `models_dir` 内の非アクティブな `.gguf`/`.mmproj` ファイルだけを削除できます。
- `runtime device` はローカル GPU と推奨バックエンドを検出し、`runtime probe` は version/help/device/bench の事前チェックを実行します。
- `server start` は設定済みモデルを使用し、`127.0.0.1` にバインドして API-key 認証を意図的に無効化します。信頼できる PC だけで使用し、ポートを外部公開・転送しないでください。
- 標準出力は JSON で、サーバーログのサイズには上限があります。

[SECURITY.ja.md](../SECURITY.ja.md) で認証とプロセス境界を確認してください。
