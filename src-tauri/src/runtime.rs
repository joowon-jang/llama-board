// src-tauri/src/runtime.rs
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const API_CACHE_TTL: Duration = Duration::from_secs(600);
const MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const SUPPORTED_BACKENDS: &[&str] = &["rocm", "vulkan", "cuda", "sycl", "openvino", "cpu"];

type AssetCache = HashMap<String, (Instant, Vec<Asset>)>;
type ErrorCache = HashMap<String, (Instant, String)>;

#[derive(Serialize, Clone, Debug)]
pub struct InstalledRuntime {
    pub build: String,
    pub backend: String,
    pub dir: String,
    pub size_mb: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct LatestInfo {
    pub build: String,
    pub file_name: String,
    pub url: String,
    pub digest: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
struct Rel {
    tag_name: String,
}

#[derive(Deserialize, Clone, Debug)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

fn app_data_root() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
    }
    #[cfg(target_os = "macos")]
    {
        return PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join("Library")
            .join("Application Support");
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        if let Ok(path) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(path);
        }
        return PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join(".local")
            .join("share");
    }
}

pub fn runtimes_root() -> PathBuf {
    app_data_root().join("llama-board").join("runtimes")
}

pub fn validate_runtime_identifiers(backend: &str, build: &str) -> Result<(), String> {
    if !SUPPORTED_BACKENDS.contains(&backend) {
        return Err(format!("unsupported runtime backend: {backend}"));
    }
    if !build.starts_with('b')
        || build.len() < 2
        || build.len() > 16
        || !build[1..].chars().all(|value| value.is_ascii_digit())
    {
        return Err(format!("invalid runtime build identifier: {build}"));
    }
    if backend.contains(['/', '\\']) || build.contains(['/', '\\']) {
        return Err("runtime identifiers must not contain path separators".into());
    }
    Ok(())
}

pub fn runtime_dir(backend: &str, build: &str) -> Result<PathBuf, String> {
    validate_runtime_identifiers(backend, build)?;
    Ok(runtimes_root().join(format!("{build}-{backend}")))
}

pub fn server_executable_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

pub fn bench_executable_name() -> &'static str {
    if cfg!(windows) {
        "llama-bench.exe"
    } else {
        "llama-bench"
    }
}

pub fn server_bin_for(backend: &str, build: &str) -> Result<PathBuf, String> {
    Ok(runtime_dir(backend, build)?.join(server_executable_name()))
}

pub fn bench_bin_for(backend: &str, build: &str) -> Result<PathBuf, String> {
    Ok(runtime_dir(backend, build)?.join(bench_executable_name()))
}

pub fn system_server_fallback(local_app_data: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(local_app_data)
            .join("Microsoft")
            .join("WinGet")
            .join("Packages")
            .join("ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join(server_executable_name())
    } else {
        PathBuf::from(server_executable_name())
    }
}

pub fn list_installed() -> Vec<InstalledRuntime> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(runtimes_root()) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((build, backend)) = name.split_once('-') else {
            continue;
        };
        if validate_runtime_identifiers(backend, build).is_err() {
            continue;
        }
        let dir = entry.path();
        if !dir.join(server_executable_name()).is_file()
            || !dir.join(bench_executable_name()).is_file()
        {
            continue;
        }
        out.push(InstalledRuntime {
            build: build.into(),
            backend: backend.into(),
            dir: dir.to_string_lossy().to_string(),
            size_mb: dir_size(&dir),
        });
    }
    out.sort_by(|a, b| b.build.cmp(&a.build).then(a.backend.cmp(&b.backend)));
    out
}

fn dir_size(dir: &Path) -> f64 {
    let mut total = 0_u64;
    walk_size(dir, &mut total, 0);
    total as f64 / 1_048_576.0
}

fn walk_size(dir: &Path, total: &mut u64, depth: u32) {
    if depth > 32 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            walk_size(&path, total, depth + 1);
        } else {
            *total = total.saturating_add(metadata.len());
        }
    }
}

