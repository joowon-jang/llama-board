// src-tauri/src/bench.rs
use crate::config::AppConfig;
use crate::runtime;
use serde::Serialize;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug)]
pub struct BenchRow {
    pub test: String,
    pub size: String,
    pub batch: String,
    pub tps: f64,
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

fn run_process(
    bin: &str,
    args: &[String],
    cancel: Arc<AtomicBool>,
    timeout: Duration,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>), String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run {bin}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "benchmark stdout pipe was not available".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "benchmark stderr pipe was not available".to_string())?;
    let mut stdout_reader = Some(thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut reader, &mut bytes).map(|_| bytes)
    }));
    let mut stderr_reader = Some(thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut reader, &mut bytes).map(|_| bytes)
    }));

    let deadline = Instant::now() + timeout;
    let status = loop {
        if cancel.load(Ordering::Acquire) {
            terminate(&mut child);
            let _ = join_pipe(&mut stdout_reader);
            let _ = join_pipe(&mut stderr_reader);
            return Err("benchmark cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                terminate(&mut child);
                let _ = join_pipe(&mut stdout_reader);
                let _ = join_pipe(&mut stderr_reader);
                return Err(format!("failed to inspect benchmark process: {error}"));
            }
        }
        if Instant::now() >= deadline {
            terminate(&mut child);
            let _ = join_pipe(&mut stdout_reader);
            let _ = join_pipe(&mut stderr_reader);
            return Err(format!(
                "benchmark timed out after {} seconds",
                timeout.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(100));
    };

    let stdout = join_pipe(&mut stdout_reader)?;
    let stderr = join_pipe(&mut stderr_reader)?;
    Ok((status, stdout, stderr))
}

pub fn run(cfg: &AppConfig, cancel: Arc<AtomicBool>) -> Result<Vec<BenchRow>, String> {
    let bin = bench_bin(cfg)?;
    let iters = cfg.iters.max(1);
    let args = vec![
        "--model".into(),
        cfg.active_model.clone(),
        "--n-gpu-layers".into(),
        cfg.ngl.to_string(),
        "--repetitions".into(),
        iters.to_string(),
        "--output".into(),
        "csv".into(),
    ];
    let (status, stdout, stderr) = run_process(&bin, &args, cancel, Duration::from_secs(30 * 60))?;
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
    Ok(rows)
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
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(10),
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
        let handle = std::thread::spawn(move || {
            run_process(bin, &args, child_cancel, Duration::from_secs(10))
        });
        std::thread::sleep(Duration::from_millis(200));
        cancel.store(true, Ordering::Release);
        let result = handle.join().expect("benchmark worker should join");
        assert_eq!(result, Err("benchmark cancelled".to_string()));
    }
}
