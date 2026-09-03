# CLI

> **语言:** [English](CLI.md) | [한국어](CLI.ko.md) | [日本語](CLI.ja.md) | [中文](CLI.zh.md)

开发时，`llama-board-cli.exe` 会生成在 `src-tauri/target/release/llama-board-cli.exe`。打包版本会将它作为 Tauri 资源包含；安装后请在应用的资源目录中查找。输出为 JSON，服务器仅使用 loopback，且不会持久化凭证。

```powershell
./llama-board-cli.exe --help
./llama-board-cli.exe config get
./llama-board-cli.exe config set <field> <value>
./llama-board-cli.exe models list
./llama-board-cli.exe models delete <path>
./llama-board-cli.exe runtime list   # `runtimes` 也可作为别名
./llama-board-cli.exe runtime device
./llama-board-cli.exe runtime probe <backend> <build>
./llama-board-cli.exe server start   # loopback；headless 模式不启用 API-key 认证
./llama-board-cli.exe server status
./llama-board-cli.exe server logs [lines]
./llama-board-cli.exe server stop
./llama-board-cli.exe server unload  # stop 的别名
./llama-board-cli.exe server restart
./llama-board-cli.exe doctor
```

## 首次启动

启动无头服务器前，请先配置模型。服务器可执行文件会从选定的托管运行时或 `PATH` 中解析。

```powershell
./llama-board-cli.exe config set models_dir "C:\Models"
./llama-board-cli.exe config set active_model "C:\Models\model.gguf"
./llama-board-cli.exe server start
```

- `config set` 会拒绝类似凭证的字段和未知字段。
- `config get` 会隐藏类似凭证的值；设置 `server_args`、`chat_options`、`lora_adapters` 时需要 JSON 值。
- `models delete` 仅允许删除 `models_dir` 内未激活的 `.gguf`/`.mmproj` 文件。
- `runtime device` 会检测本地 GPU 和推荐后端；`runtime probe` 会运行 version/help/device/bench 预检。
- `server start` 使用已配置的模型并绑定到 `127.0.0.1`，且会有意禁用 API-key 认证。仅在可信计算机上使用，不要将端口暴露或转发到外部。
- 标准输出为 JSON，服务器日志大小有限制。

请参阅 [SECURITY.zh.md](../SECURITY.zh.md) 了解认证和进程边界。