pub fn uninstall(backend: &str, build: &str) -> Result<(), String> {
    let dir = runtime_dir(backend, build)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|error| format!("failed to remove runtime: {error}"))?;
    }
    Ok(())
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("llama-board/0.2")
        .timeout(Duration::from_secs(30))
        .build()
        .expect("static HTTP client configuration must be valid")
}

/// Newest real build tag (skips release tags that are not b##### builds).
pub async fn latest_build() -> Result<String, String> {
    if let Some(build) = cached_latest() {
        return Ok(build);
    }
    if let Some(error) = cached_latest_error() {
        return Err(error);
    }
    let request_lock = LATEST_REQUEST_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _request = request_lock.lock().await;
    if let Some(build) = cached_latest() {
        return Ok(build);
    }
    if let Some(error) = cached_latest_error() {
        return Err(error);
    }
    let response = http()
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20")
        .send()
        .await
        .map_err(|error| {
            let message = format!("GitHub release lookup failed: {error}");
            cache_latest_error(&message);
            message
        })?;
    let status = response.status();
    let raw = response.text().await.map_err(|error| {
        let message = format!("GitHub release response failed: {error}");
        cache_latest_error(&message);
        message
    })?;
    if !status.is_success() {
        let error = api_error(status, &raw);
        cache_latest_error(&error);
        return Err(error);
    }
    let releases: Vec<Rel> = serde_json::from_str(&raw).map_err(|error| {
        let message = format!("invalid GitHub release response: {error}");
        cache_latest_error(&message);
        message
    })?;
    let build = releases
        .into_iter()
        .find(|release| {
            release.tag_name.starts_with('b')
                && release.tag_name.len() <= 16
                && release.tag_name[1..]
                    .chars()
                    .all(|value| value.is_ascii_digit())
        })
        .map(|release| release.tag_name)
        .ok_or_else(|| "no b##### llama.cpp release found".to_owned())?;
    cache_latest(&build);
    Ok(build)
}

#[derive(Deserialize, Clone, Debug)]
struct ReleaseDetail {
    assets: Vec<Asset>,
}

static LATEST_CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();
static LATEST_ERROR_CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();
static ASSET_CACHE: OnceLock<Mutex<AssetCache>> = OnceLock::new();
static ASSET_ERROR_CACHE: OnceLock<Mutex<ErrorCache>> = OnceLock::new();
static LATEST_REQUEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static ASSET_REQUEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(|message| message.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.lines().next().unwrap_or("request failed").to_owned());
    format!("GitHub API {status}: {message}")
}

fn cached_latest() -> Option<String> {
    LATEST_CACHE
        .get()?
        .lock()
        .ok()?
        .as_ref()
        .and_then(|(at, build)| (at.elapsed() < API_CACHE_TTL).then(|| build.clone()))
}

fn cached_latest_error() -> Option<String> {
    LATEST_ERROR_CACHE
        .get()?
        .lock()
        .ok()?
        .as_ref()
        .and_then(|(at, error)| (at.elapsed() < API_CACHE_TTL).then(|| error.clone()))
}

fn cache_latest_error(error: &str) {
    let cache = LATEST_ERROR_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut value) = cache.lock() {
        *value = Some((Instant::now(), error.to_owned()));
    }
}

fn cache_latest(build: &str) {
    let cache = LATEST_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut value) = cache.lock() {
        *value = Some((Instant::now(), build.to_owned()));
    }
}

fn cached_assets(build: &str) -> Option<Vec<Asset>> {
    let cache = ASSET_CACHE.get()?.lock().ok()?;
    cache
        .get(build)
        .and_then(|(at, assets)| (at.elapsed() < API_CACHE_TTL).then(|| assets.clone()))
}

fn cached_asset_error(build: &str) -> Option<String> {
    let cache = ASSET_ERROR_CACHE.get()?.lock().ok()?;
    cache
        .get(build)
        .and_then(|(at, error)| (at.elapsed() < API_CACHE_TTL).then(|| error.clone()))
}

