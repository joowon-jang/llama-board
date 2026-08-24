// src-tauri/src/bench.rs
use serde::Serialize;
use std::process::Command;
use crate::config::AppConfig;
use crate::runtime;

#[derive(Serialize, Clone, Debug)]
pub struct BenchRow {
    pub test: String,
    pub size: String,
    pub batch: String,
    pub tps: f64,
}

/// Resolve llama-bench.exe: active managed runtime first, then PATH/WinGet.
pub fn bench_bin(cfg: &AppConfig) -> String {
    if !cfg.active_backend.is_empty() && !cfg.active_build.is_empty() {
        let p = runtime::bench_bin_for(&cfg.active_backend, &cfg.active_build);
        if p.exists() { return p.to_string_lossy().to_string(); }
    }
    which::which("llama-bench")
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| {
            let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
            format!("{local}\\Microsoft\\WinGet\\Packages\\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\\llama-bench.exe")
        })
}

fn parse(text: &str) -> Vec<BenchRow> {
    if text.lines().next().is_some_and(|line| line.starts_with("build_commit,")) {
        return parse_llama_csv(text);
    }
    parse_legacy(text)
}

fn parse_llama_csv(text: &str) -> Vec<BenchRow> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for record in reader.records().flatten() {
        let n_batch = record.get(9).and_then(|v| v.parse::<u32>().ok());
        let n_prompt = record.get(32).and_then(|v| v.parse::<u32>().ok());
        let n_gen = record.get(33).and_then(|v| v.parse::<u32>().ok());
        let tps = record.get(38).and_then(|v| v.parse::<f64>().ok());
        let (Some(batch), Some(prompt), Some(generation), Some(tps)) = (n_batch, n_prompt, n_gen, tps) else {
            continue;
        };
        if prompt == 0 && generation == 0 {
            continue;
        }
        let (test, size) = match (prompt > 0, generation > 0) {
            (true, true) => ("prompt+generation", format!("{prompt}+{generation}")),
            (true, false) => ("prompt", prompt.to_string()),
            (false, true) => ("generation", generation.to_string()),
            (false, false) => continue,
        };
        rows.push(BenchRow {
            test: test.to_string(),
            size,
            batch: batch.to_string(),
            tps,
        });
    }
    rows
}

fn parse_legacy(text: &str) -> Vec<BenchRow> {
    let mut rows = Vec::new();
    for line in text.lines() {
        // Legacy llama-bench output: tolerate tab-separated or simple CSV rows.
        let line = line.replace(',', "\t");
        let p: Vec<&str> = line
            .split('\t')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        if p.len() >= 4 {
            if let Ok(t) = p[3].parse::<f64>() {
                rows.push(BenchRow {
                    test: p[0].to_string(),
                    size: p[1].to_string(),
                    batch: p[2].to_string(),
                    tps: t,
                });
            }
        }
    }
    rows
}

/// v0.1: runs to completion (bench_cancel is a no-op — see §0.6 #4).
/// Caller should wrap in `tokio::task::spawn_blocking` so the UI thread is not blocked.
pub fn run(cfg: &AppConfig) -> Result<Vec<BenchRow>, String> {
    let bin = bench_bin(cfg);
    let iters = cfg.iters.max(1);
    let out = Command::new(&bin)
        .args([
            "--model", &cfg.active_model,
            "--n-gpu-layers", &cfg.ngl.to_string(),
            "--repetitions", &iters.to_string(),
            "--output", "csv",
        ])
        .output()
        .map_err(|e| format!("failed to run {bin}: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let rows = parse(&text);
    if rows.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("no benchmark rows parsed. stderr: {}", stderr.trim()));
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_llama_bench_csv() {
        let mut fields = vec!["0"; 40];
        fields[9] = "2048";   // n_batch
        fields[32] = "512";   // n_prompt
        fields[33] = "0";     // n_gen
        fields[38] = "664.56"; // avg_ts
        let header = "build_commit,build_number,cpu_info,gpu_info,backends,model_filename,model_type,model_size,model_n_params,n_batch,n_ubatch,n_threads,cpu_mask,cpu_strict,poll,type_k,type_v,n_gpu_layers,n_cpu_moe,split_mode,main_gpu,no_kv_offload,flash_attn,devices,tensor_split,tensor_buft_overrides,load_mode,embeddings,no_op_offload,no_host,fit_target,fit_min_ctx,n_prompt,n_gen,n_depth,test_time,avg_ns,stddev_ns,avg_ts,stddev_ts";
        let text = format!("{header}\n{}\n", fields.join(","));
        let rows = parse(&text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].test, "prompt");
        assert_eq!(rows[0].size, "512");
        assert_eq!(rows[0].batch, "2048");
        assert!((rows[0].tps - 664.56).abs() < 0.001);
    }
}
