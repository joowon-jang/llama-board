// src-tauri/src/config.rs
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const CURRENT_CONFIG_VERSION: u32 = 8;
const MAX_SERVER_ARGS: usize = 512;
const MAX_SERVER_ARG_LENGTH: usize = 32_768;
const MAX_SERVER_ARGS_BYTES: usize = 131_072;
const MAX_CHAT_OPTIONS_BYTES: usize = 262_144;
const CACHE_TYPES: &[&str] = &["f16", "f32", "bf16", "q8_0", "q5_0", "q5_1", "q4_0", "q4_1"];

// Keep this list in sync with tuningValidation.ts.  These are all spellings
// of options whose value is owned by AppConfig or by the server lifecycle;
// accepting an alias here would let raw server_args silently win over a
// dedicated control.  The canonical names are used in the error text where
// useful, while validation accepts every upstream spelling.
pub(crate) const APP_MANAGED_SERVER_ARGS: &[&str] = &[
    "--model",
    "-m",
    "--host",
    "--port",
    "-p",
    "--api-key",
    "--api-key-file",
    "--no-api-key",
    "-mm",
    "--mmproj",
    "--mmproj-url",
    "--mmproj-auto",
    "--no-mmproj",
    "--no-mmproj-auto",
    "--n-gpu-layers",
    "--gpu-layers",
    "-ngl",
    "--ctx-size",
    "-c",
    "--batch-size",
    "-b",
    "--ubatch-size",
    "-ub",
    "--keep",
    "--cache-type-k",
    "-ctk",
    "--cache-type-v",
    "-ctv",
    "--flash-attn",
    "-fa",
    "--n-cpu-moe",
    "-ncmoe",
    "--threads",
    "-t",
    "--parallel",
    "-np",
    "--timeout",
    "-to",
    "--sleep-idle-seconds",
    "--lora",
    "--lora-scaled",
    "--spec-type",
    "--spec-draft-n-max",
    "--spec-draft-n-min",
    "--spec-draft-p-min",
    "--draft-p-min",
    "--spec-draft-p-split",
    "--draft-p-split",
    "--spec-draft-ngl",
    "--gpu-layers-draft",
    "--n-gpu-layers-draft",
    "--spec-draft-device",
    "-devd",
    "--device-draft",
    "--spec-draft-model",
    "-md",
    "--model-draft",
    "--reasoning",
    "-rea",
    "--reasoning-format",
    "--reasoning-effort",
    "--reasoning-budget",
    "--reasoning-budget-message",
    "--reasoning-preserve",
    "--no-reasoning-preserve",
];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LoraAdapterConfig {
    pub path: String,
    #[serde(default = "default_lora_scale")]
    pub scale: f32,
    #[serde(default = "default_lora_enabled")]
    pub enabled: bool,
}

fn default_lora_scale() -> f32 {
    1.0
}

fn default_lora_enabled() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AppConfig {
    #[serde(default = "default_config_version")]
    pub config_version: u32,
    pub models_dir: String,
    pub port: u16,
    pub ngl: u32,
    pub ctx_size: u32,
    #[serde(default = "default_batch_size")]
    pub batch_size: u32,
    #[serde(default = "default_ubatch_size")]
    pub ubatch_size: u32,
    #[serde(default = "default_keep")]
    pub keep: u32,
    #[serde(default = "default_cache_type")]
    pub cache_type_k: String,
    #[serde(default = "default_cache_type")]
    pub cache_type_v: String,
    pub flash_attn: String,
    pub n_cpu_moe: u32,
    pub threads: u32,
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: u32,
    #[serde(default)]
    pub spec_type: String,
    #[serde(default)]
    pub spec_draft_n_max: u32,
    #[serde(default)]
    pub spec_draft_n_min: u32,
    #[serde(default)]
    pub spec_draft_p_min: f32,
    #[serde(default)]
    pub spec_draft_p_split: f32,
    #[serde(default)]
    pub spec_draft_ngl: String,
    #[serde(default)]
    pub spec_draft_device: String,
    #[serde(default)]
    pub spec_draft_model: String,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub reasoning_format: String,
    #[serde(default)]
    pub reasoning_effort: String,
    #[serde(default)]
    pub reasoning_budget: i32,
    #[serde(default)]
    pub reasoning_budget_message: String,
    #[serde(default)]
    pub reasoning_preserve: String,
    #[serde(default = "default_server_args")]
    pub server_args: Vec<String>,
    #[serde(default = "default_chat_options")]
    pub chat_options: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub mmproj: String,
    pub active_model: String,
    pub active_backend: String,
    pub active_build: String,
    #[serde(default = "default_iters")]
    pub iters: u32,
    #[serde(default)]
    pub parallel: u32,
    #[serde(default = "default_request_timeout_seconds")]
    pub request_timeout_seconds: u32,
    #[serde(default = "default_sleep_idle_seconds")]
    pub sleep_idle_seconds: i64,
    #[serde(default)]
    pub lora_adapters: Vec<LoraAdapterConfig>,
}

