# llama-board

Windows desktop runtime manager for `llama.cpp`.

`llama-board` wraps the official `llama-server.exe` and `llama-bench.exe` binaries instead of reimplementing llama.cpp. It provides a native Tauri v2 desktop UI for managing models, runtimes, server settings, streaming chat, and benchmarks.

## Features

- Windows x64 Tauri v2 + React + TypeScript application
- GGUF model discovery under `~/.lmstudio/models` or a selected directory, active-model switching, and safe on-disk GGUF/mmproj deletion
- Managed llama.cpp runtime installation and selection for CPU, Vulkan, ROCm, CUDA, SYCL, and OpenVINO
- Local llama.cpp PR builds for the CPU, Vulkan, CUDA, and ROCm backends: enter an upstream PR number or URL, review the pull request's provenance, and build/install it with the machine's CMake toolchain
- Portable runtime ZIP export/import and PR-specific prebuilt artifacts for PCs that do not have CMake, a compiler, or a vendor SDK
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

The repository is public. For production use, download a release asset from the [GitHub Releases page](https://github.com/joowon-jang/llama-board/releases), verify its SHA-256 value against `checksums.txt`, and prefer a signed installer.

The one-line command below is a convenience path for trusted development machines. It executes a moving `latest` release script and should not be used as the primary enterprise installation method.

### PowerShell — one-line install (convenience)

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

### Verify a downloaded installer

```powershell
$installer = "./llama-board-setup.exe"
(Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
# Compare the result with the matching line in checksums.txt from the same release.
```

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

- A matching prebuilt PR artifact or a portable runtime ZIP is enough for end-user installation; the CMake/compiler/SDK requirements below apply only to local source builds
- Windows 10/11 x64
- Node.js `22.23.2` and npm `12.0.2` (pinned in `.node-version` and `package.json#engines`/`packageManager`; CI reads the same file via `node-version-file`)
- Rust `1.98.0` with the `rustfmt` and `clippy` components (pinned in `rust-toolchain.toml`; `rustup` picks this up automatically in this repo, and CI passes the same version to `dtolnay/rust-toolchain`)
- Tauri v2 prerequisites
- A local `llama-server.exe` or an installed managed runtime for live smoke tests
- For PR builds: CMake, a compatible C/C++ toolchain, and the SDK for the selected backend (the CUDA Toolkit for `cuda`, the Vulkan SDK for `vulkan`, or the ROCm/HIP SDK with `hipcc` for `rocm`; `cpu` needs neither)

To bump the pinned toolchain: update `.node-version` together with `package.json#engines.node`/`packageManager`, or update `rust-toolchain.toml#toolchain.channel` together with `src-tauri/Cargo.toml#rust-version`. CI's Node setup reads `.node-version` automatically; the `dtolnay/rust-toolchain` `toolchain:` input in `.github/workflows/{ci,release}.yml` is set explicitly and must be bumped in lockstep with `rust-toolchain.toml` so they never diverge.

Install dependencies and run the development app:

```bash
npm install
npm run tauri -- dev
```

Run validation and build checks:

```bash
npm test
npm run typecheck
npm run build
cargo build --locked --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

`npm test` (alias for `npm run test:unit`) is the canonical test gate: it runs the
harness's own failure-propagation self-check, then the 24 direct Node
assertion scripts under `scripts/test-*.ts` in order (`npm run test:direct`,
via `scripts/run-direct-tests.ts`), then `npm run test:coverage`
(`vitest run --coverage` over `src/**/*.test.{ts,tsx}` with v8 coverage
thresholds — see `vitest.config.ts`). Coverage only measures the Vitest
suite; the direct Node scripts are not instrumented. Run a single Vitest
file or pattern without the coverage gate via `npm run test:ui -- <path>`.

Frontend lint is also part of the normal validation gate:

```bash
npm run lint
```

The real-model smoke test is gated so it does not run accidentally:

```bash
cd src-tauri
LLAMA_BOARD_SMOKE=1 \
LLAMA_BOARD_SMOKE_MODEL='C:/path/to/model.gguf' \
cargo test --test smoke -- --nocapture
```

## Packaging

Build the Windows release bundles (this builds the CLI resource before packaging):

```bash
npm run package:tauri
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

The same tab can build an upstream llama.cpp pull request locally. Enter either a PR number (for example `27342`) or an official PR URL, choose the backend, and click **Review PR…**.

Because a PR build compiles and runs someone else's code on your machine, this is a two-step flow. **Review PR…** resolves the pull request and checks whether a matching prebuilt artifact exists. When it does, the artifact path needs no local CMake/compiler/SDK; otherwise the local CMake/compiler/SDK prerequisites are checked before any source download. llama-board then shows a confirmation dialog with the PR's title, the account that opened it, the head repository (often a contributor's fork rather than `ggml-org/llama.cpp`), the head branch, the head commit, and the PR state. Nothing is downloaded, extracted, configured, or compiled until you confirm it. What you confirm is the **head commit**, not the PR number: before the install starts the backend re-resolves the pull request and refuses to continue if the head has moved since the dialog, so a force-push cannot ride in on an earlier confirmation.

The dialog also states what the build will produce, so "build this PR" is not an open-ended promise: the `llama-server` and `llama-bench` targets only, in Release, with tests and examples off. The server's optional embedded web UI is explicitly disabled for a PR build — llama-board uses the loopback API and never opens that UI — so no Node toolchain is required and no asset is fetched at build time.

After confirmation llama-board downloads the commit-pinned source archive, checks that the tree GitHub returned actually carries the requested commit, runs CMake with the selected `GGML_*` backend option, builds those two targets, runs the normal preflight, and activates the result atomically. The configure keeps the build inside the downloaded archive: BoringSSL, libcurl, and OpenSSL support are off, since those are what make llama.cpp's CMake fetch further dependencies over Git or HTTPS, and llama-board needs none of them. Build failures report the end of the log with an explanation of what to fix — a missing compiler, a missing SDK, a full disk, or a dependency fetch that could not reach the network. Configure and build each have their own timeout — 30 minutes for configure, 3 hours for build (a stuck network probe or a hung compiler is killed rather than left running indefinitely); the error names the phase and how long it ran.

Four things are checked before anything is downloaded. The located CMake is run once and refused if it is older than 3.18 (the floor for the command lines and CUDA architecture selection llama-board uses) or cannot run at all; on Windows a standalone CMake install is preferred over the copy Visual Studio bundles, and Visual Studio installs are tried newest release first in a fixed order rather than in whatever order the filesystem lists them. A C/C++ compiler is discovered as well, including Visual Studio's `cl.exe` install tree on Windows, so a missing host compiler gets an actionable error before a large source download. Free disk space is checked against a rough requirement for the selected backend, so a build that cannot finish fails in a second instead of after an hour. And the backend SDK check described above still applies; Windows ROCm additionally requires Ninja because its HIP source must use the ROCm clang generator path, and the bundled Visual Studio Ninja is found automatically when available.

For CUDA, llama-board asks the driver which GPUs are present and compiles kernels only for those architectures, plus PTX for the newest one so a card installed later still works. This avoids compiling every architecture llama.cpp names by default, which is the single largest cost in a CUDA build. The build uses all available cores by default; on a PC with many cores and comparatively little RAM, set `CMAKE_BUILD_PARALLEL_LEVEL` to a positive number to cap it. Set `LLAMA_BOARD_CUDA_ARCHITECTURES` to take over the architecture list — it accepts whatever `CMAKE_CUDA_ARCHITECTURES` accepts (`89-real`, `75-real;80-real;90-virtual`, `all`) — and anything that is not an architecture list is ignored rather than passed to CMake. When no GPU can be detected, a portable multi-generation list with trailing PTX is used instead. CPU portability is unaffected either way: `GGML_NATIVE` stays off and `GGML_CPU_ALL_VARIANTS` stays on for every backend.

PR builds support the `cpu`, `vulkan`, `cuda`, and `rocm` backends. SYCL and OpenVINO each need a vendor compiler driver plus a sourced environment script and are refused up front with actionable guidance. CUDA and ROCm redistributable runtime libraries, ROCm rocBLAS/hipBLASLt kernel data, and the Windows MSVC runtime are copied beside the staged PR binaries when the selected SDK supplies them; GPU driver libraries remain host supplied. A source build still requires CMake, a compatible C/C++ toolchain, and the backend SDK: the build is refused before any download when `cl.exe`/`gcc`/`clang`, `nvcc` (or `CUDACXX`) for CUDA, `glslc` in a complete Vulkan SDK, or `hipcc` plus `clang++` and a discoverable ROCm/HIP SDK (via `HIP_PATH`/`ROCM_PATH` or hipcc's install tree) for ROCm cannot be found. On Windows, CMake, Ninja for ROCm, and Visual Studio compiler installs are also detected in standard locations even when they are not on `PATH`; custom locations still need to be added to `PATH`. If `CMAKE_BUILD_PARALLEL_LEVEL` is set, llama-board passes a validated numeric value to CMake (or leaves the flag out for an invalid value); when it is unset, the build uses all available cores.

PR builds are stored as `pr{number}-{backend}` — one directory per pull request, so rebuilding the same PR replaces the previous build rather than filling the disk with a copy per commit. Because that means the bytes behind a runtime can change while its name does not, the confirmation dialog says so up front, the installed-runtime row shows the short commit, and a rebuild that displaces a different commit reports which one it replaced. Each build keeps a source manifest recording the pull request, head repository, branch, author, state, and commit as they were at build time. The manifest also stores a SHA-256 of the downloaded archive: GitHub publishes no digest for a source archive, so that hash is a local record of the bytes that were built, not an independent authenticity proof. The commit-pinned HTTPS request plus the extracted-tree commit check are the provenance checks; a tree with no recognisable commit directory fails closed with `archive-layout-unrecognised` and activates nothing. See [SECURITY.md](SECURITY.md) for the full boundary.

### Use a PR runtime on a PC without CMake

The **Portable runtime bundles** section in Runtimes provides two paths. On a build PC, use **Export runtime** beside an installed runtime and copy the ZIP and its checksum sidecar to the other PC. On Windows, export also collects the MSVC runtime from the installed bundle, Visual Studio redistributable, or the system redistributable when available; if none exists, use a repository-produced artifact or install the VC++ redistributable on the build PC first. On the other PC, stop the server and use **Import runtime ZIP**. Import verifies the bundle format, OS, architecture, every file digest, PR provenance, required executables, and a clean preflight before it atomically activates the runtime. The receiving PC does not need CMake, a C/C++ compiler, Git, or the SDK that produced the bundle.

For CPU PR builds, maintainers can run the manual **Publish Windows PR runtime** workflow with a PR number. It publishes a platform-specific, SHA-256-protected artifact under the pr-runtime-{number} release tag; the app discovers it from the PR review screen and downloads it instead of compiling locally. GPU artifacts still require a runner with the relevant SDK and are not promised by the CPU-only workflow. A copied GPU runtime also needs a compatible GPU driver on the receiving PC; vendor driver libraries are intentionally not redistributed.

For the Qwen3.8 DFlash2 profile, use the `rocm` backend with `pr27342`, set both the main and draft GGUF paths, and apply the profile only after that runtime is installed or imported. A ROCm build made on a toolchain-equipped PC can be exported and moved to a second PC; the second PC does not need ROCm, CMake, a compiler, or Git, but it still needs a compatible AMD driver.

### Full llama.cpp settings

The **Tuning** tab separates settings by when they take effect:

- **Server-side parameters** are passed to `llama-server.exe` at startup and require **Apply & restart**.
- **Sampling parameters** are included in each chat request and apply to the next message.
- **Speculative decoding / MTP** exposes `--spec-type draft-mtp` plus draft token, probability, GPU-layer, device, and draft-model controls.
- **Reasoning / thinking** exposes `--reasoning`, `--reasoning-format`, `--reasoning-effort`, reasoning budgets, and trace preservation. The selected effort is also sent as the OpenAI-compatible `reasoning_effort` request field and merged into `chat_template_kwargs`; `none` disables thinking per request because it is not a valid CLI effort level.
- **Multimodal projector** stores and passes `--mmproj`. Enable **show vision sidecars (mmproj)** in Models and choose **Use as projector** for a detected `mmproj-*.gguf` file.
- **Qwen3.8-27B defaults** use thinking-mode sampling (`temperature=1.0`, `top_p=0.95`, `top_k=20`, `min_p=0`, `presence_penalty=0`, `repeat_penalty=1`), `reasoning_effort=xhigh`, preserved thinking, Flash Attention, a 131072-token context, MTP draft mode, and Qwen long-context server flags (`batch/ubatch`, `parallel=1`, quantized KV cache, prompt cache, Jinja, and context checkpoints). Use **Load Qwen3.8 profile** to apply this profile explicitly.
- **Qwen3.8-27B DFlash2** uses the target GGUF from `ggml-org/Qwen3.8-27B-GGUF` and the draft GGUF from `z-lab/Qwen3.8-27B-DFlash2-GGUF`. Build and activate llama.cpp PR `27342`, select the target model, set the draft model path in Tuning, then use **Load Qwen3.8 DFlash2 profile** and **Apply & restart**. The DFlash2 draft is not a standalone model.
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
- PR source builds are a different boundary: GitHub publishes no digest for a source archive, so the archive is pinned to the confirmed head commit, the extracted tree is checked to carry that commit, and the recorded SHA-256 is a local record of what was built — not independent verification. Building a PR runs its author's code on your machine; the provenance is shown and confirmed first. See [SECURITY.md](SECURITY.md).
- Hugging Face model downloads validate repository/file paths, restrict redirects to Hugging Face domains, use `.part` staging, and never execute downloaded content.
- Native image/document reads are bound to the exact path returned by the picker and enforce file type and size limits.
- MCP is intentionally a privileged integration: only configure servers you trust, because their child process inherits the app user's normal OS permissions.
- The app uses a restrictive Tauri CSP and only connects to the local loopback server plus the GitHub release APIs.
- The convenience bootstrap command below executes the `main` branch script. For a reproducible install, prefer a release-pinned asset after a release workflow has published it:

  ```powershell
  powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/llama-board/releases/latest/download/install.ps1 | iex"
  ```

- App updates are currently manual: download a new signed release installer when signing is configured, or verify its published SHA-256 digest before installing. The app installer and llama.cpp runtime updates are independent.
- CI/release workflows separate untrusted build from trusted publish. `pr-runtime.yml` runs untrusted llama.cpp PR source in a read-only `build` job, packages it with trusted tooling in a read-only `package` job, then exercises the packaged PR-derived executables in an isolated, permission-less `smoke` job that only downloads the already-uploaded final artifact and cannot affect it, and only the `publish` job (`environment: pr-runtime-publish`) holds `contents: write` and creates the GitHub release. `release.yml` builds and tests the app's own source in a read-only `build` job with no signing secrets, and only the `publish` job (`environment: release-publish`) holds the code-signing certificate secrets and `contents: write`. Configure required reviewers on both the `pr-runtime-publish` and `release-publish` environments in repository settings to gate publishing.
- `release-publish` fails closed: the `publish` job throws before touching any installer if `WINDOWS_CERTIFICATE_BASE64` (a base64-encoded PFX) or `WINDOWS_CERTIFICATE_PASSWORD` is not configured, so a release can never ship unsigned by accident. To enable signing, add both as **environment secrets** on `release-publish` (repository Settings → Environments → `release-publish` → Environment secrets) — never as repository-level secrets, since only the `publish` job's environment should be able to read them.

In managed environments, use a reviewed script file instead of piping a moving branch directly into `iex`.

## License

This project is distributed under the MIT License; see [`LICENSE`](LICENSE). llama.cpp and its runtime binaries remain subject to their respective upstream licenses; see [`NOTICE`](NOTICE).
