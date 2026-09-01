// src-tauri/src/bench.rs
use crate::config::{AppConfig, APP_MANAGED_SERVER_ARGS};
use crate::runtime;
use serde::Serialize;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

const MAX_BENCH_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct BenchRow {
    pub test: String,
    pub size: String,
    pub batch: String,
    pub tps: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct BenchResult {
    pub rows: Vec<BenchRow>,
    pub args: Vec<String>,
}

pub fn bench_bin(cfg: &AppConfig) -> Result<String, String> {
    if !cfg.active_backend.is_empty() || !cfg.active_build.is_empty() {
        if cfg.active_backend.is_empty() || cfg.active_build.is_empty() {
            return Err("runtime backend and build must be selected together".into());
        }
        let path = runtime::bench_bin_for(&cfg.active_backend, &cfg.active_build)?;
        if path.is_file() {
            return Ok(path.to_string_lossy().into_owned());
        }
        return Err(format!(
            "managed runtime is missing llama-bench: {}",
            path.display()
        ));
    }
    if let Ok(path) = which::which(runtime::bench_executable_name()) {
        return Ok(path.to_string_lossy().into_owned());
    }
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let fallback =
        runtime::system_server_fallback(&local).with_file_name(runtime::bench_executable_name());
    if fallback.is_file() {
        return Ok(fallback.to_string_lossy().into_owned());
    }
    Err("llama-bench was not found on PATH or in the WinGet package directory".into())
}

fn parse(text: &str) -> Vec<BenchRow> {
    if text
        .lines()
        .next()
        .is_some_and(|line| line.split(',').any(|field| field.trim() == "build_commit"))
    {
        return parse_llama_csv(text);
    }
    parse_legacy(text)
}

fn parse_llama_csv(text: &str) -> Vec<BenchRow> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(text.as_bytes());
    let Ok(headers) = reader.headers().cloned() else {
        return Vec::new();
    };
    let index = |name: &str| headers.iter().position(|header| header == name);
    let Some(batch_index) = index("n_batch") else {
        return Vec::new();
    };
    let Some(prompt_index) = index("n_prompt") else {
        return Vec::new();
    };
    let Some(generation_index) = index("n_gen") else {
        return Vec::new();
    };
    let Some(tps_index) = index("avg_ts") else {
        return Vec::new();
    };

    let mut rows = Vec::new();
    for record in reader.records().flatten() {
        let batch = record
            .get(batch_index)
            .and_then(|value| value.parse::<u32>().ok());
        let prompt = record
            .get(prompt_index)
            .and_then(|value| value.parse::<u32>().ok());
        let generation = record
            .get(generation_index)
            .and_then(|value| value.parse::<u32>().ok());
        let tps = record
            .get(tps_index)
            .and_then(|value| value.parse::<f64>().ok());
        let (Some(batch), Some(prompt), Some(generation), Some(tps)) =
            (batch, prompt, generation, tps)
        else {
            continue;
        };
        if prompt == 0 && generation == 0 || !tps.is_finite() {
            continue;
        }
        let (test, size) = match (prompt > 0, generation > 0) {
            (true, true) => ("prompt+generation", format!("{prompt}+{generation}")),
            (true, false) => ("prompt", prompt.to_string()),
            (false, true) => ("generation", generation.to_string()),
            (false, false) => continue,
        };
        rows.push(BenchRow {
            test: test.into(),
            size,
            batch: batch.to_string(),
            tps,
        });
    }
    rows
}

fn parse_legacy(text: &str) -> Vec<BenchRow> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line
                .split([',', '\t'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect();
            if fields.len() < 4 {
                return None;
            }
            let tps = fields[3].parse::<f64>().ok()?;
            tps.is_finite().then(|| BenchRow {
                test: fields[0].into(),
                size: fields[1].into(),
                batch: fields[2].into(),
                tps,
            })
        })
        .collect()
}

