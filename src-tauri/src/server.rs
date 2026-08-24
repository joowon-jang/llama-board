// src-tauri/src/server.rs
use crate::config::AppConfig;
use crate::runtime;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Lifecycle {
    Stopped,
    Starting,
    Ready,
    Stopping,
    Failed,
    Crashed,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Ready => "running",
            Self::Stopping => "stopping",
            Self::Failed => "failed",
            Self::Crashed => "crashed",
        }
    }

    pub fn blocks_resource_change(self) -> bool {
        matches!(self, Self::Starting | Self::Ready | Self::Stopping)
    }
}

pub struct ServerState {
    pub child: Option<Child>,
    pub url: String,
    pub api_key: String,
    pub lifecycle: Lifecycle,
    pub last_error: Option<String>,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            child: None,
            url: String::new(),
            api_key: String::new(),
            lifecycle: Lifecycle::Stopped,
            last_error: None,
        }
    }
}

impl Default for ServerState {
    fn default() -> Self {
        Self::new()
    }
}

impl ServerState {
    pub fn attach_starting(&mut self, child: Child, url: String, api_key: String) {
        self.child = Some(child);
        self.url = url;
        self.api_key = api_key;
        self.lifecycle = Lifecycle::Starting;
        self.last_error = None;
    }
}

/// Thread-safe, bounded stderr ring — keeps the last ~4 KB so a failed start can surface why.
#[derive(Default)]
pub struct ErrBuf {
    inner: Mutex<Vec<u8>>,
}

const CAP: usize = 4096;

impl ErrBuf {
    pub fn push(&self, chunk: &[u8]) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        guard.extend_from_slice(chunk);
        let len = guard.len();
        if len > CAP {
            guard.drain(..len - CAP);
        }
    }

    pub fn tail(&self) -> String {
        self.inner
            .lock()
            .map(|guard| String::from_utf8_lossy(&guard).into_owned())
            .unwrap_or_default()
    }

    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.clear();
        }
    }
}

/// Resolve the configured managed runtime first, then PATH/WinGet.
pub fn server_bin(cfg: &AppConfig) -> Result<String, String> {
    if !cfg.active_backend.is_empty() || !cfg.active_build.is_empty() {
        if cfg.active_backend.is_empty() || cfg.active_build.is_empty() {
            return Err("runtime backend and build must be selected together".into());
        }
        let path = runtime::server_bin_for(&cfg.active_backend, &cfg.active_build)?;
        if path.is_file() {
            return Ok(path.to_string_lossy().into_owned());
        }
        return Err(format!(
            "managed runtime is missing llama-server: {}",
            path.display()
        ));
    }

    if let Ok(path) = which::which(runtime::server_executable_name()) {
        return Ok(path.to_string_lossy().into_owned());
    }

    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let fallback = runtime::system_server_fallback(&local);
    if fallback.is_file() {
        return Ok(fallback.to_string_lossy().into_owned());
    }
    Err("llama-server was not found on PATH or in the WinGet package directory".into())
}

pub fn build_args(cfg: &AppConfig, api_key: &str) -> Vec<String> {
    let mut args = vec![
        "--model".into(),
        cfg.active_model.clone(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        cfg.port.to_string(),
        "--n-gpu-layers".into(),
        cfg.ngl.to_string(),
        "--ctx-size".into(),
        cfg.ctx_size.to_string(),
        "--flash-attn".into(),
        cfg.flash_attn.clone(),
    ];
    if cfg.n_cpu_moe > 0 {
        args.push("--n-cpu-moe".into());
        args.push(cfg.n_cpu_moe.to_string());
    }
    if cfg.threads > 0 {
        args.push("--threads".into());
        args.push(cfg.threads.to_string());
    }
    args.push("--api-key".into());
    args.push(api_key.into());
    args.push("--cont-batching".into());
    args.push("--no-webui".into());
    args
}

/// Spawn the server, drain stderr into the shared ring so the pipe never fills, and return it.
pub fn spawn(
    cfg: &AppConfig,
    api_key: &str,
    ring: &Arc<ErrBuf>,
) -> Result<(Child, String), String> {
    let bin = server_bin(cfg)?;
    let args = build_args(cfg, api_key);
    let mut child = Command::new(&bin)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn llama-server: {e}"))?;
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate(&mut child);
            return Err("llama-server stderr pipe was not available".to_string());
        }
    };
    let error_ring = ring.clone();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => error_ring.push(&buffer[..size]),
            }
        }
    });
    Ok((child, format!("http://127.0.0.1:{}/v1", cfg.port)))
}

