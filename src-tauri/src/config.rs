// src-tauri/src/config.rs
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const CURRENT_CONFIG_VERSION: u32 = 2;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AppConfig {
    #[serde(default = "default_config_version")]
    pub config_version: u32,
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
    pub active_backend: String,
    pub active_build: String,
    #[serde(default = "default_iters")]
    pub iters: u32,
}

fn default_iters() -> u32 {
    5
}

fn default_config_version() -> u32 {
    CURRENT_CONFIG_VERSION
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
            iters: default_iters(),
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
        self.n_cpu_moe = self.n_cpu_moe.min(64);
        self.threads = self.threads.min(64);
        self.temperature = if self.temperature.is_finite() {
            self.temperature.clamp(0.0, 2.0)
        } else {
            0.7
        };
        self.top_p = if self.top_p.is_finite() {
            self.top_p.clamp(0.01, 1.0)
        } else {
            0.9
        };
        self.top_k = self.top_k.clamp(1, 200);
        self.iters = self.iters.clamp(1, 100);
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
        Ok(())
    }
}

fn migrate(mut cfg: AppConfig) -> Result<AppConfig, String> {
    if cfg.config_version > CURRENT_CONFIG_VERSION {
        return Err(format!(
            "config schema {} is newer than this app supports (current {})",
            cfg.config_version, CURRENT_CONFIG_VERSION
        ));
    }
    match cfg.config_version {
        0 => {
            // Version 0 did not carry the schema marker. Missing fields were
            // filled by serde defaults; repair the fields introduced later.
            if cfg.flash_attn.trim().is_empty() {
                cfg.flash_attn = "auto".into();
            }
            if cfg.iters == 0 {
                cfg.iters = default_iters();
            }
        }
        1 => {
            // Version 1 used the same runtime fields but did not persist a
            // benchmark repetition count consistently.
            if cfg.iters == 0 {
                cfg.iters = default_iters();
            }
        }
        CURRENT_CONFIG_VERSION => {}
        _ => unreachable!("future config versions are rejected above"),
    }
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
    let cfg: AppConfig = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid config at {}: {error}", path.display()))?;
    let was_old = cfg.config_version < CURRENT_CONFIG_VERSION;
    let migrated = migrate(cfg)?;
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
            n_cpu_moe: 99,
            threads: 99,
            temperature: 3.0,
            top_p: -1.0,
            top_k: 9999,
            flash_attn: "invalid".into(),
            ..AppConfig::default()
        };
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
        let old = AppConfig {
            config_version: 1,
            ..AppConfig::default()
        };
        assert_eq!(migrate(old).expect("old config migrates").config_version, 2);
        let future = AppConfig {
            config_version: CURRENT_CONFIG_VERSION + 1,
            ..AppConfig::default()
        };
        assert!(migrate(future).is_err());
    }
}
