// src-tauri/src/runtime.rs
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Debug)]
pub struct InstalledRuntime {
    pub build: String,
    pub backend: String,
    pub dir: String,
    pub size_mb: f64,
}
#[derive(Serialize, Clone, Debug)]
pub struct LatestInfo { pub build: String, pub file_name: String, pub url: String }

#[derive(Deserialize, Clone)] struct Rel { tag_name: String }
#[derive(Deserialize, Clone)] struct Asset { name: String, browser_download_url: String }

pub fn runtimes_root() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
        .join("llama-board").join("runtimes")
}
pub fn runtime_dir(backend: &str, build: &str) -> PathBuf {
    runtimes_root().join(format!("{build}-{backend}"))
}
pub fn server_bin_for(backend: &str, build: &str) -> PathBuf {
    runtime_dir(backend, build).join("llama-server.exe")
}
pub fn bench_bin_for(backend: &str, build: &str) -> PathBuf {
    runtime_dir(backend, build).join("llama-bench.exe")
}

pub fn list_installed() -> Vec<InstalledRuntime> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(runtimes_root()) else { return out };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(idx) = name.find('-') {
            let dir = e.path();
            out.push(InstalledRuntime {
                build: name[..idx].into(),
                backend: name[idx + 1..].into(),
                dir: dir.to_string_lossy().to_string(),
                size_mb: dir_size(&dir),
            });
        }
    }
    out.sort_by(|a, b| b.build.cmp(&a.build).then(a.backend.cmp(&b.backend)));
    out
}

fn dir_size(dir: &Path) -> f64 {
    let mut t: u64 = 0;
    walk(dir, &mut t);
    t as f64 / 1_048_576.0
}
fn walk(dir: &Path, acc: &mut u64) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() { walk(&p, acc); }
        else if let Ok(md) = e.metadata() { *acc += md.len(); }
    }
}

pub fn uninstall(backend: &str, build: &str) -> Result<(), String> {
    let dir = runtime_dir(backend, build);
    if dir.exists() { fs::remove_dir_all(&dir).map_err(|e| e.to_string())?; }
    Ok(())
}

// ---- GitHub API ----
fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("llama-board/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build().expect("http client")
}

/// Newest real build tag (skips the bogus v0.2.0 "latest").
pub async fn latest_build() -> Result<String, String> {
    if let Some(build) = cached_latest() { return Ok(build); }
    if let Some(error) = cached_latest_error() { return Err(error); }
    let response = http()
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20")
        .send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let raw = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let error = api_error(status, &raw);
        cache_latest_error(&error);
        return Err(error);
    }
    let rels: Vec<Rel> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let build = rels.into_iter()
        .find(|r| r.tag_name.starts_with('b') && r.tag_name[1..].chars().all(|c| c.is_ascii_digit()))
        .map(|r| r.tag_name)
        .ok_or_else(|| "no b##### release found".to_owned())?;
    cache_latest(&build);
    Ok(build)
}

#[derive(Deserialize, Clone)] struct ReleaseDetail {
    assets: Vec<Asset>,
}

static LATEST_CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();
static LATEST_ERROR_CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();
static ASSET_CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<Asset>)>>> = OnceLock::new();
static ASSET_ERROR_CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
const API_CACHE_TTL: Duration = Duration::from_secs(600);

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_owned))
        .unwrap_or_else(|| body.lines().next().unwrap_or("request failed").to_owned());
    format!("GitHub API {status}: {message}")
}

fn cached_latest() -> Option<String> {
    LATEST_CACHE.get()?.lock().ok()?.as_ref().and_then(|(at, build)| {
        (at.elapsed() < API_CACHE_TTL).then(|| build.clone())
    })
}

fn cached_latest_error() -> Option<String> {
    LATEST_ERROR_CACHE.get()?.lock().ok()?.as_ref().and_then(|(at, error)| {
        (at.elapsed() < API_CACHE_TTL).then(|| error.clone())
    })
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
    cache.get(build).and_then(|(at, assets)| {
        (at.elapsed() < API_CACHE_TTL).then(|| assets.clone())
    })
}

