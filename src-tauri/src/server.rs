// src-tauri/src/server.rs
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use crate::config::AppConfig;
use crate::runtime;

pub struct ServerState {
    pub child: Option<Child>,
    pub url: String,
    pub running: bool,
}
impl ServerState {
    pub fn new() -> Self { Self { child: None, url: String::new(), running: false } }
}

/// Thread-safe, bounded stderr ring — keeps the last ~4 KB so a failed start can surface *why*.
#[derive(Default)]
pub struct ErrBuf { inner: Mutex<Vec<u8>> }
const CAP: usize = 4096;
impl ErrBuf {
    pub fn push(&self, chunk: &[u8]) {
        let mut g = self.inner.lock().unwrap();
        g.extend_from_slice(chunk);
        let len = g.len();
        if len > CAP {
            g.drain(..len - CAP);
        }
    }
    pub fn tail(&self) -> String {
        let g = self.inner.lock().unwrap();
        String::from_utf8_lossy(&g).into_owned()
    }
    pub fn clear(&self) {
        let mut g = self.inner.lock().unwrap();
        g.clear();
    }
}

/// Resolve llama-server.exe: active managed runtime first, then PATH/WinGet.
pub fn server_bin(cfg: &AppConfig) -> String {
    if !cfg.active_backend.is_empty() && !cfg.active_build.is_empty() {
        let p = runtime::server_bin_for(&cfg.active_backend, &cfg.active_build);
        if p.exists() { return p.to_string_lossy().to_string(); }
    }
    which::which("llama-server")
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| {
            let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
            format!("{local}\\Microsoft\\WinGet\\Packages\\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\\llama-server.exe")
        })
}

pub fn build_args(cfg: &AppConfig) -> Vec<String> {
    let mut a = vec![
        "--model".into(), cfg.active_model.clone(),
        "--port".into(), cfg.port.to_string(),
        "--n-gpu-layers".into(), cfg.ngl.to_string(),
        "--ctx-size".into(), cfg.ctx_size.to_string(),
        "--flash-attn".into(), cfg.flash_attn.clone(),
    ];
    if cfg.n_cpu_moe > 0 { a.push("--n-cpu-moe".into()); a.push(cfg.n_cpu_moe.to_string()); }
    if cfg.threads > 0 { a.push("--threads".into()); a.push(cfg.threads.to_string()); }
    a.push("--api-key".into());
    a.push("board-local".into());
    a.push("--cont-batching".into());
    a.push("--no-webui".into());
    a
}

/// Spawn the server, drain stderr into the provided shared ring (so the pipe never
/// fills and blocks the child), and return the child + URL + the ring we drained.
pub fn spawn(cfg: &AppConfig, ring: &Arc<ErrBuf>) -> Result<(Child, String, Arc<ErrBuf>), String> {
    let bin = server_bin(cfg);
    let args = build_args(cfg);
    println!("[llama-board] spawn: {bin} {}", args.join(" "));
    let mut child = Command::new(&bin).args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn().map_err(|e| format!("failed to spawn {bin}: {e}"))?;
    let stderr = child.stderr.take().expect("stderr piped");
    let e2 = ring.clone();
    std::thread::spawn(move || {
        let mut s = std::io::BufReader::new(stderr);
        let mut b = [0u8; 8192];
        loop {
            match s.read(&mut b) {
                Ok(0) => break,
                Ok(n) => e2.push(&b[..n]),
                Err(_) => break,
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    });
    Ok((child, format!("http://127.0.0.1:{}/v1", cfg.port), ring.clone()))
}

/// Poll /health until 200 or timeout. If the child exits first, surface its stderr.
/// `Err` carries the captured stderr tail so the UI can show *why*.
pub async fn wait_ready(child: &mut Child, url: &str, timeout_s: u64, err: &Arc<ErrBuf>) -> Result<(), String> {
    let client = reqwest::Client::new();
    let health = url.replace("/v1", "/health");
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_s);
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(st)) => {
                // Early exit: drain the tail and report why.
                let tail = err.tail();
                let code = st.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
                return Err(format!("server exited before ready ({}). {}", code, tail.trim()));
            }
            Ok(None) => {}
            Err(_) => {}
        }
        if client.get(&health).send().await.map(|r| r.status().as_u16() == 200).unwrap_or(false) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let _ = child.kill();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let tail = err.tail();
    Err(format!("server did not become ready within {timeout_s}s. {}", tail.trim()))
}

/// Kill the child and clear its stderr ring.
pub fn kill(child: &mut Option<Child>, err: Option<Arc<ErrBuf>>) {
    if let Some(c) = child.as_mut() { let _ = c.kill(); }
    *child = None;
    if let Some(e) = err { e.clear(); }
}