fn default_iters() -> u32 {
    5
}

fn default_request_timeout_seconds() -> u32 {
    3600
}

fn default_sleep_idle_seconds() -> i64 {
    -1
}

fn default_batch_size() -> u32 {
    2048
}

fn default_ubatch_size() -> u32 {
    512
}

fn default_keep() -> u32 {
    0
}

fn default_cache_type() -> String {
    "f16".into()
}

fn default_config_version() -> u32 {
    0
}

fn default_server_args() -> Vec<String> {
    Vec::new()
}

fn default_chat_options() -> serde_json::Map<String, serde_json::Value> {
    serde_json::Map::new()
}

fn home_dir() -> PathBuf {
    PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".into()),
    )
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            config_version: CURRENT_CONFIG_VERSION,
            models_dir: home_dir()
                .join(".lmstudio")
                .join("models")
                .to_string_lossy()
                .into_owned(),
            port: 8080,
            ngl: 0,
            ctx_size: 4096,
            batch_size: default_batch_size(),
            ubatch_size: default_ubatch_size(),
            keep: default_keep(),
            cache_type_k: default_cache_type(),
            cache_type_v: default_cache_type(),
            flash_attn: "auto".into(),
            n_cpu_moe: 0,
            threads: 0,
            temperature: 0.8,
            top_p: 0.95,
            top_k: 40,
            spec_type: "none".into(),
            spec_draft_n_max: 3,
            spec_draft_n_min: 0,
            spec_draft_p_min: 0.0,
            spec_draft_p_split: 0.1,
            spec_draft_ngl: "auto".into(),
            spec_draft_device: String::new(),
            spec_draft_model: String::new(),
            reasoning: "auto".into(),
            reasoning_format: "auto".into(),
            reasoning_effort: "default".into(),
            reasoning_budget: -1,
            reasoning_budget_message: String::new(),
            reasoning_preserve: "auto".into(),
            server_args: default_server_args(),
            chat_options: default_chat_options(),
            mmproj: String::new(),
            active_model: String::new(),
            active_backend: String::new(),
            active_build: String::new(),
            iters: default_iters(),
            parallel: 0,
            request_timeout_seconds: default_request_timeout_seconds(),
            sleep_idle_seconds: default_sleep_idle_seconds(),
            lora_adapters: Vec::new(),
        }
    }
}

