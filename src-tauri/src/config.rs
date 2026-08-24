// src-tauri/src/config.rs
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AppConfig {
    pub models_dir: String,
    pub port: u16,
    pub ngl: u32,
    pub ctx_size: u32,
    pub flash_attn: String,
    pub n_cpu_moe: u32,
    pub threads: u32,
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: u32,
    pub active_model: String,
    // ---- runtime selection ("" = use WinGet/PATH fallback) ----
    pub active_backend: String,   // "rocm" | "vulkan" | "cpu" | "cuda" | "sycl" | ""
    pub active_build: String,     // "b10595" | "b10588" | ... | ""
    // ---- benchmark ----
    #[serde(default = "default_iters")] pub iters: u32,
}
fn default_iters() -> u32 { 5 }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            models_dir: {
                let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
                format!("{home}/.lmstudio/models")
            },
            port: 8080,
            ngl: 99,
            ctx_size: 4096,
            flash_attn: "auto".into(),
            n_cpu_moe: 0,
            threads: 0,
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            active_model: String::new(),
            active_backend: String::new(),
            active_build: String::new(),
            iters: 5,
        }
    }
}

impl AppConfig {
    pub fn normalize(&mut self) {
        self.ngl = self.ngl.min(128);
        self.ctx_size = self.ctx_size.clamp(512, 131_072);
        self.n_cpu_moe = self.n_cpu_moe.min(64);
        self.threads = self.threads.min(64);
        self.temperature = if self.temperature.is_finite() { self.temperature.clamp(0.0, 2.0) } else { 0.7 };
        self.top_p = if self.top_p.is_finite() { self.top_p.clamp(0.01, 1.0) } else { 0.9 };
        self.top_k = self.top_k.clamp(1, 200);
        self.iters = self.iters.clamp(1, 100);
        if !matches!(self.flash_attn.as_str(), "auto" | "on" | "off") {
            self.flash_attn = "auto".into();
        }
    }
}

pub fn config_path() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(appdata).join("llama-board").join("config.json")
}

pub fn load() -> AppConfig {
    let mut cfg: AppConfig = fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    cfg.normalize();
    cfg
}

pub fn save(cfg: &AppConfig) -> Result<(), String> {
    let p = config_path();
    if let Some(parent) = p.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let mut safe = cfg.clone();
    safe.normalize();
    fs::write(&p, serde_json::to_string_pretty(&safe).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_clamps_tuning_ranges() {
        let mut cfg = AppConfig::default();
        cfg.ngl = 999;
        cfg.ctx_size = 128;
        cfg.n_cpu_moe = 99;
        cfg.threads = 99;
        cfg.temperature = 3.0;
        cfg.top_p = -1.0;
        cfg.top_k = 9999;
        cfg.flash_attn = "invalid".into();
        cfg.normalize();
        assert_eq!(cfg.ngl, 128);
        assert_eq!(cfg.ctx_size, 512);
        assert_eq!(cfg.n_cpu_moe, 64);
        assert_eq!(cfg.threads, 64);
        assert_eq!(cfg.temperature, 2.0);
        assert_eq!(cfg.top_p, 0.01);
        assert_eq!(cfg.top_k, 200);
        assert_eq!(cfg.flash_attn, "auto");
    }
}
