//! End-to-end smoke test: spawn the real llama-server, wait for /health, run a
//! streaming chat completion, then kill. Gated behind LLAMA_BOARD_SMOKE=1 so it
//! doesn't run in the default suite (it loads a multi-GB model).
//!
//! Run:
//!   $env:LLAMA_BOARD_SMOKE = "1"
//!   $env:LLAMA_BOARD_SMOKE_MODEL = "C:\Users\joojoo\.lmstudio\models\lmstudio-community\Qwen3.8-27B-GGUF\Qwen3.8-27B-Q4_K_M.gguf"
//!   cd src-tauri && cargo test --test smoke
use std::sync::Arc;

use llama_board_lib::{server, AppConfig, ErrBuf};

fn cfg_with(model: &str) -> AppConfig {
    let mut c = AppConfig::default();
    c.active_model = model.to_string();
    c.port = 18081;
    c.ngl = 999;
    c.ctx_size = 4096;
    c.flash_attn = "on".into();
    c
}

#[test]
fn smoke_real_server_and_chat() {
    if std::env::var_os("LLAMA_BOARD_SMOKE").is_none() {
        eprintln!("skipping (set LLAMA_BOARD_SMOKE=1)");
        return;
    }
    let model = std::env::var("LLAMA_BOARD_SMOKE_MODEL").expect("set LLAMA_BOARD_SMOKE_MODEL");
    let cfg = cfg_with(&model);

    let ring = Arc::new(ErrBuf::default());
    let (mut child, url, _ring) = match server::spawn(&cfg, &ring) {
        Ok(v) => v,
        Err(e) => panic!("spawn failed: {e}\nstderr: {}", ring.tail()),
    };
    println!("[smoke] spawned, url={url} — waiting for /health…");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        if let Err(e) = server::wait_ready(&mut child, &url, 600, &ring).await {
            panic!("wait_ready failed: {e}");
        }
    });
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
            .bearer_auth("board-local")
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

    let mut opt = Some(child);
    server::kill(&mut opt, Some(ring.clone()));
    println!("[smoke] killed server. ring tail: {}", ring.tail().trim());
}