impl AppConfig {
    pub fn normalize(&mut self) {
        if self.port == 0 {
            self.port = 8080;
        }
        self.ngl = self.ngl.min(128);
        self.ctx_size = self.ctx_size.clamp(512, 131_072);
        self.batch_size = self.batch_size.clamp(1, 131_072);
        self.ubatch_size = self.ubatch_size.clamp(1, self.batch_size);
        self.keep = self.keep.min(131_072);
        if !CACHE_TYPES.contains(&self.cache_type_k.as_str()) {
            self.cache_type_k = default_cache_type();
        }
        if !CACHE_TYPES.contains(&self.cache_type_v.as_str()) {
            self.cache_type_v = default_cache_type();
        }
        self.n_cpu_moe = self.n_cpu_moe.min(64);
        self.threads = self.threads.min(64);
        self.temperature = if self.temperature.is_finite() {
            self.temperature.clamp(0.0, 2.0)
        } else {
            1.0
        };
        self.top_p = if self.top_p.is_finite() {
            self.top_p.clamp(0.01, 1.0)
        } else {
            0.95
        };
        self.top_k = self.top_k.clamp(1, 200);
        self.spec_type = if self.spec_type.trim().is_empty() {
            "none".into()
        } else {
            self.spec_type.trim().into()
        };
        self.spec_draft_n_max = self.spec_draft_n_max.min(64);
        self.spec_draft_n_min = self.spec_draft_n_min.min(64);
        self.spec_draft_p_min = if self.spec_draft_p_min.is_finite() {
            self.spec_draft_p_min.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.spec_draft_p_split = if self.spec_draft_p_split.is_finite() {
            self.spec_draft_p_split.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.spec_draft_ngl = match self.spec_draft_ngl.trim() {
            "" => "auto".into(),
            value => value.into(),
        };
        self.spec_draft_device = self.spec_draft_device.trim().into();
        self.spec_draft_model = self.spec_draft_model.trim().into();
        if !matches!(self.reasoning.as_str(), "auto" | "on" | "off") {
            self.reasoning = "auto".into();
        }
        if !matches!(
            self.reasoning_format.as_str(),
            "auto" | "none" | "deepseek" | "deepseek-legacy"
        ) {
            self.reasoning_format = "auto".into();
        }
        if !matches!(
            self.reasoning_effort.as_str(),
            "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        ) {
            self.reasoning_effort = "default".into();
        }
        self.reasoning_budget = self.reasoning_budget.clamp(-1, 1_048_576);
        if !matches!(self.reasoning_preserve.as_str(), "auto" | "on" | "off") {
            self.reasoning_preserve = "auto".into();
        }
        self.iters = self.iters.clamp(1, 100);
        self.parallel = self.parallel.min(128);
        self.request_timeout_seconds = self.request_timeout_seconds.clamp(1, 86_400);
        self.sleep_idle_seconds = self.sleep_idle_seconds.clamp(-1, 604_800);
        for adapter in &mut self.lora_adapters {
            adapter.path = adapter.path.trim().into();
            adapter.scale = if adapter.scale.is_finite() {
                adapter.scale.clamp(0.0, 4.0)
            } else {
                1.0
            };
        }
        self.lora_adapters
            .retain(|adapter| !adapter.path.is_empty());
        self.lora_adapters.truncate(32);
        if !matches!(self.flash_attn.as_str(), "auto" | "on" | "off") {
            self.flash_attn = "auto".into();
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.config_version > CURRENT_CONFIG_VERSION {
            return Err(format!(
                "config schema {} is newer than this app supports (current {})",
                self.config_version, CURRENT_CONFIG_VERSION
            ));
        }
        if self.active_backend.is_empty() != self.active_build.is_empty() {
            return Err("active runtime backend and build must be selected together".into());
        }
        if self.models_dir.len() > 32_768 || self.active_model.len() > 32_768 {
            return Err("model paths are too long".into());
        }
        for adapter in &self.lora_adapters {
            if adapter.path.len() > 32_768 || adapter.path.contains('\0') {
                return Err("LoRA adapter path is invalid or too long".into());
            }
            if !adapter.path.to_ascii_lowercase().ends_with(".gguf") {
                return Err(format!(
                    "LoRA adapter must be a .gguf file: {}",
                    adapter.path
                ));
            }
            if !adapter.scale.is_finite() || !(0.0..=4.0).contains(&adapter.scale) {
                return Err(format!("LoRA adapter scale is invalid: {}", adapter.path));
            }
        }
        for (name, value) in [
            ("spec_type", &self.spec_type),
            ("spec_draft_ngl", &self.spec_draft_ngl),
            ("spec_draft_device", &self.spec_draft_device),
            ("spec_draft_model", &self.spec_draft_model),
            ("reasoning_budget_message", &self.reasoning_budget_message),
            ("mmproj", &self.mmproj),
        ] {
            if value.len() > 32_768 || value.contains('\0') {
                return Err(format!("{name} is invalid or too long"));
            }
        }
        if self.server_args.len() > MAX_SERVER_ARGS {
            return Err(format!(
                "too many advanced llama-server arguments (max {MAX_SERVER_ARGS})"
            ));
        }
        let mut server_args_bytes = 0_usize;
        for (index, argument) in self.server_args.iter().enumerate() {
            if argument.trim().is_empty() {
                return Err(format!(
                    "advanced llama-server argument {} is empty",
                    index + 1
                ));
            }
            if argument.len() > MAX_SERVER_ARG_LENGTH {
                return Err(format!(
                    "advanced llama-server argument {} is too long (max {MAX_SERVER_ARG_LENGTH} bytes)",
                    index + 1
                ));
            }
            server_args_bytes = server_args_bytes.saturating_add(argument.len());
            if server_args_bytes > MAX_SERVER_ARGS_BYTES {
                return Err(format!(
                    "advanced llama-server arguments are too large (max {MAX_SERVER_ARGS_BYTES} bytes)"
                ));
            }
            let name = argument
                .trim()
                .split_once('=')
                .map_or(argument.trim(), |(name, _)| name.trim());
            if APP_MANAGED_SERVER_ARGS.contains(&name) {
                return Err(format!(
                    "advanced llama-server argument {name} is app-managed and cannot be overridden"
                ));
            }
        }
        for key in ["model", "messages", "stream"] {
            if self.chat_options.contains_key(key) {
                return Err(format!("chat option {key} is reserved by the app"));
            }
        }
        let chat_options_bytes = serde_json::to_vec(&self.chat_options)
            .map_err(|error| format!("failed to serialize chat options: {error}"))?;
        if chat_options_bytes.len() > MAX_CHAT_OPTIONS_BYTES {
            return Err(format!(
                "advanced chat options are too large (max {MAX_CHAT_OPTIONS_BYTES} bytes)"
            ));
        }
        Ok(())
    }
}

fn migrate(cfg: AppConfig) -> Result<AppConfig, String> {
    migrate_with_presence(cfg, None)
}

fn migrate_value(value: serde_json::Value) -> Result<AppConfig, String> {
    let cfg: AppConfig = serde_json::from_value(value.clone())
        .map_err(|error| format!("invalid config value: {error}"))?;
    migrate_with_presence(cfg, Some(&value))
}

fn field_missing(value: Option<&serde_json::Value>, field: &str) -> bool {
    value.is_some_and(|value| value.get(field).is_none())
}

fn option_name(argument: &str) -> &str {
    argument
        .split_once('=')
        .map_or(argument, |(name, _)| name)
        .trim()
}

fn option_value(args: &[String], index: usize) -> Option<&str> {
    let argument = args.get(index)?;
    if let Some((_, value)) = argument.split_once('=') {
        return Some(value.trim());
    }
    let next = args.get(index + 1)?.trim();
    if !next.starts_with('-') || next.parse::<f64>().is_ok() {
        Some(next)
    } else {
        None
    }
}

fn option_consumes_next(args: &[String], index: usize) -> bool {
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
    option_value(args, index).is_some()
}

/// Move typed values out of legacy raw server arguments and remove all
/// app-managed spellings.  Versioned config files written before the typed
/// fields existed used the Qwen profile's `--batch-size`/`--parallel` style
/// arguments, so migration must preserve those values before validation starts
/// rejecting collisions.  Explicit JSON fields always win over legacy args.
fn migrate_server_args(cfg: &mut AppConfig, raw: Option<&serde_json::Value>) {
    let old_args = std::mem::take(&mut cfg.server_args);
    let mut cleaned = Vec::with_capacity(old_args.len());
    let mut index = 0;
    while index < old_args.len() {
        let argument = &old_args[index];
        let name = option_name(argument);
        if APP_MANAGED_SERVER_ARGS.contains(&name) {
            let value = option_value(&old_args, index);
            let infer = |field: &str| field_missing(raw, field);
            match name {
                "--n-gpu-layers" | "--gpu-layers" | "-ngl" if infer("ngl") => {
                    if let Some(value) = value.and_then(|value| value.parse::<u32>().ok()) {
                        cfg.ngl = value;
                    }
                }
                "--ctx-size" | "-c" if infer("ctx_size") => {
                    if let Some(value) = value.and_then(|value| value.parse::<u32>().ok()) {
                        cfg.ctx_size = value;
                    }
                }
                "--batch-size" | "-b" if infer("batch_size") => {
                    if let Some(value) = value.and_then(|value| value.parse::<u32>().ok()) {
                        cfg.batch_size = value;
                    }
                }
                "--ubatch-size" | "-ub" if infer("ubatch_size") => {
                    if let Some(value) = value.and_then(|value| value.parse::<u32>().ok()) {
                        cfg.ubatch_size = value;
                    }
                }
                "--keep" if infer("keep") => {
                    if let Some(value) = value.and_then(|value| value.parse::<u32>().ok()) {
                        cfg.keep = value;
                    }
                }
                "--cache-type-k" | "-ctk" if infer("cache_type_k") => {
                    if let Some(value) = value.filter(|value| CACHE_TYPES.contains(value)) {
                        cfg.cache_type_k = value.to_owned();
                    }
                }
                "--cache-type-v" | "-ctv" if infer("cache_type_v") => {
                    if let Some(value) = value.filter(|value| CACHE_TYPES.contains(value)) {
                        cfg.cache_type_v = value.to_owned();
                    }
                }
                "--n-cpu-moe" | "-ncmoe" if infer("n_cpu_moe") => {
                    if let Some(value) = value.and_then(|value| value.parse::<u32>().ok()) {
                        cfg.n_cpu_moe = value;
                    }
                }
                "--threads" | "-t" if infer("threads") => {
                    if let Some(value) = value.and_then(|value| value.parse::<u32>().ok()) {
                        cfg.threads = value;
                    }
                }
                "--parallel" | "-np" if infer("parallel") => {
                    if let Some(value) = value.and_then(|value| value.parse::<u32>().ok()) {
                        cfg.parallel = value;
                    }
                }
                "--timeout" | "-to" if infer("request_timeout_seconds") => {
                    if let Some(value) = value.and_then(|value| value.parse::<u32>().ok()) {
                        cfg.request_timeout_seconds = value;
                    }
                }
                "--sleep-idle-seconds" if infer("sleep_idle_seconds") => {
                    if let Some(value) = value.and_then(|value| value.parse::<i64>().ok()) {
                        cfg.sleep_idle_seconds = value;
                    }
                }
                _ => {}
            }
            if option_consumes_next(&old_args, index) {
                index += 1;
            }
        } else {
            cleaned.push(argument.clone());
        }
        index += 1;
    }
    cfg.server_args = cleaned;
}

fn migrate_with_presence(
    mut cfg: AppConfig,
    raw: Option<&serde_json::Value>,
) -> Result<AppConfig, String> {
    if cfg.config_version > CURRENT_CONFIG_VERSION {
        return Err(format!(
            "config schema {} is newer than this app supports (current {})",
            cfg.config_version, CURRENT_CONFIG_VERSION
        ));
    }
    if cfg.config_version < CURRENT_CONFIG_VERSION {
        // These fields were introduced in schema v4. Serde's type defaults
        // are zero/empty, so restore the documented llama.cpp defaults before
        // normalizing the migrated configuration.
        if field_missing(raw, "spec_draft_n_max") {
            cfg.spec_draft_n_max = 3;
        }
        if field_missing(raw, "spec_draft_p_split") {
            cfg.spec_draft_p_split = 0.1;
        }
        if field_missing(raw, "reasoning_budget") {
            cfg.reasoning_budget = -1;
        }
    }
    match cfg.config_version {
        0 => {
            // Version 0 did not carry the schema marker. Missing fields were
            // filled by serde defaults; repair the fields introduced later.
            if field_missing(raw, "flash_attn") {
                cfg.flash_attn = "auto".into();
            }
            if field_missing(raw, "iters") {
                cfg.iters = default_iters();
            }
        }
        1 => {
            // Version 1 used the same runtime fields but did not persist a
            // benchmark repetition count consistently.
            if field_missing(raw, "iters") {
                cfg.iters = default_iters();
            }
        }
        2..=7 => {}
        CURRENT_CONFIG_VERSION => {}
        _ => unreachable!("future config versions are rejected above"),
    }
    migrate_server_args(&mut cfg, raw);
    cfg.normalize();
    cfg.config_version = CURRENT_CONFIG_VERSION;
    cfg.validate()?;
    Ok(cfg)
}

pub fn config_path() -> PathBuf {
    #[cfg(windows)]
    let root = PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()));
    #[cfg(target_os = "macos")]
    let root = home_dir().join("Library").join("Application Support");
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let root = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join(".config"));
    root.join("llama-board").join("config.json")
}

