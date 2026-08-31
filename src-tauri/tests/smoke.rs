//! End-to-end smoke test: spawn the real llama-server, wait for /health, run a
//! streaming chat completion, then kill. Gated behind LLAMA_BOARD_SMOKE=1 so it
//! doesn't run in the default suite (it loads a multi-GB model).
//!
//! Run:
//!   $env:LLAMA_BOARD_SMOKE = "1"
//!   $env:LLAMA_BOARD_SMOKE_MODEL = "C:\Users\joojoo\.lmstudio\models\lmstudio-community\Qwen3.8-27B-GGUF\Qwen3.8-27B-Q4_K_M.gguf"
//!   cd src-tauri && cargo test --test smoke
use std::sync::{Arc, Mutex};

use llama_board_lib::{server, AppConfig, ErrBuf};

fn cfg_with(model: &str) -> AppConfig {
    AppConfig {
        active_model: model.to_string(),
        port: 18081,
        ngl: 999,
        ctx_size: 4096,
        flash_attn: "on".into(),
        ..AppConfig::default()
    }
}

/// Gated behind `LLAMA_BOARD_SMOKE=1` and `#[ignore]`: the default `cargo
/// test` gate must not report this as "passed" when it never actually ran a
/// server (see `tests/smoke_fake.rs` for the deterministic equivalent that
/// always runs). Invoke explicitly with `cargo test --test smoke -- --ignored`.
#[test]
#[ignore = "downloads/loads a multi-GB model; set LLAMA_BOARD_SMOKE=1 and run with --ignored"]
fn smoke_real_server_and_chat() {
    if std::env::var_os("LLAMA_BOARD_SMOKE").is_none() {
        eprintln!("[SMOKE SKIP] Set LLAMA_BOARD_SMOKE=1 and LLAMA_BOARD_SMOKE_MODEL to run the real-server smoke test.");
        return;
    }
    let model = std::env::var("LLAMA_BOARD_SMOKE_MODEL").expect("set LLAMA_BOARD_SMOKE_MODEL");
    let cfg = cfg_with(&model);

    let ring = Arc::new(ErrBuf::default());
    let api_key = "smoke-token";
    let (child, url, api_key_file) = match server::spawn(&cfg, api_key, &ring) {
        Ok(v) => v,
        Err(e) => panic!("spawn failed: {e}\nstderr: {}", ring.tail()),
    };
    let shared = Arc::new(Mutex::new(server::ServerState::default()));
    shared.lock().expect("server state lock").attach_starting(
        child,
        url.clone(),
        api_key.to_string(),
        model.clone(),
        cfg.mmproj.clone(),
    );
    println!("[smoke] spawned, url={url} — waiting for /health…");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let ready =
        rt.block_on(async { server::wait_ready(shared.clone(), &url, api_key, 600, &ring).await });
    server::cleanup_api_key_file(api_key_file.as_deref());
    if let Err(e) = ready {
        panic!("wait_ready failed: {e}");
    }
    println!("[smoke] server is READY");

    let base = url.replace("/v1", "");
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "smoke",
        "messages": [{"role":"user","content":"Reply with exactly: OK"}],
        "stream": true,
        "max_tokens": 16,
        "temperature": 0.0
    });
    let resp = rt.block_on(async {
        client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
            .expect("chat request failed")
    });
    assert!(resp.status().is_success(), "chat HTTP {}", resp.status());

    let got = rt.block_on(async {
        let mut buf = Vec::new();
        let mut stream = resp;
        while let Ok(Some(chunk)) = stream.chunk().await {
            buf.extend_from_slice(&chunk);
        }
        String::from_utf8_lossy(&buf).to_string()
    });
    println!("[smoke] streamed response ({} bytes):\n{}", got.len(), got);
    assert!(!got.is_empty(), "no SSE data received");
    assert!(got.contains("data:"), "expected SSE 'data:' frames");

    server::kill(
        &mut shared.lock().expect("server state lock").child,
        Some(ring.clone()),
    );
    println!("[smoke] killed server. ring tail: {}", ring.tail().trim());
}
