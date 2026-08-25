// src-tauri/src/server.rs
use crate::config::AppConfig;
use crate::runtime;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
    /// Retained internally so crash diagnostics stay redacted after the public
    /// API key is cleared from the status payload.
    pub redaction_secret: String,
    pub model: String,
    pub mmproj: String,
    pub lifecycle: Lifecycle,
    pub last_error: Option<String>,
    pub last_activity_at: Instant,
    pub active_requests: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct MemoryEstimate {
    pub model_mb: u64,
    pub context_mb: u64,
    pub kv_mb: u64,
    pub projector_mb: u64,
    pub adapters_mb: u64,
    pub total_mb: u64,
    pub source: &'static str,
}

fn file_size_mb(path: &str) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len().div_ceil(1024 * 1024))
}

pub fn estimate_memory(cfg: &AppConfig, model: &str, mmproj: &str) -> MemoryEstimate {
    let model_mb = file_size_mb(model).unwrap_or(0);
    let projector_mb = file_size_mb(mmproj).unwrap_or(0);
    let adapters_mb = cfg
        .lora_adapters
        .iter()
        .filter(|adapter| adapter.enabled)
        .filter_map(|adapter| file_size_mb(&adapter.path))
        .sum();
    let slots = u64::from(cfg.parallel.max(1));
    let context_mb = u64::from(cfg.ctx_size).saturating_mul(slots).div_ceil(1024);
    let kv_mb = context_mb.saturating_mul(8);
    let subtotal = model_mb
        .saturating_add(projector_mb)
        .saturating_add(adapters_mb)
        .saturating_add(kv_mb);
    let total_mb = subtotal.saturating_mul(108).div_ceil(100);
    MemoryEstimate {
        model_mb,
        context_mb,
        kv_mb,
        projector_mb,
        adapters_mb,
        total_mb,
        source: if model_mb > 0 {
            "filesystem"
        } else {
            "unknown"
        },
    }
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            child: None,
            url: String::new(),
            api_key: String::new(),
            redaction_secret: String::new(),
            model: String::new(),
            mmproj: String::new(),
            lifecycle: Lifecycle::Stopped,
            last_error: None,
            last_activity_at: Instant::now(),
            active_requests: 0,
        }
    }
}

impl Default for ServerState {
    fn default() -> Self {
        Self::new()
    }
}

impl ServerState {
    pub fn attach_starting(
        &mut self,
        child: Child,
        url: String,
        api_key: String,
        model: String,
        mmproj: String,
    ) {
        self.child = Some(child);
        self.url = url;
        self.redaction_secret = api_key.clone();
        self.api_key = api_key;
        self.model = model;
        self.mmproj = mmproj;
        self.lifecycle = Lifecycle::Starting;
        self.last_error = None;
        self.last_activity_at = Instant::now();
        self.active_requests = 0;
    }

    pub fn touch_activity(&mut self) {
        self.last_activity_at = Instant::now();
    }

    pub fn begin_request(&mut self) {
        self.active_requests = self.active_requests.saturating_add(1);
        self.touch_activity();
    }

    pub fn end_request(&mut self) {
        self.active_requests = self.active_requests.saturating_sub(1);
        self.touch_activity();
    }

    pub fn idle_seconds(&self) -> u64 {
        self.last_activity_at.elapsed().as_secs()
    }

    pub fn auto_unload_due(&self, idle_seconds: i64) -> bool {
        idle_seconds > 0 && self.active_requests == 0 && self.idle_seconds() >= idle_seconds as u64
    }
}

/// Thread-safe, bounded stderr ring — keeps the last ~4 KB so a failed start can surface why.
#[derive(Default)]
pub struct ErrBuf {
    inner: Mutex<Vec<u8>>,
    secret: Mutex<String>,
}

const CAP: usize = 4096;

impl ErrBuf {
    pub fn set_secret(&self, secret: &str) {
        if let Ok(mut guard) = self.secret.lock() {
            *guard = secret.to_owned();
        }
    }

    pub fn clear_secret(&self) {
        if let Ok(mut guard) = self.secret.lock() {
            guard.clear();
        }
    }

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
        let text = self
            .inner
            .lock()
            .map(|guard| String::from_utf8_lossy(&guard).into_owned())
            .unwrap_or_default();
        let secret = self
            .secret
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        redact_text(&text, &secret)
    }

    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.clear();
        }
    }
}