fn auth_header(api_key: &str) -> String {
    format!("Bearer {api_key}")
}

/// Poll both /health and /v1/models until the child is usable or timeout expires.
pub async fn wait_ready(
    shared: Arc<Mutex<ServerState>>,
    url: &str,
    api_key: &str,
    timeout_s: u64,
    err: &Arc<ErrBuf>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| {
            if let Ok(mut state) = shared.lock() {
                kill(&mut state.child, None);
            }
            format!("failed to create readiness client: {e}")
        })?;
    let health = url.replace("/v1", "/health");
    let models = format!("{url}/models");
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_s);

    while std::time::Instant::now() < deadline {
        let process_status = {
            let mut state = shared
                .lock()
                .map_err(|_| "server state lock was poisoned".to_string())?;
            let child = state
                .child
                .as_mut()
                .ok_or_else(|| "server process tracking was lost".to_string())?;
            child.try_wait()
        };
        match process_status {
            Ok(Some(status)) => {
                let code = status
                    .code()
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "signal".into());
                return Err(format!(
                    "server exited before ready ({code}). {}",
                    err.tail().trim()
                ));
            }
            Ok(None) => {}
            Err(error) => {
                if let Ok(mut state) = shared.lock() {
                    kill(&mut state.child, None);
                }
                return Err(format!("failed to inspect server process: {error}"));
            }
        }

        let header = auth_header(api_key);
        let health_ok = client
            .get(&health)
            .header("Authorization", &header)
            .send()
            .await
            .map(|response| response.status().as_u16() == 200)
            .unwrap_or(false);
        if health_ok {
            let models_ok = client
                .get(&models)
                .header("Authorization", &header)
                .send()
                .await
                .map(|response| response.status().is_success())
                .unwrap_or(false);
            if models_ok {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if let Ok(mut state) = shared.lock() {
        kill(&mut state.child, None);
    }
    let tail = err.tail();
    Err(format!(
        "server did not become ready within {timeout_s}s. {}",
        tail.trim()
    ))
}

fn terminate(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let killed_tree = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !killed_tree {
            let _ = child.kill();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Kill and reap the child process. The caller controls whether the error ring is cleared.
pub fn kill(child: &mut Option<Child>, err: Option<Arc<ErrBuf>>) {
    if let Some(mut process) = child.take() {
        terminate(&mut process);
    }
    if let Some(error_ring) = err {
        error_ring.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_args_binds_loopback_and_uses_supplied_token() {
        let cfg = AppConfig {
            active_model: "model.gguf".into(),
            ..AppConfig::default()
        };
        let args = build_args(&cfg, "per-process-token");
        assert!(args.windows(2).any(|pair| pair == ["--host", "127.0.0.1"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--api-key", "per-process-token"]));
    }

    #[test]
    fn startup_child_is_tracked_before_readiness() {
        let child = if cfg!(windows) {
            Command::new("cmd")
                .args(["/C", "exit", "0"])
                .spawn()
                .unwrap()
        } else {
            Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap()
        };
        let mut state = ServerState::default();
        state.attach_starting(
            child,
            "http://127.0.0.1:8080/v1".to_string(),
            "token".to_string(),
        );
        assert_eq!(state.lifecycle, Lifecycle::Starting);
        assert!(state.child.is_some());
        assert_eq!(state.api_key, "token");
        kill(&mut state.child, None);
    }

    #[test]
    fn readiness_timeout_reaps_the_tracked_child() {
        let child = if cfg!(windows) {
            Command::new("cmd")
                .args(["/C", "ping 127.0.0.1 -n 8 > NUL"])
                .spawn()
                .unwrap()
        } else {
            Command::new("sh").args(["-c", "sleep 8"]).spawn().unwrap()
        };
        let shared = Arc::new(Mutex::new(ServerState::default()));
        shared.lock().unwrap().attach_starting(
            child,
            "http://127.0.0.1:59999/v1".to_string(),
            "token".to_string(),
        );
        let err = Arc::new(ErrBuf::default());
        let result = tokio::runtime::Runtime::new().unwrap().block_on(wait_ready(
            shared.clone(),
            "http://127.0.0.1:59999/v1",
            "token",
            1,
            &err,
        ));
        assert!(result.is_err());
        assert!(shared.lock().unwrap().child.is_none());
    }
}