fn cache_asset_error(build: &str, error: &str) {
    let cache = ASSET_ERROR_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut value) = cache.lock() {
        value.insert(build.to_owned(), (Instant::now(), error.to_owned()));
    }
}

fn cache_assets(build: &str, assets: &[Asset]) {
    let cache = ASSET_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut value) = cache.lock() {
        value.insert(build.to_owned(), (Instant::now(), assets.to_owned()));
    }
}

fn parse_release_assets(body: &str) -> Result<Vec<Asset>, String> {
    serde_json::from_str::<ReleaseDetail>(body)
        .map(|release| release.assets)
        .map_err(|error| error.to_string())
}

fn release_platform() -> &'static str {
    if cfg!(windows) {
        "win"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Pick a verified x64 asset for a backend.
pub async fn latest_for(backend: &str) -> Result<LatestInfo, String> {
    if !SUPPORTED_BACKENDS.contains(&backend) {
        return Err(format!("unsupported runtime backend: {backend}"));
    }
    let build = latest_build().await?;
    if let Some(error) = cached_asset_error(&build) {
        return Err(error);
    }
    let assets = if let Some(assets) = cached_assets(&build) {
        assets
    } else {
        let request_lock = ASSET_REQUEST_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
        let _request = request_lock.lock().await;
        if let Some(assets) = cached_assets(&build) {
            assets
        } else if let Some(error) = cached_asset_error(&build) {
            return Err(error);
        } else {
            let response = http()
                .get(format!(
                    "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{build}"
                ))
                .send()
                .await
                .map_err(|error| {
                    let message = format!("GitHub asset lookup failed: {error}");
                    cache_asset_error(&build, &message);
                    message
                })?;
            let status = response.status();
            let raw = response.text().await.map_err(|error| {
                let message = format!("GitHub asset response failed: {error}");
                cache_asset_error(&build, &message);
                message
            })?;
            if !status.is_success() {
                let error = api_error(status, &raw);
                cache_asset_error(&build, &error);
                return Err(error);
            }
            let assets = match parse_release_assets(&raw) {
                Ok(assets) => assets,
                Err(error) => {
                    cache_asset_error(&build, &error);
                    return Err(error);
                }
            };
            cache_assets(&build, &assets);
            assets
        }
    };

    let prefix = format!("llama-{build}-bin-{}-{backend}", release_platform());
    let asset = assets
        .iter()
        .find(|asset| {
            asset.name == format!("{prefix}-x64.zip")
                || (asset.name.starts_with(&prefix) && asset.name.ends_with("-x64.zip"))
        })
        .cloned()
        .ok_or_else(|| format!("no {backend} x64 asset for {build}"))?;
    Ok(LatestInfo {
        build,
        file_name: asset.name,
        url: asset.browser_download_url,
        digest: asset.digest,
    })
}

fn emit(app: &AppHandle, backend: &str, build: &str, phase: &str, received: f64, total: f64) {
    let _ = app.emit(
        "runtime-download-progress",
        serde_json::json!({
            "backend": backend,
            "build": build,
            "phase": phase,
            "received": received,
            "total": total
        }),
    );
}

fn validate_download_url(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|error| format!("invalid download URL: {error}"))?;
    if parsed.scheme() != "https" {
        return Err("runtime download URL must use HTTPS".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    if host != "github.com"
        && host != "objects.githubusercontent.com"
        && !host.ends_with(".githubusercontent.com")
    {
        return Err(format!("runtime download host is not trusted: {host}"));
    }
    Ok(())
}

fn normalize_digest(value: &str) -> Result<String, String> {
    let hex = value.strip_prefix("sha256:").unwrap_or(value).trim();
    if hex.len() != 64 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("release asset digest is not a SHA-256 value".into());
    }
    Ok(hex.to_ascii_lowercase())
}

fn validate_asset_file_name(name: &str) -> Result<(), String> {
    let path = Path::new(name);
    if name.is_empty()
        || name.len() > 255
        || path.file_name().and_then(|value| value.to_str()) != Some(name)
        || !name.ends_with(".zip")
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err("release asset filename is not a safe ZIP basename".into());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    std::io::copy(&mut reader, &mut hasher).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub async fn install(
    app: AppHandle,
    backend: &str,
    build: &str,
) -> Result<InstalledRuntime, String> {
    validate_runtime_identifiers(backend, build)?;
    let info = latest_for(backend).await?;
    if info.build != build {
        return Err(format!("requested {build} but latest is {}", info.build));
    }
    validate_asset_file_name(&info.file_name)?;
    let expected = normalize_digest(info.digest.as_deref().ok_or_else(|| {
        "release asset has no SHA-256 digest; refusing unverified install".to_string()
    })?)?;
    validate_download_url(&info.url)?;

    let root = runtimes_root();
    let download_root = app_data_root().join("llama-board").join("downloads");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    fs::create_dir_all(&download_root).map_err(|error| error.to_string())?;
    let nonce = Uuid::new_v4().simple().to_string();
    let archive_path = download_root.join(format!(".{nonce}-{}.zip", info.file_name));
    let staging = root.join(format!(".{build}-{backend}.staging-{nonce}"));

    let result = async {
        emit(&app, backend, build, "downloading", 0.0, 0.0);
        download_to_file(&app, backend, build, &info.url, &archive_path).await?;
        let actual = sha256_file(&archive_path)?;
        if actual != expected {
            return Err(format!(
                "runtime archive digest mismatch: expected {expected}, got {actual}"
            ));
        }
        emit(&app, backend, build, "verified", 1.0, 1.0);

        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
        }
        emit(&app, backend, build, "extracting", 0.0, 0.0);
        extract(&archive_path, &staging)?;
        verify_runtime_files(&staging)?;
        replace_runtime(&staging, &runtime_dir(backend, build)?)?;
        emit(&app, backend, build, "installed", 1.0, 1.0);
        let dest = runtime_dir(backend, build)?;
        Ok(InstalledRuntime {
            build: build.into(),
            backend: backend.into(),
            dir: dest.to_string_lossy().into_owned(),
            size_mb: dir_size(&dest),
        })
    }
    .await;

    let _ = fs::remove_file(&archive_path);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

async fn download_to_file(
    app: &AppHandle,
    backend: &str,
    build: &str,
    url: &str,
    path: &Path,
) -> Result<(), String> {
    let response = http()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("runtime download failed: {error}"))?;
    validate_download_url(response.url().as_str())?;
    if !response.status().is_success() {
        return Err(format!(
            "runtime download returned HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_ARCHIVE_BYTES)
    {
        return Err("runtime archive exceeds the configured size limit".into());
    }
    let total = response.content_length().unwrap_or(0);
    let mut output = fs::File::create(path).map_err(|error| error.to_string())?;
    let mut received = 0_u64;
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|error| format!("runtime download stream failed: {error}"))?
    {
        received = received.saturating_add(chunk.len() as u64);
        if received > MAX_ARCHIVE_BYTES {
            return Err("runtime archive exceeds the configured size limit".into());
        }
        output
            .write_all(&chunk)
            .map_err(|error| error.to_string())?;
        emit(
            app,
            backend,
            build,
            "downloading",
            received as f64,
            total as f64,
        );
    }
    output.flush().map_err(|error| error.to_string())?;
    Ok(())
}

fn verify_runtime_files(staging: &Path) -> Result<(), String> {
    let server = staging.join(server_executable_name());
    let bench = staging.join(bench_executable_name());
    if !server.is_file() || !bench.is_file() {
        return Err(format!(
            "runtime archive is missing {} or {}",
            server_executable_name(),
            bench_executable_name()
        ));
    }
    Ok(())
}

fn replace_runtime(staging: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "runtime destination has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let backup = parent.join(format!(
        ".{}.backup-{}",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        Uuid::new_v4().simple()
    ));
    let had_old = destination.exists();
    if had_old {
        fs::rename(destination, &backup)
            .map_err(|error| format!("failed to stage old runtime: {error}"))?;
    }
    if let Err(error) = fs::rename(staging, destination) {
        if had_old {
            if let Err(rollback) = fs::rename(&backup, destination) {
                return Err(format!(
                    "failed to activate runtime: {error}; rollback also failed: {rollback}"
                ));
            }
        }
        return Err(format!("failed to activate runtime: {error}"));
    }
    if had_old {
        fs::remove_dir_all(&backup).map_err(|error| {
            format!("runtime activated but old runtime cleanup failed: {error}")
        })?;
    }
    Ok(())
}

fn extract(zip_path: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;
    let file = fs::File::open(zip_path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("runtime archive contains too many entries".into());
    }
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry
            .unix_mode()
            .is_some_and(|mode| (mode & 0o170000) == 0o120000)
        {
            return Err("runtime archive contains a symbolic link".into());
        }
        let relative = entry
            .enclosed_name()
            .ok_or("runtime archive contains an unsafe path")?;
        let output = dest.join(relative);
        if !output.starts_with(dest) {
            return Err("runtime archive path escapes staging directory".into());
        }
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        let declared_size = entry.size();
        extracted_bytes = extracted_bytes
            .checked_add(declared_size)
            .ok_or("runtime archive expanded size overflow")?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err("runtime archive expands beyond the configured size limit".into());
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut destination = fs::File::create(&output).map_err(|error| error.to_string())?;
        let mut source = BufReader::new(entry);
        let copied =
            std::io::copy(&mut source, &mut destination).map_err(|error| error.to_string())?;
        if copied != declared_size {
            return Err("runtime archive entry size changed while extracting".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_object_assets() {
        let body = r#"{
            "tag_name": "b10603",
            "assets": [{
                "name": "llama-b10603-bin-win-vulkan-x64.zip",
                "browser_download_url": "https://example.invalid/vulkan.zip"
            }]
        }"#;
        let assets = parse_release_assets(body).expect("release object should decode");
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].name, "llama-b10603-bin-win-vulkan-x64.zip");
    }

    #[test]
    fn github_rate_limit_error_is_actionable() {
        let error = api_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"message":"API rate limit exceeded"}"#,
        );
        assert!(error.contains("GitHub API 403"));
        assert!(error.contains("API rate limit exceeded"));
    }

    #[test]
    fn runtime_identifiers_reject_traversal_and_invalid_values() {
        assert!(validate_runtime_identifiers("../outside", "b10603").is_err());
        assert!(validate_runtime_identifiers("vulkan", "../../outside").is_err());
        assert!(validate_runtime_identifiers("not-a-backend", "b10603").is_err());
        assert!(validate_runtime_identifiers("vulkan", "b10603").is_ok());
    }

    #[test]
    fn release_asset_filename_must_be_a_safe_zip_basename() {
        assert!(validate_asset_file_name("llama-b10603-bin-win-vulkan-x64.zip").is_ok());
        assert!(validate_asset_file_name("../runtime.zip").is_err());
        assert!(validate_asset_file_name("runtime.tar.gz").is_err());
        assert!(validate_asset_file_name("runtime file.zip").is_err());
    }

    #[test]
    fn release_asset_digest_is_preserved() {
        let body = r#"{
            "assets": [{
                "name": "llama-b10603-bin-win-vulkan-x64.zip",
                "browser_download_url": "https://example.invalid/vulkan.zip",
                "digest": "sha256:0123456789abcdef"
            }]
        }"#;
        let assets = parse_release_assets(body).expect("release object should decode");
        assert_eq!(assets[0].digest.as_deref(), Some("sha256:0123456789abcdef"));
    }
}
