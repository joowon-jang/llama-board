# llama-board

Windows desktop runtime manager for `llama.cpp`.

`llama-board` wraps the official `llama-server.exe` and `llama-bench.exe` binaries instead of reimplementing llama.cpp. It provides a native Tauri v2 desktop UI for managing models, runtimes, server settings, streaming chat, and benchmarks.

## Features

- Windows x64 Tauri v2 + React + TypeScript application
- GGUF model discovery under `~/.lmstudio/models` or a selected directory, active-model switching, and safe on-disk GGUF/mmproj deletion
- Managed llama.cpp runtime installation and selection for CPU, Vulkan, ROCm, CUDA, SYCL, and OpenVINO
- WinGet-compatible `llama-server.exe` execution with health polling, restart, and cleanup
- OpenAI-compatible streaming chat with local Bearer authentication
- Chat-first workspace with persistent local conversation threads, full-text search, per-thread system instructions, DOCX/PDF/text document context, local embedding retrieval with lexical fallback, and local attachment safety limits
- Persistent **Projects & Presets** workspace with reusable system prompts, model/backend/runtime settings, sampling, document bindings, MCP tool bindings, JSON import/export, and active-project application
- Hugging Face **Discover** search for llama.cpp-compatible repositories, exact GGUF/mmproj tree inspection, quant/size metadata, checksum-aware staged downloads, and model activation
- **Developer** dashboard for the local OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, and `/v1/embeddings`) with redacted auth snippets and live model read-back
- Explicit-consent **MCP** stdio server configuration, tool discovery, JSON-schema validation, in-app plus backend-native Chat tool-call approval, one-call tool execution, loop/result limits, no shell execution, and no inherited secret environment
- Local Anthropic Messages gateway at `127.0.0.1:8081/v1/messages`, with request/response and streaming translation for text, reasoning, vision, and tool use
- Local stateful OpenAI Responses gateway at `127.0.0.1:8081/v1/responses`, including `previous_response_id`, bounded continuation history, streaming events, GET, DELETE, and explicit cancel routes
- Runtime capability preflight from the selected executable (`--version`, `--help`, `--list-devices`) plus named local loading profiles
- Separate collapsible reasoning (`reasoning_content`) and answer content for reasoning models
- Server-side tuning: GPU layers, context size, CPU MoE, threads, flash attention, speculative decoding/MTP, and reasoning behavior
- Server lifecycle controls: model unload, request timeout, parallel slots, llama.cpp idle sleep/auto-evict, filesystem-based memory estimates, LoRA attachment/scaling, and multimodal projector selection
- Sampling tuning: temperature, top-p, top-k, min-p, typical-p, XTC, dynamic temperature, repetition/DRY penalties, Mirostat, seed, token limits, and probability controls
- Full llama.cpp escape hatches: one literal argument per line for any `llama-server` CLI option plus a JSON object for any `/v1/chat/completions` option, including newer or runtime-specific settings
- `llama-bench` execution with CSV/TSV parsing and result tables
- Responsive layout for narrow and wide desktop windows
- NSIS and MSI Windows installers
- Machine-readable `llama-board-cli.exe` for config, model scan, runtime list, server start/status/stop, and diagnostics; headless start is explicit loopback/no-auth mode and never persists credentials

## Download

The repository is public. The one-line installer downloads the latest Windows NSIS release, verifies its SHA-256 digest, and installs it silently.

### PowerShell — one-line install (recommended)

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

The same command works from `cmd.exe`, Git Bash, or another terminal that can start PowerShell:

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

The installer defaults to the NSIS package. To install the MSI package instead, set the environment variable first:

```powershell
$env:LLAMA_BOARD_INSTALLER = "msi"
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
```

Useful installer options:

```powershell
# Install a specific release tag
$env:LLAMA_BOARD_RELEASE = "v0.1.0-llama-board"

# Download and verify without running the installer
$env:LLAMA_BOARD_DRY_RUN = "1"
```

Installer source: <https://github.com/joowon-jang/llama-board/blob/main/install.ps1>

