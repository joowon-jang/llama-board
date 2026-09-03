# CLI

> **Language:** [English](CLI.md) | [한국어](CLI.ko.md) | [日本語](CLI.ja.md) | [中文](CLI.zh.md)

During development, `llama-board-cli.exe` is built at `src-tauri/target/release/llama-board-cli.exe`. Packaged builds include it as a Tauri resource; locate the installed copy in the app's resource directory. Output is JSON, the server is loopback-only, and credentials are not persisted.

```powershell
./llama-board-cli.exe --help
./llama-board-cli.exe config get
./llama-board-cli.exe config set <field> <value>  # typed, non-secret only
./llama-board-cli.exe models list
./llama-board-cli.exe models delete <path>
./llama-board-cli.exe runtime list  # `runtimes` is also accepted
./llama-board-cli.exe runtime device
./llama-board-cli.exe runtime probe <backend> <build>
./llama-board-cli.exe server start   # loopback, no API-key auth in headless mode
./llama-board-cli.exe server status
./llama-board-cli.exe server logs [lines]
./llama-board-cli.exe server stop
./llama-board-cli.exe server unload  # alias for stop
./llama-board-cli.exe server restart
./llama-board-cli.exe doctor
```

## First start

Configure a model before starting the headless server. The server executable is resolved from the selected managed runtime or from `PATH`.

```powershell
./llama-board-cli.exe config set models_dir "C:\Models"
./llama-board-cli.exe config set active_model "C:\Models\model.gguf"
./llama-board-cli.exe server start
```

- `config set` rejects credential-like and unknown fields.
- `config get` redacts credential-like values; `server_args`, `chat_options`, and `lora_adapters` require JSON values when set.
- `models delete` is limited to inactive `.gguf`/`.mmproj` files inside `models_dir`.
- `runtime device` detects local GPUs and recommended backends; `runtime probe` runs version/help/device/bench preflight.
- `server start` uses the configured model, binds to `127.0.0.1`, and intentionally disables API-key auth. Use it only on a trusted machine and do not expose or forward the port.
- Headless stdout is JSON; server logs are bounded.

See [SECURITY.md](../SECURITY.md) for auth and process boundaries.