pub fn terminate_pid(pid: u32) {
    #[cfg(windows)]
    {
        let pid = pid.to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

fn terminate(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let killed_tree = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
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

fn join_pipe(
    handle: &mut Option<thread::JoinHandle<std::io::Result<Vec<u8>>>>,
) -> Result<Vec<u8>, String> {
    handle
        .take()
        .ok_or_else(|| "benchmark output reader was already joined".to_string())?
        .join()
        .map_err(|_| "benchmark output reader panicked".to_string())?
        .map_err(|error| format!("failed to read benchmark output: {error}"))
}

fn bounded_output<R: std::io::Read>(reader: R) -> std::io::Result<Vec<u8>> {
    let mut limited = reader.take(MAX_BENCH_OUTPUT_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes)?;
    bytes.truncate(MAX_BENCH_OUTPUT_BYTES);
    Ok(bytes)
}

fn run_process(
    bin: &str,
    args: &[String],
    environment: &[(std::ffi::OsString, std::ffi::OsString)],
    cancel: Arc<AtomicBool>,
    timeout: Duration,
    active_pid: Option<Arc<Mutex<Option<u32>>>>,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>), String> {
    let mut command = Command::new(bin);
    command
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)));
    let mut child = command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run {bin}: {error}"))?;
    if let Some(active_pid) = &active_pid {
        if let Ok(mut pid) = active_pid.lock() {
            *pid = Some(child.id());
        }
    }
    let _pid_guard = ActivePidGuard::new(active_pid.clone());
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate(&mut child);
            clear_active_pid(&active_pid);
            return Err("benchmark stdout pipe was not available".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate(&mut child);
            clear_active_pid(&active_pid);
            return Err("benchmark stderr pipe was not available".into());
        }
    };
    let mut stdout_reader = Some(thread::spawn(move || bounded_output(stdout)));
    let mut stderr_reader = Some(thread::spawn(move || bounded_output(stderr)));

    let deadline = Instant::now() + timeout;
    let status = loop {
        if cancel.load(Ordering::Acquire) {
            terminate(&mut child);
            let _ = join_pipe(&mut stdout_reader);
            let _ = join_pipe(&mut stderr_reader);
            clear_active_pid(&active_pid);
            return Err("benchmark cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                terminate(&mut child);
                let _ = join_pipe(&mut stdout_reader);
                let _ = join_pipe(&mut stderr_reader);
                clear_active_pid(&active_pid);
                return Err(format!("failed to inspect benchmark process: {error}"));
            }
        }
        if Instant::now() >= deadline {
            terminate(&mut child);
            let _ = join_pipe(&mut stdout_reader);
            let _ = join_pipe(&mut stderr_reader);
            clear_active_pid(&active_pid);
            return Err(format!(
                "benchmark timed out after {} seconds",
                timeout.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(100));
    };

    let stdout = join_pipe(&mut stdout_reader)?;
    let stderr = join_pipe(&mut stderr_reader)?;
    clear_active_pid(&active_pid);
    Ok((status, stdout, stderr))
}

fn clear_active_pid(active_pid: &Option<Arc<Mutex<Option<u32>>>>) {
    if let Some(active_pid) = active_pid {
        if let Ok(mut pid) = active_pid.lock() {
            *pid = None;
        }
    }
}

struct ActivePidGuard {
    active_pid: Option<Arc<Mutex<Option<u32>>>>,
}

impl ActivePidGuard {
    fn new(active_pid: Option<Arc<Mutex<Option<u32>>>>) -> Self {
        Self { active_pid }
    }
}

impl Drop for ActivePidGuard {
    fn drop(&mut self) {
        clear_active_pid(&self.active_pid);
    }
}

fn option_name(value: &str) -> &str {
    value.split_once('=').map_or(value, |(name, _)| name).trim()
}

fn supports_bench_option(value: &str) -> bool {
    matches!(
        option_name(value),
        "--batch-size"
            | "--ubatch-size"
            | "--threads"
            | "-t"
            | "--n-cpu-moe"
            | "--flash-attn"
            | "--device"
            | "--split-mode"
            | "--main-gpu"
            | "--tensor-split"
            | "--no-kv-offload"
            | "--no-op-offload"
            | "--no-host"
            | "--numa"
            | "--mmap"
            | "--no-mmap"
            | "--direct-io"
            | "--no-warmup"
            | "--progress"
            | "--cache-type-k"
            | "--cache-type-v"
            | "--mlock"
    )
}

pub fn build_args(cfg: &AppConfig) -> Vec<String> {
    let mut args = vec![
        "--model".into(),
        cfg.active_model.clone(),
        "--n-gpu-layers".into(),
        cfg.ngl.to_string(),
        "--batch-size".into(),
        cfg.batch_size.to_string(),
        "--ubatch-size".into(),
        cfg.ubatch_size.to_string(),
        "--cache-type-k".into(),
        cfg.cache_type_k.clone(),
        "--cache-type-v".into(),
        cfg.cache_type_v.clone(),
        "--repetitions".into(),
        cfg.iters.max(1).to_string(),
        "--output".into(),
        "csv".into(),
    ];
    if cfg.threads > 0 {
        args.extend(["--threads".into(), cfg.threads.to_string()]);
    }
    if cfg.n_cpu_moe > 0 {
        args.extend(["--n-cpu-moe".into(), cfg.n_cpu_moe.to_string()]);
    }
    if cfg.flash_attn != "auto" {
        args.extend(["--flash-attn".into(), cfg.flash_attn.clone()]);
    }
    let mut seen = std::collections::HashSet::new();
    for token in [
        "--model",
        "--n-gpu-layers",
        "--batch-size",
        "--ubatch-size",
        "--cache-type-k",
        "--cache-type-v",
        "--repetitions",
        "--output",
        "--threads",
        "--n-cpu-moe",
        "--flash-attn",
    ] {
        seen.insert(token);
    }
    let mut index = 0;
    while index < cfg.server_args.len() {
        let token = &cfg.server_args[index];
        let name = option_name(token);
        if APP_MANAGED_SERVER_ARGS.contains(&name) {
            if app_managed_option_consumes_next(&cfg.server_args, index) {
                index += 1;
            }
            index += 1;
            continue;
        }
        if !supports_bench_option(token) || seen.contains(name) {
            index += 1;
            continue;
        }
        args.push(token.clone());
        seen.insert(name);
        if !token.contains('=')
            && cfg
                .server_args
                .get(index + 1)
                .is_some_and(|value| !value.starts_with('-'))
        {
            args.push(cfg.server_args[index + 1].clone());
            index += 1;
        }
        index += 1;
    }
    args
}

fn app_managed_option_consumes_next(args: &[String], index: usize) -> bool {
    let Some(argument) = args.get(index) else {
        return false;
    };
    if argument.contains('=') {
        return false;
    }
    if matches!(
        option_name(argument),
        "--no-api-key"
            | "--mmproj-auto"
            | "--no-mmproj"
            | "--no-mmproj-auto"
            | "--no-reasoning-preserve"
    ) {
        return false;
    }
    args.get(index + 1)
        .is_some_and(|value| !value.starts_with('-') || value.parse::<f64>().is_ok())
}

pub fn run(
    cfg: &AppConfig,
    cancel: Arc<AtomicBool>,
    active_pid: Option<Arc<Mutex<Option<u32>>>>,
) -> Result<BenchResult, String> {
    let bin = bench_bin(cfg)?;
    let args = build_args(cfg);
    let environment = if cfg.active_backend.is_empty() && cfg.active_build.is_empty() {
        runtime::child_environment()
    } else {
        runtime::child_environment_for_runtime(&cfg.active_backend, &cfg.active_build)?
    };
    let (status, stdout, stderr) = run_process(
        &bin,
        &args,
        &environment,
        cancel,
        Duration::from_secs(30 * 60),
        active_pid,
    )?;
    let stdout = String::from_utf8_lossy(&stdout);
    let stderr = String::from_utf8_lossy(&stderr);
    if !status.success() {
        return Err(format!(
            "llama-bench exited with {status}: {}",
            stderr.trim()
        ));
    }
    let rows = parse(&stdout);
    if rows.is_empty() {
        return Err(format!(
            "no benchmark rows parsed. stderr: {}",
            stderr.trim()
        ));
    }
    Ok(BenchResult { rows, args })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_llama_bench_csv_uses_header_names() {
        let header = "n_prompt,build_commit,avg_ts,n_gen,n_batch";
        let text = format!("{header}\n512,abc,664.56,0,2048\n");
        let rows = parse(&text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].test, "prompt");
        assert_eq!(rows[0].size, "512");
        assert_eq!(rows[0].batch, "2048");
        assert!((rows[0].tps - 664.56).abs() < 0.001);
    }

    #[test]
    fn malformed_benchmark_rows_are_skipped() {
        let text = "test,size,batch,tps\nfoo,1,2,not-a-number\nbar,4,8,3.5\n";
        let rows = parse(text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].test, "bar");
    }

    #[test]
    fn active_pid_guard_clears_the_slot_on_drop() {
        let active_pid = Arc::new(Mutex::new(Some(1234)));
        {
            let _guard = ActivePidGuard::new(Some(active_pid.clone()));
        }
        assert_eq!(*active_pid.lock().unwrap(), None);
    }

    #[test]
    fn benchmark_args_reflect_chat_runtime_and_skip_server_only_flags() {
        let cfg = AppConfig {
            active_model: "model.gguf".into(),
            ngl: 42,
            batch_size: 1024,
            ubatch_size: 256,
            cache_type_k: "q8_0".into(),
            cache_type_v: "q8_0".into(),
            flash_attn: "on".into(),
            threads: 8,
            server_args: vec!["--parallel".into(), "1".into(), "--jinja".into()],
            ..AppConfig::default()
        };
        let args = build_args(&cfg);
        assert!(args.windows(2).any(|pair| pair == ["--n-gpu-layers", "42"]));
        assert!(args.windows(2).any(|pair| pair == ["--threads", "8"]));
        assert!(args.windows(2).any(|pair| pair == ["--flash-attn", "on"]));
        assert!(args.windows(2).any(|pair| pair == ["--batch-size", "1024"]));
        assert!(args.windows(2).any(|pair| pair == ["--ubatch-size", "256"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--cache-type-k", "q8_0"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--cache-type-v", "q8_0"]));
        assert!(!args
            .iter()
            .any(|arg| arg == "--parallel" || arg == "--jinja"));
    }

    #[test]
    fn process_drains_large_stdout_without_deadlocking() {
        let (bin, args) = if cfg!(windows) {
            (
                "cmd",
                vec![
                    "/C".to_string(),
                    "for /L %i in (1,1,50000) do @echo benchmark-%i".to_string(),
                ],
            )
        } else {
            (
                "sh",
                vec![
                    "-c".to_string(),
                    "yes benchmark | head -c 200000".to_string(),
                ],
            )
        };
        let (status, stdout, _stderr) = run_process(
            bin,
            &args,
            &runtime::child_environment(),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(10),
            None,
        )
        .expect("flooding child should complete");
        assert!(status.success());
        assert!(stdout.len() > 100_000);
    }

    #[test]
    fn process_cancel_terminates_sleeping_child() {
        let (bin, args) = if cfg!(windows) {
            (
                "cmd",
                vec!["/C".to_string(), "ping 127.0.0.1 -n 6 >NUL".to_string()],
            )
        } else {
            ("sh", vec!["-c".to_string(), "sleep 5".to_string()])
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let child_cancel = cancel.clone();
        let environment = runtime::child_environment();
        let handle = std::thread::spawn(move || {
            run_process(
                bin,
                &args,
                &environment,
                child_cancel,
                Duration::from_secs(10),
                None,
            )
        });
        std::thread::sleep(Duration::from_millis(200));
        cancel.store(true, Ordering::Release);
        let result = handle.join().expect("benchmark worker should join");
        assert_eq!(result, Err("benchmark cancelled".to_string()));
    }

    #[test]
    fn benchmark_pipe_reader_caps_untrusted_output() {
        let input = vec![b'x'; MAX_BENCH_OUTPUT_BYTES + 128];
        let output = bounded_output(std::io::Cursor::new(input)).expect("reader should succeed");
        assert_eq!(output.len(), MAX_BENCH_OUTPUT_BYTES);
    }
}