pub fn load_result() -> Result<AppConfig, String> {
    let path = config_path();
    if !path.exists() && recover_legacy_backup(&path)? {
        // The recovered file is read below through the normal validation path.
    }
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let raw_value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid config at {}: {error}", path.display()))?;
    let cfg: AppConfig = serde_json::from_value(raw_value.clone())
        .map_err(|error| format!("invalid config at {}: {error}", path.display()))?;
    let was_old = cfg.config_version < CURRENT_CONFIG_VERSION;
    let migrated = migrate_value(raw_value.clone())?;
    if was_old {
        let serialized = serde_json::to_vec_pretty(&migrated)
            .map_err(|error| format!("failed to serialize migrated config: {error}"))?;
        atomic_write(&path, &serialized)?;
    }
    Ok(migrated)
}

fn recover_legacy_backup(path: &Path) -> Result<bool, String> {
    let Some(parent) = path.parent() else {
        return Ok(false);
    };
    if !parent.is_dir() {
        return Ok(false);
    }
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return Ok(false);
    };
    let prefix = format!(".{name}.backup-");
    let mut candidates = fs::read_dir(parent)
        .map_err(|error| format!("failed to inspect config backups: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|value| value.starts_with(&prefix))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    if let Some(backup) = candidates.pop() {
        fs::rename(backup.path(), path)
            .map_err(|error| format!("failed to recover config backup: {error}"))?;
        return Ok(true);
    }
    Ok(false)
}

