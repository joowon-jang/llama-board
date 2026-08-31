//! Deterministic counterpart to `tests/smoke.rs`: exercises the same
//! process-spawn / `/health` polling / SSE-streaming path in `server.rs`
//! against a tiny fake `llama-server` fixture (`src/bin/fake-llama-server.rs`)
//! instead of a real multi-GB model. Unlike `smoke.rs` and
//! `runtime_install.rs`, this test always runs in the default `cargo test`
//! gate — it needs no environment variable and no network access, so a
//! regression in the spawn/readiness/streaming plumbing fails CI instead of
//! being masked by the gated tests' early-return "pass".
use std::fs;
use std::sync::{Arc, Mutex};

use llama_board_lib::{server, AppConfig, ErrBuf};

/// Copies the compiled fake-llama-server fixture into a throwaway directory
/// under the exact file name `server::server_bin` looks up on PATH, and
/// prepends that directory to the current process's PATH. `server::spawn`
/// resolves the executable via `which`, so this makes it pick up the fixture
/// without needing a managed runtime install or touching the real PATH.
fn stage_fake_server_on_path() -> tempfile_dir::TempDir {
    let fixture = env!("CARGO_BIN_EXE_fake-llama-server");
    let dir = tempfile_dir::TempDir::new();
    let staged_name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    let staged_path = dir.path().join(staged_name);
    fs::copy(fixture, &staged_path).expect("stage fake llama-server fixture");

    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut entries = vec![dir.path().to_path_buf()];
    entries.extend(std::env::split_paths(&existing));
    let joined = std::env::join_paths(entries).expect("join PATH entries");
    // SAFETY: this test binary is single-threaded at the point this runs (no
    // other test in this file spawns threads that read/write PATH), so there
    // is no data race with the mutation edition 2024's `set_var` guards against.
    unsafe { std::env::set_var("PATH", joined) };
    dir
}

/// Minimal `tempfile`-alike so this test doesn't need a new dependency: a
/// directory under `std::env::temp_dir()` that removes itself on drop.
mod tempfile_dir {
    use std::path::{Path, PathBuf};

    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "llama-board-smoke-fake-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_nanos())
                    .unwrap_or_default()
            ));
            std::fs::create_dir_all(&dir).expect("create temp dir for fake server fixture");
            Self(dir)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn smoke_fake_server_spawn_health_and_chat_stream() {
    // Serializes with any other test in this binary that also mutates the
    // process-wide PATH env var. There is currently only this one test here.
    let _dir = stage_fake_server_on_path();

    let cfg = AppConfig {
        active_model: "fake-model.gguf".to_string(),
        port: 18099,
        ngl: 0,
        ctx_size: 512,
        flash_attn: "off".into(),
        ..AppConfig::default()
    };

    let ring = Arc::new(ErrBuf::default());
    let api_key = "fake-smoke-token";
    let (child, url, api_key_file) = server::spawn(&cfg, api_key, &ring)
        .unwrap_or_else(|e| panic!("spawn failed: {e}\nstderr: {}", ring.tail()));
    let shared = Arc::new(Mutex::new(server::ServerState::default()));
    shared.lock().expect("server state lock").attach_starting(
        child,
        url.clone(),
        api_key.to_string(),
        cfg.active_model.clone(),
        cfg.mmproj.clone(),
    );

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let ready =
        rt.block_on(async { server::wait_ready(shared.clone(), &url, api_key, 20, &ring).await });
    server::cleanup_api_key_file(api_key_file.as_deref());
    if let Err(e) = ready {
        panic!("wait_ready failed against fake server: {e}");
    }

    let base = url.replace("/v1", "");
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "fake-model",
        "messages": [{"role":"user","content":"Reply with exactly: OK"}],
        "stream": true,
    });
    let got = rt.block_on(async {
        let resp = client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
            .expect("chat request failed");
        assert!(resp.status().is_success(), "chat HTTP {}", resp.status());
        resp.text().await.expect("read chat response body")
    });
    assert!(
        got.contains("data:"),
        "expected SSE 'data:' frames, got: {got}"
    );
    assert!(
        got.contains("[DONE]"),
        "expected SSE completion marker, got: {got}"
    );

    server::kill(
        &mut shared.lock().expect("server state lock").child,
        Some(ring.clone()),
    );
}