Release page: <https://github.com/joowon-jang/llama-board/releases/latest>

### Clone the source

```bash
git clone https://github.com/joowon-jang/llama-board.git
cd llama-board
```

Managed runtimes are stored separately from WinGet binaries. Runtime archives are staged, required binaries are checked, and the GitHub-published SHA-256 digest is verified before activation:

```text
%APPDATA%/llama-board/runtimes/{build}-{backend}/
```

## Development

Requirements:

- Windows 10/11 x64
- Node.js and npm
- Rust toolchain
- Tauri v2 prerequisites
- A local `llama-server.exe` or an installed managed runtime for live smoke tests

Install dependencies and run the development app:

```bash
npm install
npm run tauri dev
```

Run validation and build checks:

```bash
npm run test:tuning
npx tsc --noEmit -p tsconfig.json
npm run build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

The real-model smoke test is gated so it does not run accidentally:

```bash
cd src-tauri
LLAMA_BOARD_SMOKE=1 \
LLAMA_BOARD_SMOKE_MODEL='C:/path/to/model.gguf' \
cargo test --test smoke -- --nocapture
```

## Packaging

Build the Windows release bundles:

```bash
npm run tauri build
```

Installers are written to:

```text
src-tauri/target/release/bundle/nsis/
src-tauri/target/release/bundle/msi/
```

## Runtime behavior

The app launches and supervises `llama-server.exe`, binds it to loopback, polls both `/health` and `/v1/models`, streams `/v1/chat/completions`, and terminates/reaps the child process when the app exits. It does not bundle model files or runtime binaries in the repository.

Each server start receives a fresh process-local bearer token. The token is returned only to the current WebView through the server status command and is never printed in logs or installer output.

### Chat, Discover, documents, and tools

- Chat threads are stored locally with IndexedDB as the primary workspace store and a quota-safe localStorage fallback. Thread titles, system instructions, user/assistant messages, image attachments, and document attachment metadata survive an app restart; no cloud sync is performed.
- Document attachments use the native file picker and support bounded UTF-8 text/code, DOCX XML, and PDF text-layer extraction. Long documents are chunk-ranked against the current prompt before insertion; scanned PDFs without a text layer fail visibly instead of producing fabricated context. Chunk embeddings are cached in a local IndexedDB store (with a bounded localStorage fallback) by model/document fingerprint, and the chat surface displays the selected source chunks.
- Discover uses the Hugging Face API for repository search and the repository tree API for exact GGUF entries. Files are staged below `<models_dir>/hf/<org>/<repo>/`, verified when the Hub publishes a SHA-256 `oid`, collision-checked, then atomically moved into place.
- MCP servers are spawned as direct child processes with an argv vector and a minimal allow-listed environment. The app never runs a shell string, stores environment values, or auto-approves tools; every Chat tool call requires the in-app approval flow and a backend-native confirmation bound to the current server/tool/arguments.

### Runtime capabilities and profiles

The Runtimes tab distinguishes installed, preflight-failed, and available builds using the selected executable's own output. A runtime is only `available` after `--version`, `--help`, `--list-devices`, and `llama-bench --help` succeed; the UI shows the bench result explicitly. Unknown/new llama.cpp flags remain visible through the existing Advanced Arguments escape hatch. Loading profiles are local UI presets for model, backend/build, projector, context, GPU layers, threads, and Flash Attention; applying one while the server is running is blocked.

### Full llama.cpp settings

The **Tuning** tab separates settings by when they take effect:

- **Server-side parameters** are passed to `llama-server.exe` at startup and require **Apply & restart**.
- **Sampling parameters** are included in each chat request and apply to the next message.
- **Speculative decoding / MTP** exposes `--spec-type draft-mtp` plus draft token, probability, GPU-layer, device, and draft-model controls.
- **Reasoning / thinking** exposes `--reasoning`, `--reasoning-format`, `--reasoning-effort`, reasoning budgets, and trace preservation. The selected effort is also sent as the OpenAI-compatible `reasoning_effort` request field and merged into `chat_template_kwargs`; `none` disables thinking per request because it is not a valid CLI effort level.
- **Multimodal projector** stores and passes `--mmproj`. Enable **show vision sidecars (mmproj)** in Models and choose **Use as projector** for a detected `mmproj-*.gguf` file.
- **Qwen3.8-27B defaults** use thinking-mode sampling (`temperature=1.0`, `top_p=0.95`, `top_k=20`, `min_p=0`, `presence_penalty=0`, `repeat_penalty=1`), `reasoning_effort=xhigh`, preserved thinking, Flash Attention, a 131072-token context, MTP draft mode, and Qwen long-context server flags (`batch/ubatch`, `parallel=1`, quantized KV cache, prompt cache, Jinja, and context checkpoints). Use **Load Qwen3.8 profile** to apply this profile explicitly.
- **Additional llama-server arguments** accepts one literal process argument per line. Put a flag and its value on separate lines; no shell parsing is performed. This keeps unknown and future llama.cpp flags available without an app update.
- **Advanced chat options (JSON)** is merged into the OpenAI-compatible request. It supports arrays and options that are not represented by a dedicated control, such as `samplers`, `dry_sequence_breakers`, grammar, JSON schema, and cache controls.

The app-managed model, loopback host, port, and API key cannot be overridden by advanced arguments. Arguments are passed to the child process as an argument vector rather than through a shell.

When `sleep_idle_seconds` is positive, the desktop process records active chat requests and runs a request-aware watchdog. After the configured idle period, with no active request, it stops the managed server and gateway cleanly. Server status exposes `active_requests`, `idle_seconds`, and `auto_unload_due`; this is separate from llama.cpp's own KV/cache sleep behavior.

### Headless CLI

The release bundle includes `llama-board-cli.exe` next to the desktop executable. It emits JSON and uses the same persisted model/runtime profile and canonical llama-server argument builder:

```powershell
./llama-board-cli.exe config get
./llama-board-cli.exe config set <field> <value>
./llama-board-cli.exe models list
./llama-board-cli.exe models delete <path>
./llama-board-cli.exe runtimes list
./llama-board-cli.exe runtime probe <backend> <build>
./llama-board-cli.exe server start
./llama-board-cli.exe server restart
./llama-board-cli.exe server status
./llama-board-cli.exe server logs [lines]
./llama-board-cli.exe server stop
./llama-board-cli.exe doctor
```

`server start` is intentionally an explicit **local no-auth** mode: it binds to `127.0.0.1`, does not persist or print a credential, and should only be used on a trusted machine. The desktop app remains the authenticated mode.
`config set` accepts only typed non-secret fields; credential-like and unknown fields are rejected. Model deletion is restricted to non-active `.gguf`/projector files inside `models_dir`. Headless stdout is JSON and server stderr/stdout are bounded in the local headless log file.

## Security and updates

- Runtime downloads require HTTPS GitHub hosts and a release asset SHA-256 digest; unverified archives are refused.
- Hugging Face model downloads validate repository/file paths, restrict redirects to Hugging Face domains, use `.part` staging, and never execute downloaded content.
- Native image/document reads are bound to the exact path returned by the picker and enforce file type and size limits.
- MCP is intentionally a privileged integration: only configure servers you trust, because their child process inherits the app user's normal OS permissions.
- The app uses a restrictive Tauri CSP and only connects to the local loopback server plus the GitHub release APIs.
- The convenience bootstrap command below executes the `main` branch script. For a reproducible install, prefer a release-pinned asset after a release workflow has published it:

  ```powershell
  powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
  ```

- App updates are currently manual: download a new signed release installer when signing is configured, or verify its published SHA-256 digest before installing. The app installer and llama.cpp runtime updates are independent.

In managed environments, use a reviewed script file instead of piping a moving branch directly into `iex`.

## License

This project is distributed under the MIT License; see [`LICENSE`](LICENSE). llama.cpp and its runtime binaries remain subject to their respective upstream licenses; see [`NOTICE`](NOTICE).