#[cfg(windows)]
fn replace_atomically(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let existing = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let ok = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            replacement.as_ptr(),
            0x0000_0001 | 0x0000_0008,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_atomically(temp: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temp, target).map_err(|error| error.to_string())
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "config path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("config.json"),
        Uuid::new_v4().simple()
    ));

    let write_result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| error.to_string())?;
        file.write_all(content).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        replace_atomically(&temp, path)
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result
}

pub fn save(cfg: &AppConfig) -> Result<AppConfig, String> {
    let mut safe = cfg.clone();
    safe.normalize();
    safe = migrate(safe)?;
    let serialized = serde_json::to_vec_pretty(&safe).map_err(|error| error.to_string())?;
    atomic_write(&config_path(), &serialized)?;
    Ok(safe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_clamps_tuning_ranges() {
        let mut cfg = AppConfig {
            ngl: 999,
            ctx_size: 128,
            batch_size: 0,
            ubatch_size: 999_999,
            keep: 999_999,
            cache_type_k: "invalid".into(),
            cache_type_v: "invalid".into(),
            n_cpu_moe: 99,
            threads: 99,
            temperature: 3.0,
            top_p: -1.0,
            top_k: 9999,
            spec_draft_n_max: 999,
            spec_draft_p_min: 2.0,
            spec_draft_p_split: -1.0,
            reasoning: "invalid".into(),
            reasoning_format: "invalid".into(),
            reasoning_effort: "invalid".into(),
            reasoning_budget: -2,
            reasoning_preserve: "invalid".into(),
            flash_attn: "invalid".into(),
            ..AppConfig::default()
        };
        cfg.normalize();
        assert_eq!(cfg.ngl, 128);
        assert_eq!(cfg.ctx_size, 512);
        assert_eq!(cfg.batch_size, 1);
        assert_eq!(cfg.ubatch_size, 1);
        assert_eq!(cfg.keep, 131_072);
        assert_eq!(cfg.cache_type_k, "f16");
        assert_eq!(cfg.cache_type_v, "f16");
        assert_eq!(cfg.n_cpu_moe, 64);
        assert_eq!(cfg.threads, 64);
        assert_eq!(cfg.temperature, 2.0);
        assert_eq!(cfg.top_p, 0.01);
        assert_eq!(cfg.top_k, 200);
        assert_eq!(cfg.spec_draft_n_max, 64);
        assert_eq!(cfg.spec_draft_p_min, 1.0);
        assert_eq!(cfg.spec_draft_p_split, 0.0);
        assert_eq!(cfg.reasoning, "auto");
        assert_eq!(cfg.reasoning_format, "auto");
        assert_eq!(cfg.reasoning_effort, "default");
        assert_eq!(cfg.reasoning_budget, -1);
        assert_eq!(cfg.reasoning_preserve, "auto");
        assert_eq!(cfg.flash_attn, "auto");
    }

    #[test]
    fn advanced_settings_round_trip_and_protect_app_owned_fields() {
        let mut cfg = AppConfig {
            server_args: vec!["--min-p".into(), "0.05".into()],
            ..AppConfig::default()
        };
        cfg.chat_options
            .insert("dry_multiplier".into(), serde_json::json!(0.8));
        let migrated = migrate(cfg).expect("advanced settings should validate");
        assert_eq!(migrated.server_args, ["--min-p", "0.05"]);
        assert_eq!(
            migrated.chat_options["dry_multiplier"],
            serde_json::json!(0.8)
        );

        let blocked_server_arg = AppConfig {
            server_args: vec!["--host=0.0.0.0".into()],
            ..AppConfig::default()
        };
        assert!(blocked_server_arg.validate().is_err());

        let mut blocked_chat_option = AppConfig::default();
        blocked_chat_option
            .chat_options
            .insert("stream".into(), serde_json::json!(false));
        assert!(blocked_chat_option.validate().is_err());
    }

    #[test]
    fn defaults_are_model_neutral() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.ngl, 0);
        assert_eq!(cfg.ctx_size, 4096);
        assert_eq!(cfg.batch_size, 2048);
        assert_eq!(cfg.ubatch_size, 512);
        assert_eq!(cfg.keep, 0);
        assert_eq!(cfg.cache_type_k, "f16");
        assert_eq!(cfg.cache_type_v, "f16");
        assert_eq!(cfg.flash_attn, "auto");
        assert_eq!(cfg.temperature, 0.8);
        assert_eq!(cfg.top_p, 0.95);
        assert_eq!(cfg.top_k, 40);
        assert_eq!(cfg.spec_type, "none");
        assert_eq!(cfg.spec_draft_n_max, 3);
        assert_eq!(cfg.spec_draft_ngl, "auto");
        assert_eq!(cfg.reasoning, "auto");
        assert_eq!(cfg.reasoning_format, "auto");
        assert_eq!(cfg.reasoning_effort, "default");
        assert_eq!(cfg.reasoning_preserve, "auto");
        assert!(cfg.server_args.is_empty());
        assert!(cfg.chat_options.is_empty());
    }

    #[test]
    fn advanced_args_cannot_override_dedicated_settings() {
        for name in [
            "--n-gpu-layers",
            "--gpu-layers",
            "-ngl",
            "--ctx-size",
            "-c",
            "--batch-size",
            "-b",
            "--ubatch-size",
            "-ub",
            "--keep",
            "--cache-type-k",
            "-ctk",
            "--cache-type-v",
            "-ctv",
            "--flash-attn",
            "-fa",
            "--n-cpu-moe",
            "--threads",
            "-t",
            "--parallel",
            "-np",
            "--timeout",
            "-to",
            "--sleep-idle-seconds",
            "--lora",
            "--lora-scaled",
            "--spec-type",
            "--spec-draft-n-max",
            "--spec-draft-n-min",
            "--spec-draft-p-min",
            "--draft-p-min",
            "--spec-draft-p-split",
            "--draft-p-split",
            "--spec-draft-ngl",
            "--gpu-layers-draft",
            "--n-gpu-layers-draft",
            "--spec-draft-device",
            "-devd",
            "--device-draft",
            "--spec-draft-model",
            "-md",
            "--model-draft",
            "--reasoning",
            "-rea",
            "--reasoning-format",
            "--reasoning-effort",
            "--reasoning-budget",
            "--reasoning-budget-message",
            "--reasoning-preserve",
            "--no-reasoning-preserve",
        ] {
            let cfg = AppConfig {
                server_args: vec![name.into(), "value".into()],
                ..AppConfig::default()
            };
            assert!(cfg.validate().is_err(), "{name} should be app-managed");
        }
    }

    /// build_args only supplies --cont-batching/--no-webui when server_args is
    /// silent (see build_args_recognizes_cont_batching_and_webui_aliases in
    /// server.rs), so these spellings must stay user-overridable here too.
    #[test]
    fn advanced_args_allow_cont_batching_and_webui_overrides() {
        for name in [
            "--cont-batching",
            "-cb",
            "--no-cont-batching",
            "-nocb",
            "--webui",
            "--ui",
            "--no-webui",
            "--no-ui",
        ] {
            let cfg = AppConfig {
                server_args: vec![name.into()],
                ..AppConfig::default()
            };
            assert!(cfg.validate().is_ok(), "{name} should remain overridable");
        }
    }

    #[test]
    fn atomic_write_replaces_complete_content() {
        let root = std::env::temp_dir().join(format!("llama-board-config-{}", std::process::id()));
        fs::create_dir_all(&root).expect("temp directory");
        let path = root.join("config.json");
        atomic_write(&path, br#"{"version":1}"#).expect("first write");
        atomic_write(&path, br#"{"version":2,"safe":true}"#).expect("second write");
        assert_eq!(
            fs::read_to_string(&path).expect("read config"),
            "{\"version\":2,\"safe\":true}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migration_upgrades_old_config_and_rejects_future_config() {
        let migrated =
            migrate_value(serde_json::json!({ "config_version": 1 })).expect("old config migrates");
        assert_eq!(migrated.config_version, CURRENT_CONFIG_VERSION);
        assert_eq!(migrated.spec_draft_n_max, 3);
        assert_eq!(migrated.spec_draft_p_split, 0.1);
        assert_eq!(migrated.reasoning_budget, -1);
        let future = AppConfig {
            config_version: CURRENT_CONFIG_VERSION + 1,
            ..AppConfig::default()
        };
        assert!(migrate(future).is_err());
    }

    #[test]
    fn versionless_config_migrates_missing_fields_but_preserves_explicit_zeroes() {
        let versionless = serde_json::json!({
            "models_dir": "models",
            "spec_draft_n_max": 0,
            "spec_draft_p_split": 0.0,
            "reasoning_budget": 0
        });
        let parsed: AppConfig =
            serde_json::from_value(versionless.clone()).expect("versionless config");
        assert_eq!(parsed.config_version, 0);
        let migrated = migrate_value(versionless).expect("versionless config migrates");
        assert_eq!(migrated.config_version, CURRENT_CONFIG_VERSION);
        assert_eq!(migrated.spec_draft_n_max, 0);
        assert_eq!(migrated.spec_draft_p_split, 0.0);
        assert_eq!(migrated.reasoning_budget, 0);

        let missing_fields = serde_json::json!({ "config_version": 5 });
        let migrated = migrate_value(missing_fields).expect("missing fields migrate");
        assert_eq!(migrated.spec_draft_n_max, 3);
        assert_eq!(migrated.spec_draft_p_split, 0.1);
        assert_eq!(migrated.reasoning_budget, -1);
    }

    #[test]
    fn v7_config_migrates_without_panicking_and_backfills_batch_defaults() {
        // Every config file written before this change (including this
        // repo's own test fixtures) carries config_version 7 and predates
        // batch_size/ubatch_size/keep/cache_type_k/cache_type_v. The version
        // match previously jumped from `2..=6` straight to
        // `CURRENT_CONFIG_VERSION` (8), so a real v7 config on disk hit
        // `_ => unreachable!()` and panicked on load.
        let v7 = serde_json::json!({ "config_version": 7, "models_dir": "models" });
        let migrated = migrate_value(v7).expect("v7 config migrates without panicking");
        assert_eq!(migrated.config_version, CURRENT_CONFIG_VERSION);
        assert_eq!(migrated.batch_size, default_batch_size());
        assert_eq!(migrated.ubatch_size, default_ubatch_size());
        assert_eq!(migrated.keep, default_keep());
        assert_eq!(migrated.cache_type_k, default_cache_type());
        assert_eq!(migrated.cache_type_v, default_cache_type());
    }

    #[test]
    fn legacy_typed_server_args_migrate_to_fields_and_preserve_unmanaged_args() {
        let legacy = serde_json::json!({
            "config_version": 7,
            "models_dir": "models",
            "server_args": [
                "--batch-size", "1024",
                "-ub", "256",
                "--keep=64",
                "-ctk", "q8_0",
                "--cache-type-v", "q4_0",
                "--parallel", "2",
                "--jinja"
            ]
        });
        let migrated = migrate_value(legacy).expect("legacy typed arguments migrate");
        assert_eq!(migrated.batch_size, 1024);
        assert_eq!(migrated.ubatch_size, 256);
        assert_eq!(migrated.keep, 64);
        assert_eq!(migrated.cache_type_k, "q8_0");
        assert_eq!(migrated.cache_type_v, "q4_0");
        assert_eq!(migrated.parallel, 2);
        assert_eq!(migrated.server_args, ["--jinja"]);

        let explicit = serde_json::json!({
            "config_version": 7,
            "batch_size": 2048,
            "server_args": ["--batch-size", "1024", "--keep", "12"]
        });
        let migrated = migrate_value(explicit).expect("explicit typed values win");
        assert_eq!(migrated.batch_size, 2048);
        assert_eq!(migrated.keep, 12);
    }
}