pub fn redact_text(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        text.to_owned()
    } else {
        text.replace(secret, "[REDACTED]")
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

pub fn build_args(cfg: &AppConfig, _api_key: &str) -> Vec<String> {
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
    if !cfg.mmproj.trim().is_empty() {
        args.push("--mmproj".into());
        args.push(cfg.mmproj.clone());
    }
    if cfg.parallel > 0 {
        args.push("--parallel".into());
        args.push(cfg.parallel.to_string());
    }
    if cfg.request_timeout_seconds != 3600 {
        args.push("--timeout".into());
        args.push(cfg.request_timeout_seconds.to_string());
    }
    if cfg.sleep_idle_seconds >= 0 {
        args.push("--sleep-idle-seconds".into());
        args.push(cfg.sleep_idle_seconds.to_string());
    }
    let lora_plain = cfg
        .lora_adapters
        .iter()
        .filter(|adapter| adapter.enabled && (adapter.scale - 1.0).abs() < f32::EPSILON)
        .map(|adapter| adapter.path.clone())
        .collect::<Vec<_>>();
    if !lora_plain.is_empty() {
        args.push("--lora".into());
        args.push(lora_plain.join(","));
    }
    let lora_scaled = cfg
        .lora_adapters
        .iter()
        .filter(|adapter| adapter.enabled && (adapter.scale - 1.0).abs() >= f32::EPSILON)
        .map(|adapter| format!("{}:{}", adapter.path, adapter.scale))
        .collect::<Vec<_>>();
    if !lora_scaled.is_empty() {
        args.push("--lora-scaled".into());
        args.push(lora_scaled.join(","));
    }
    if cfg.n_cpu_moe > 0 {
        args.push("--n-cpu-moe".into());
        args.push(cfg.n_cpu_moe.to_string());
    }
    if cfg.threads > 0 {
        args.push("--threads".into());
        args.push(cfg.threads.to_string());
    }
    if cfg.spec_type != "none" && !cfg.spec_type.trim().is_empty() {
        args.push("--spec-type".into());
        args.push(cfg.spec_type.clone());
        if cfg.spec_draft_n_max != 3 {
            args.push("--spec-draft-n-max".into());
            args.push(cfg.spec_draft_n_max.to_string());
        }
        if cfg.spec_draft_n_min != 0 {
            args.push("--spec-draft-n-min".into());
            args.push(cfg.spec_draft_n_min.to_string());
        }
        if cfg.spec_draft_p_min != 0.0 {
            args.push("--spec-draft-p-min".into());
            args.push(cfg.spec_draft_p_min.to_string());
        }
        if cfg.spec_draft_p_split != 0.1 {
            args.push("--spec-draft-p-split".into());
            args.push(cfg.spec_draft_p_split.to_string());
        }
        if cfg.spec_draft_ngl != "auto" && !cfg.spec_draft_ngl.trim().is_empty() {
            args.push("--spec-draft-ngl".into());
            args.push(cfg.spec_draft_ngl.clone());
        }
        if !cfg.spec_draft_device.trim().is_empty() {
            args.push("--spec-draft-device".into());
            args.push(cfg.spec_draft_device.clone());
        }
        if !cfg.spec_draft_model.trim().is_empty() {
            args.push("--spec-draft-model".into());
            args.push(cfg.spec_draft_model.clone());
        }
    }
    if cfg.reasoning != "auto" {
        args.push("--reasoning".into());
        args.push(cfg.reasoning.clone());
    }
    if cfg.reasoning_format != "auto" {
        args.push("--reasoning-format".into());
        args.push(cfg.reasoning_format.clone());
    }
    // `none` is an OpenAI-compatible per-request value; the llama-server
    // CLI accepts template effort levels but not `--reasoning-effort none`.
    if cfg.reasoning_effort != "default" && cfg.reasoning_effort != "none" {
        args.push("--reasoning-effort".into());
        args.push(cfg.reasoning_effort.clone());
    }
    if cfg.reasoning_budget != -1 {
        args.push("--reasoning-budget".into());
        args.push(cfg.reasoning_budget.to_string());
    }
    if !cfg.reasoning_budget_message.trim().is_empty() {
        args.push("--reasoning-budget-message".into());
        args.push(cfg.reasoning_budget_message.clone());
    }
    match cfg.reasoning_preserve.as_str() {
        "on" => args.push("--reasoning-preserve".into()),
        "off" => args.push("--no-reasoning-preserve".into()),
        _ => {}
    }
    if !has_flag(&cfg.server_args, &["--cont-batching", "--no-cont-batching"]) {
        args.push("--cont-batching".into());
    }
    if !has_flag(&cfg.server_args, &["--webui", "--no-webui"]) {
        args.push("--no-webui".into());
    }
    args.extend(cfg.server_args.iter().cloned());
    args
}

fn has_flag(args: &[String], names: &[&str]) -> bool {
    args.iter().any(|argument| {
        let name = argument
            .split_once('=')
            .map_or(argument.as_str(), |(name, _)| name);
        names.contains(&name)
    })
}

fn create_api_key_file(api_key: &str) -> Result<Option<PathBuf>, String> {
    if api_key.is_empty() {
        return Ok(None);
    }
    let path =
        std::env::temp_dir().join(format!("llama-board-api-key-{}.txt", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("failed to create temporary API key file: {error}"))?;
    if let Err(error) = writeln!(file, "{api_key}").and_then(|_| file.flush()) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("failed to write temporary API key file: {error}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(Some(path))
}

pub fn cleanup_api_key_file(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

/// Spawn the server, drain stderr into the shared ring so the pipe never fills, and return it.
pub fn spawn(
    cfg: &AppConfig,
    api_key: &str,
    ring: &Arc<ErrBuf>,
) -> Result<(Child, String, Option<PathBuf>), String> {
    let bin = server_bin(cfg)?;
    let api_key_file = create_api_key_file(api_key)?;
    let mut args = build_args(cfg, api_key);
    if let Some(path) = api_key_file.as_ref() {
        args.push("--api-key-file".into());
        args.push(path.to_string_lossy().into_owned());
    }
    ring.set_secret(api_key);
    let mut command = Command::new(&bin);
    command.args(&args);
    let mut child = command
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            cleanup_api_key_file(api_key_file.as_deref());
            format!("failed to spawn llama-server: {e}")
        })?;
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate(&mut child);
            cleanup_api_key_file(api_key_file.as_deref());
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
    Ok((
        child,
        format!("http://127.0.0.1:{}/v1", cfg.port),
        api_key_file,
    ))
}

fn auth_header(api_key: &str) -> String {
    format!("Bearer {api_key}")
}

fn netstat_line_owns_listener(line: &str, pid: u32, port: u16) -> bool {
    let fields = line.split_whitespace().collect::<Vec<_>>();
    if fields.len() < 5
        || !fields[0].eq_ignore_ascii_case("TCP")
        || !fields[3].eq_ignore_ascii_case("LISTENING")
        || fields[4] != pid.to_string()
    {
        return false;
    }
    fields[1]
        .rsplit_once(':')
        .is_some_and(|(_, value)| value == port.to_string())
}

fn listener_owned_by_child(pid: u32, port: u16) -> bool {
    #[cfg(windows)]
    {
        let Ok(output) = Command::new("netstat").args(["-ano", "-p", "tcp"]).output() else {
            return false;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines()
            .any(|line| netstat_line_owns_listener(line, pid, port))
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, port);
        true
    }
}

fn port_from_url(url: &str) -> Option<u16> {
    reqwest::Url::parse(url).ok()?.port()
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
    let port = match port_from_url(url) {
        Some(port) => port,
        None => {
            if let Ok(mut state) = shared.lock() {
                kill(&mut state.child, None);
            }
            return Err("server URL has no valid port".to_string());
        }
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_s);
    let mut listener_mismatch = false;

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
                if let Ok(mut state) = shared.lock() {
                    kill(&mut state.child, None);
                }
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
            let models_response = client
                .get(&models)
                .header("Authorization", &header)
                .send()
                .await
                .ok();
            if let Some(response) = models_response {
                if response.status().is_success() {
                    let payload = response.json::<serde_json::Value>().await.ok();
                    let model_id = payload
                        .as_ref()
                        .and_then(|value| value.get("data"))
                        .and_then(serde_json::Value::as_array)
                        .and_then(|items| items.first())
                        .and_then(|item| item.get("id"))
                        .and_then(serde_json::Value::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .map(str::to_owned);
                    if let Some(model_id) = model_id {
                        let pid = shared
                            .lock()
                            .map_err(|_| "server state lock was poisoned".to_string())?
                            .child
                            .as_ref()
                            .map(Child::id)
                            .ok_or_else(|| "server process tracking was lost".to_string())?;
                        let owns_listener =
                            tokio::task::spawn_blocking(move || listener_owned_by_child(pid, port))
                                .await
                                .unwrap_or(false);
                        if owns_listener {
                            if let Ok(mut state) = shared.lock() {
                                state.model = model_id;
                            }
                            return Ok(());
                        }
                        listener_mismatch = true;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if let Ok(mut state) = shared.lock() {
        kill(&mut state.child, None);
    }
    let tail = err.tail();
    let ownership = if listener_mismatch {
        "the configured port was not owned by the managed server process"
    } else {
        ""
    };
    Err(format!(
        "server did not become ready within {timeout_s}s. {} {}",
        ownership,
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
        error_ring.clear_secret();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_args_binds_loopback_without_exposing_supplied_token() {
        let cfg = AppConfig {
            active_model: "model.gguf".into(),
            reasoning_effort: "xhigh".into(),
            server_args: vec!["--batch-size".into(), "1024".into(), "--jinja".into()],
            ..AppConfig::default()
        };
        let args = build_args(&cfg, "per-process-token");
        assert!(args.windows(2).any(|pair| pair == ["--host", "127.0.0.1"]));
        assert!(!args.iter().any(|arg| arg.contains("per-process-token")));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--reasoning-effort", "xhigh"]));
        assert!(args.windows(2).any(|pair| pair == ["--batch-size", "1024"]));
        assert!(args.iter().any(|arg| arg == "--jinja"));
    }

    #[test]
    fn netstat_listener_ownership_requires_managed_pid_and_port() {
        let line = "  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    24128";
        assert!(netstat_line_owns_listener(line, 24128, 8080));
        assert!(!netstat_line_owns_listener(line, 24129, 8080));
        assert!(!netstat_line_owns_listener(line, 24128, 8081));
    }

    #[test]
    fn build_args_omits_auth_flag_for_explicit_headless_no_auth_mode() {
        let cfg = AppConfig {
            active_model: "model.gguf".into(),
            ..AppConfig::default()
        };
        let args = build_args(&cfg, "");
        assert!(!args.iter().any(|arg| arg == "--api-key"));
        assert!(!args.iter().any(|arg| arg.contains("per-process-token")));
    }

    #[test]
    fn api_key_file_is_removed_after_child_startup() {
        let path = create_api_key_file("per-process-token")
            .expect("key file creation should succeed")
            .expect("non-empty key should create a file");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "per-process-token\n"
        );
        cleanup_api_key_file(Some(&path));
        assert!(!path.exists());
    }

    #[test]
    fn build_args_includes_lifecycle_and_lora_controls() {
        let cfg = AppConfig {
            active_model: "model.gguf".into(),
            parallel: 4,
            request_timeout_seconds: 120,
            sleep_idle_seconds: 900,
            lora_adapters: vec![crate::config::LoraAdapterConfig {
                path: "style.gguf".into(),
                scale: 0.65,
                enabled: true,
            }],
            ..AppConfig::default()
        };
        let args = build_args(&cfg, "token");
        assert!(args.windows(2).any(|pair| pair == ["--parallel", "4"]));
        assert!(args.windows(2).any(|pair| pair == ["--timeout", "120"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--sleep-idle-seconds", "900"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--lora-scaled", "style.gguf:0.65"]));
    }

    #[test]
    fn error_tail_redacts_a_secret_after_it_is_cleared_from_public_state() {
        let ring = ErrBuf::default();
        ring.set_secret("local-secret");
        ring.push(b"authentication failed for local-secret");
        assert_eq!(ring.tail(), "authentication failed for [REDACTED]");
    }

    #[test]
    fn lifecycle_activity_blocks_unload_while_a_request_is_active() {
        let mut state = ServerState::new();
        state.last_activity_at = std::time::Instant::now() - Duration::from_secs(20);
        assert!(state.auto_unload_due(10));
        state.begin_request();
        assert_eq!(state.active_requests, 1);
        assert!(!state.auto_unload_due(10));
        state.end_request();
        assert_eq!(state.active_requests, 0);
        assert!(!state.auto_unload_due(10));
        state.last_activity_at = std::time::Instant::now() - Duration::from_secs(20);
        assert!(state.auto_unload_due(10));
    }

    #[test]
    fn memory_estimate_accounts_for_model_projector_adapters_and_slots() {
        let root = std::env::temp_dir().join(format!("llama-board-memory-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create memory fixture");
        let model = root.join("model.gguf");
        let projector = root.join("mmproj.gguf");
        let adapter = root.join("style.gguf");
        std::fs::write(&model, vec![0_u8; 2 * 1024 * 1024]).expect("write model fixture");
        std::fs::write(&projector, vec![0_u8; 1024 * 1024]).expect("write projector fixture");
        std::fs::write(&adapter, vec![0_u8; 1024 * 1024]).expect("write adapter fixture");
        let cfg = AppConfig {
            ctx_size: 2048,
            parallel: 2,
            lora_adapters: vec![crate::config::LoraAdapterConfig {
                path: adapter.to_string_lossy().into_owned(),
                scale: 1.0,
                enabled: true,
            }],
            ..AppConfig::default()
        };
        let estimate =
            estimate_memory(&cfg, &model.to_string_lossy(), &projector.to_string_lossy());
        assert_eq!(estimate.model_mb, 2);
        assert_eq!(estimate.projector_mb, 1);
        assert_eq!(estimate.adapters_mb, 1);
        assert!(estimate.kv_mb > 0);
        assert!(estimate.total_mb > estimate.model_mb);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn build_args_includes_literal_advanced_args_and_honors_flag_overrides() {
        let cfg = AppConfig {
            active_model: "model.gguf".into(),
            server_args: vec![
                "--min-p".into(),
                "0.05".into(),
                "--no-cont-batching".into(),
                "--webui".into(),
            ],
            ..AppConfig::default()
        };
        let args = build_args(&cfg, "token");
        assert!(args.windows(2).any(|pair| pair == ["--min-p", "0.05"]));
        assert!(args.iter().any(|arg| arg == "--no-cont-batching"));
        assert!(args.iter().any(|arg| arg == "--webui"));
        assert!(!args.iter().any(|arg| arg == "--cont-batching"));
        assert!(!args.iter().any(|arg| arg == "--no-webui"));
    }

    #[test]
    fn build_args_includes_mtp_and_reasoning_controls() {
        let cfg = AppConfig {
            active_model: "model-with-mtp.gguf".into(),
            spec_type: "draft-mtp".into(),
            spec_draft_n_max: 5,
            spec_draft_n_min: 1,
            spec_draft_p_min: 0.75,
            spec_draft_p_split: 0.2,
            spec_draft_ngl: "all".into(),
            spec_draft_device: "Vulkan0".into(),
            reasoning: "on".into(),
            reasoning_format: "deepseek".into(),
            reasoning_effort: "high".into(),
            reasoning_budget: 4096,
            reasoning_preserve: "on".into(),
            ..AppConfig::default()
        };
        let args = build_args(&cfg, "token");
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--spec-type", "draft-mtp"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--spec-draft-n-max", "5"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--spec-draft-n-min", "1"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--spec-draft-p-min", "0.75"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--spec-draft-p-split", "0.2"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--spec-draft-ngl", "all"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--spec-draft-device", "Vulkan0"]));
        assert!(args.windows(2).any(|pair| pair == ["--reasoning", "on"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--reasoning-format", "deepseek"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--reasoning-effort", "high"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--reasoning-budget", "4096"]));
        assert!(args.iter().any(|arg| arg == "--reasoning-preserve"));

        let request_only = AppConfig {
            reasoning_effort: "none".into(),
            ..cfg
        };
        let request_args = build_args(&request_only, "token");
        assert!(!request_args.iter().any(|arg| arg == "--reasoning-effort"));
    }

    #[test]
    fn build_args_includes_multimodal_projector() {
        let cfg = AppConfig {
            active_model: "qwen38.gguf".into(),
            mmproj: "mmproj-Qwen3.8-F32.gguf".into(),
            ..AppConfig::default()
        };
        let args = build_args(&cfg, "token");
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--mmproj", "mmproj-Qwen3.8-F32.gguf"]));
    }

    #[test]
    fn dedicated_arguments_are_emitted_once_and_advanced_values_cannot_win() {
        let cfg = AppConfig {
            active_model: "model.gguf".into(),
            ngl: 77,
            ctx_size: 8192,
            server_args: vec![
                "--min-p".into(),
                "0.05".into(),
                "--ctx-size".into(),
                "999".into(),
            ],
            ..AppConfig::default()
        };
        assert!(cfg.validate().is_err());
        let safe = AppConfig {
            server_args: vec!["--min-p".into(), "0.05".into()],
            ..cfg
        };
        let args = build_args(&safe, "token");
        assert_eq!(
            args.iter()
                .filter(|arg| arg.as_str() == "--ctx-size")
                .count(),
            1
        );
        assert!(args.windows(2).any(|pair| pair == ["--ctx-size", "8192"]));
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
            "model.gguf".to_string(),
            "mmproj.gguf".to_string(),
        );
        assert_eq!(state.lifecycle, Lifecycle::Starting);
        assert!(state.child.is_some());
        assert_eq!(state.api_key, "token");
        assert_eq!(state.model, "model.gguf");
        assert_eq!(state.mmproj, "mmproj.gguf");
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
            "model.gguf".to_string(),
            String::new(),
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