fn cached_asset_error(build: &str) -> Option<String> {
    let cache = ASSET_ERROR_CACHE.get()?.lock().ok()?;
    cache.get(build).and_then(|(at, error)| {
        (at.elapsed() < API_CACHE_TTL).then(|| error.clone())
    })
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
        .map_err(|e| e.to_string())
}

/// Pick the x64 asset for a backend (prefix match handles rocm/cuda/openvino version suffixes).
pub async fn latest_for(backend: &str) -> Result<LatestInfo, String> {
    let build = latest_build().await?;
    if let Some(error) = cached_asset_error(&build) { return Err(error); }
    let body = if let Some(assets) = cached_assets(&build) {
        assets
    } else {
        let response = http()
            .get(format!("https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{build}"))
            .send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        let raw = response.text().await.map_err(|e| e.to_string())?;
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
    };
    let prefix = format!("llama-{build}-bin-win-{backend}");
    let a = body.iter().find(|x| x.name == format!("{prefix}-x64.zip"))
        .or_else(|| body.iter().find(|x| x.name.starts_with(&prefix) && x.name.ends_with("-x64.zip")))
        .cloned()
        .ok_or_else(|| format!("no {backend} x64 asset for {build}"))?;
    Ok(LatestInfo { build, file_name: a.name, url: a.browser_download_url })
}

// ---- download + extract with progress events ----
fn emit(app: &AppHandle, backend: &str, build: &str, phase: &str, received: f64, total: f64) {
    let _ = app.emit("runtime-download-progress", serde_json::json!({
        "backend": backend, "build": build, "phase": phase, "received": received, "total": total
    }));
}

pub async fn install(app: AppHandle, backend: &str, build: &str) -> Result<InstalledRuntime, String> {
    let info = latest_for(backend).await?;
    if info.build != build {
        return Err(format!("requested {build} but latest is {}", info.build));
    }
    let url = info.url.clone();
    let fname = info.file_name.clone();

    emit(&app, backend, build, "downloading", 0.0, 0.0);
    let bytes = download(&app, backend, build, &url).await?;

    let dl_root = PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
        .join("llama-board").join("downloads");
    fs::create_dir_all(&dl_root).map_err(|e| e.to_string())?;
    let tmp_zip = dl_root.join(&fname);
    fs::write(&tmp_zip, &bytes).map_err(|e| e.to_string())?;

    emit(&app, backend, build, "extracting", 0.0, 0.0);
    let dest = runtime_dir(backend, build);
    if dest.exists() { fs::remove_dir_all(&dest).map_err(|e| e.to_string())?; }
    extract(&tmp_zip, &dest)?;
    let _ = fs::remove_file(&tmp_zip);

    Ok(InstalledRuntime {
        build: build.into(),
        backend: backend.into(),
        dir: dest.to_string_lossy().to_string(),
        size_mb: dir_size(&dest),
    })
}

async fn download(app: &AppHandle, backend: &str, build: &str, url: &str) -> Result<Vec<u8>, String> {
    let resp = http().get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let mut buf: Vec<u8> = Vec::with_capacity(total.map(|t| t as usize).unwrap_or(0));
    let mut received: u64 = 0;
    let mut last = std::time::Instant::now();
    let mut stream = resp;
    while let Some(chunk) = stream.chunk().await.map_err(|e| e.to_string())? {
        received += chunk.len() as u64;
        buf.extend_from_slice(&chunk);
        if last.elapsed().as_millis() > 100 {
            emit(app, backend, build, "downloading", received as f64, total.unwrap_or(received) as f64);
            last = std::time::Instant::now();
        }
    }
    Ok(buf)
}

fn extract(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let rel = entry.enclosed_name().ok_or("bad zip entry")?;
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut dst = fs::File::create(&out).map_err(|e| e.to_string())?;
            use std::io::BufReader;
            let mut src = BufReader::new(entry);
            std::io::copy(&mut src, &mut dst).map_err(|e| e.to_string())?;
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
}
