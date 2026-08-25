// Hugging Face Discover/search/download support.
use futures_util::StreamExt;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const HF_API: &str = "https://huggingface.co/api";
const MAX_QUERY_LENGTH: usize = 200;
const MAX_API_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TREE_ENTRIES: usize = 50_000;
const MAX_MODEL_BYTES: u64 = 512 * 1024 * 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct HfModel {
    pub id: String,
    pub author: String,
    pub downloads: u64,
    pub likes: u64,
    pub last_modified: String,
    pub pipeline_tag: Option<String>,
    pub tags: Vec<String>,
    pub gated: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct HfFile {
    pub path: String,
    pub size_bytes: u64,
    pub oid: Option<String>,
    pub is_mmproj: bool,
    pub download_url: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct DownloadedModel {
    pub repo_id: String,
    pub file_path: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Deserialize, Debug)]
struct ApiModel {
    id: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default, rename = "pipeline_tag")]
    pipeline_tag: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    gated: bool,
}

#[derive(Deserialize, Debug)]
struct ApiTreeEntry {
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    oid: Option<String>,
    #[serde(rename = "type")]
    entry_type: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("llama-board/0.1")
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("Hugging Face client setup failed: {error}"))
}

fn trusted_hf_host(host: &str) -> bool {
    host == "huggingface.co"
        || host.ends_with(".huggingface.co")
        || host == "hf.co"
        || host.ends_with(".hf.co")
}

fn validate_response_url(response: &reqwest::Response) -> Result<(), String> {
    if response.url().scheme() != "https" {
        return Err("Hugging Face response must use HTTPS".into());
    }
    let host = response.url().host_str().unwrap_or_default();
    if trusted_hf_host(host) {
        Ok(())
    } else {
        Err(format!(
            "Hugging Face redirected to an untrusted host: {host}"
        ))
    }
}

async fn bounded_response_bytes(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!(
            "Hugging Face response exceeds the {limit} byte limit"
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Hugging Face response could not be read: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(format!(
                "Hugging Face response exceeds the {limit} byte limit"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn decode_json<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    let status = response.status();
    let bytes = bounded_response_bytes(response, MAX_API_RESPONSE_BYTES).await?;
    let body = String::from_utf8(bytes)
        .map_err(|error| format!("Hugging Face response was not UTF-8: {error}"))?;
    if !status.is_success() {
        let detail = body.lines().next().unwrap_or("request failed");
        return Err(format!(
            "Hugging Face API {status}: {}",
            detail.chars().take(300).collect::<String>()
        ));
    }
    serde_json::from_str(&body)
        .map_err(|error| format!("Hugging Face response was invalid JSON: {error}"))
}

pub fn validate_repo_id(repo_id: &str) -> Result<(), String> {
    let value = repo_id.trim();
    let parts: Vec<&str> = value.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 128
                || !part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
                || part.starts_with('.')
        })
    {
        return Err("Hugging Face repo must use the form author/model with safe names".into());
    }
    Ok(())
}

pub fn validate_repo_path(file_path: &str) -> Result<(), String> {
    let value = file_path.trim();
    if value.is_empty() || value.starts_with('/') || value.contains('\\') {
        return Err("model file path is not a safe relative path".into());
    }
    for part in value.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.len() > 255
            || part.ends_with('.')
            || part.ends_with(' ')
            || part.chars().any(|character| {
                character.is_control() || ['<', '>', ':', '"', '|', '?', '*'].contains(&character)
            })
        {
            return Err("model file path contains an unsafe component".into());
        }
    }
    if !value.to_ascii_lowercase().ends_with(".gguf") {
        return Err("Discover only downloads GGUF files".into());
    }
    Ok(())
}

fn is_mmproj(file_path: &str) -> bool {
    file_path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .starts_with("mmproj")
}

fn download_url(repo_id: &str, file_path: &str) -> String {
    format!("https://huggingface.co/{repo_id}/resolve/main/{file_path}?download=true")
}

fn repo_directory(repo_id: &str) -> PathBuf {
    repo_id.split('/').fold(PathBuf::new(), |mut path, part| {
        path.push(part);
        path
    })
}

fn relative_path(file_path: &str) -> PathBuf {
    file_path.split('/').fold(PathBuf::new(), |mut path, part| {
        path.push(part);
        path
    })
}

fn models_root(models_dir: &str) -> Result<PathBuf, String> {
    let input = models_dir.trim();
    if input.is_empty() {
        return Err("models directory is empty".into());
    }
    fs::create_dir_all(input)
        .map_err(|error| format!("cannot create models directory: {error}"))?;
    let root = Path::new(input)
        .canonicalize()
        .map_err(|error| format!("cannot open models directory: {error}"))?;
    if !root.is_dir() {
        return Err("models path is not a directory".into());
    }
    Ok(root)
}

fn target_path(models_dir: &str, repo_id: &str, file_path: &str) -> Result<PathBuf, String> {
    validate_repo_id(repo_id)?;
    validate_repo_path(file_path)?;
    let root = models_root(models_dir)?;
    let target = root
        .join("hf")
        .join(repo_directory(repo_id))
        .join(relative_path(file_path));
    let parent = target
        .parent()
        .ok_or_else(|| "download destination has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create download directory: {error}"))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("cannot resolve download directory: {error}"))?;
    if !canonical_parent.starts_with(&root) {
        return Err("download destination escapes the models directory".into());
    }
    Ok(canonical_parent.join(
        target
            .file_name()
            .ok_or_else(|| "download filename is empty".to_string())?,
    ))
}

fn temporary_download_path(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "download destination has no parent".to_string())?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "download filename is invalid".to_string())?;
    Ok(parent.join(format!(".{name}.{}.part", Uuid::new_v4().simple())))
}

fn same_path_identity(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalize = |path: &Path| {
            let value = path.to_string_lossy();
            let value = value.strip_prefix(r"\\?\").unwrap_or(value.as_ref());
            value.to_ascii_lowercase()
        };
        normalize(left) == normalize(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

async fn ensure_download_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "download destination has no parent".to_string())?;
    let metadata = tokio::fs::symlink_metadata(parent)
        .await
        .map_err(|error| format!("cannot inspect download directory: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("download directory must be a real directory".into());
    }
    let resolved = tokio::fs::canonicalize(parent)
        .await
        .map_err(|error| format!("cannot resolve download directory: {error}"))?;
    if !same_path_identity(&resolved, parent) {
        return Err("download directory must not be a reparse point".into());
    }
    Ok(())
}

async fn create_staging_file(path: &Path) -> Result<tokio::fs::File, String> {
    ensure_download_parent(path).await?;
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => return Err("download staging path already exists".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("cannot inspect download staging path: {error}")),
    }
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|error| format!("cannot stage model download: {error}"))
}

async fn activate_download(part: &Path, target: &Path) -> Result<(), String> {
    ensure_download_parent(target).await?;
    match tokio::fs::symlink_metadata(target).await {
        Ok(_) => return Err("a different model appeared at the download destination".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "cannot inspect model destination before activation: {error}"
            ));
        }
    }
    tokio::fs::hard_link(part, target)
        .await
        .map_err(|error| format!("cannot activate downloaded model without overwrite: {error}"))?;
    tokio::fs::remove_file(part)
        .await
        .map_err(|error| format!("cannot clean up staged model download: {error}"))
}

pub async fn search(query: &str, limit: u32) -> Result<Vec<HfModel>, String> {
    let query = query.trim();
    if query.len() > MAX_QUERY_LENGTH || query.chars().any(char::is_control) {
        return Err("model search query is invalid or too long".into());
    }
    let limit = limit.clamp(1, 50).to_string();
    let response = client()?
        .get(format!("{HF_API}/models"))
        .query(&[
            ("search", query),
            ("filter", "gguf"),
            ("sort", "downloads"),
            ("direction", "-1"),
            ("limit", limit.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Hugging Face model search failed: {error}"))?;
    validate_response_url(&response)?;
    let items: Vec<ApiModel> = decode_json(response).await?;
    Ok(items
        .into_iter()
        .map(|item| HfModel {
            id: item.id,
            author: item.author,
            downloads: item.downloads,
            likes: item.likes,
            last_modified: item.last_modified.unwrap_or_default(),
            pipeline_tag: item.pipeline_tag,
            tags: item.tags,
            gated: item.gated,
        })
        .collect())
}

pub async fn files(repo_id: &str) -> Result<Vec<HfFile>, String> {
    validate_repo_id(repo_id)?;
    let response = client()?
        .get(format!("{HF_API}/models/{repo_id}/tree/main"))
        .query(&[("recursive", "true"), ("expand", "false")])
        .send()
        .await
        .map_err(|error| format!("Hugging Face file listing failed: {error}"))?;
    validate_response_url(&response)?;
    let entries: Vec<ApiTreeEntry> = decode_json(response).await?;
    if entries.len() > MAX_TREE_ENTRIES {
        return Err("Hugging Face repository tree is too large to inspect safely".into());
    }
    entries
        .into_iter()
        .filter(|entry| {
            entry.entry_type == "file" && entry.path.to_ascii_lowercase().ends_with(".gguf")
        })
        .map(|entry| {
            validate_repo_path(&entry.path)?;
            Ok(HfFile {
                path: entry.path.clone(),
                size_bytes: entry.size,
                oid: entry.oid,
                is_mmproj: is_mmproj(&entry.path),
                download_url: download_url(repo_id, &entry.path),
            })
        })
        .collect()
}

fn expected_sha256(oid: Option<&str>) -> Option<String> {
    let value = oid?
        .strip_prefix("sha256:")
        .unwrap_or(oid?)
        .to_ascii_lowercase();
    (value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit()))
        .then_some(value)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let file =
        fs::File::open(path).map_err(|error| format!("cannot verify downloaded file: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("cannot hash downloaded file: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn emit_progress(
    app: &AppHandle,
    repo_id: &str,
    file_path: &str,
    phase: &str,
    received: u64,
    total: u64,
) {
    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({
            "repo_id": repo_id,
            "file_path": file_path,
            "phase": phase,
            "received": received,
            "total": total,
        }),
    );
}

pub async fn download(
    app: AppHandle,
    repo_id: &str,
    file_path: &str,
    models_dir: &str,
    cancel: Arc<AtomicBool>,
) -> Result<DownloadedModel, String> {
    validate_repo_id(repo_id)?;
    validate_repo_path(file_path)?;
    if cancel.load(Ordering::Acquire) {
        return Err("model download cancelled".into());
    }
    let file = files(repo_id)
        .await?
        .into_iter()
        .find(|candidate| candidate.path == file_path)
        .ok_or_else(|| "GGUF file was not found in the repository tree".to_string())?;
    let target = target_path(models_dir, repo_id, file_path)?;
    let part = temporary_download_path(&target)?;
    let total = file.size_bytes;
    if total > MAX_MODEL_BYTES {
        return Err("model file exceeds the 512 GiB safety limit".into());
    }
    let expected = expected_sha256(file.oid.as_deref())
        .ok_or_else(|| "Hugging Face did not provide a valid SHA-256 digest".to_string())?;
    match tokio::fs::symlink_metadata(&target).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("model destination must not be a symbolic link".into());
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err("model destination is not a regular file".into());
        }
        Ok(_) => {
            let existing = target.clone();
            let actual = tokio::task::spawn_blocking(move || hash_file(&existing))
                .await
                .map_err(|error| format!("existing model checksum task failed: {error}"))??;
            if actual == expected {
                emit_progress(&app, repo_id, file_path, "complete", total, total);
                return Ok(DownloadedModel {
                    repo_id: repo_id.to_owned(),
                    file_path: file_path.to_owned(),
                    path: target.to_string_lossy().into_owned(),
                    size_bytes: total,
                });
            }
            return Err("a different model already exists at the download destination".into());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "cannot inspect existing model destination: {error}"
            ));
        }
    }
    emit_progress(&app, repo_id, file_path, "starting", 0, total);
    let response = client()?
        .get(&file.download_url)
        .send()
        .await
        .map_err(|error| format!("model download failed: {error}"))?;
    validate_response_url(&response)?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("model download HTTP status: {status}"));
    }
    let response_total = response.content_length().unwrap_or(total);
    if response
        .content_length()
        .is_some_and(|length| length != total)
    {
        return Err(format!(
            "model download length {response_total} does not match repository metadata {total}"
        ));
    }
    if response_total > MAX_MODEL_BYTES {
        return Err("model download exceeds the 512 GiB safety limit".into());
    }
    let mut output = create_staging_file(&part).await?;
    let mut received = 0_u64;
    let mut response = response;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                drop(output);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(format!("model download stream failed: {error}"));
            }
        };
        if cancel.load(Ordering::Acquire) {
            drop(output);
            let _ = tokio::fs::remove_file(&part).await;
            emit_progress(
                &app,
                repo_id,
                file_path,
                "cancelled",
                received,
                response_total,
            );
            return Err("model download cancelled".into());
        }
        received = received.saturating_add(chunk.len() as u64);
        if received > MAX_MODEL_BYTES
            || (response_total > 0 && received > response_total.saturating_add(1024 * 1024))
        {
            drop(output);
            let _ = tokio::fs::remove_file(&part).await;
            return Err("model download reported an unsafe size".into());
        }
        if let Err(error) = output.write_all(&chunk).await {
            drop(output);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(format!("cannot write model download: {error}"));
        }
        emit_progress(
            &app,
            repo_id,
            file_path,
            "downloading",
            received,
            response_total,
        );
    }
    if let Err(error) = output.flush().await {
        drop(output);
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("cannot flush model download: {error}"));
    }
    drop(output);
    if response_total > 0 && received != response_total {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "model download ended at {received} bytes; expected {response_total}"
        ));
    }
    let part_for_hash = part.clone();
    let actual = match tokio::task::spawn_blocking(move || hash_file(&part_for_hash)).await {
        Ok(Ok(actual)) => actual,
        Ok(Err(error)) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(error);
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(format!("model checksum task failed: {error}"));
        }
    };
    if actual != expected {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("downloaded model checksum does not match Hugging Face metadata".into());
    }
    if cancel.load(Ordering::Acquire) {
        let _ = tokio::fs::remove_file(&part).await;
        emit_progress(
            &app,
            repo_id,
            file_path,
            "cancelled",
            received,
            response_total,
        );
        return Err("model download cancelled".into());
    }
    if let Err(error) = activate_download(&part, &target).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(error);
    }
    emit_progress(
        &app,
        repo_id,
        file_path,
        "complete",
        received,
        response_total,
    );
    Ok(DownloadedModel {
        repo_id: repo_id.to_owned(),
        file_path: file_path.to_owned(),
        path: target.to_string_lossy().into_owned(),
        size_bytes: received,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_repo_and_file_traversal() {
        assert!(validate_repo_id("org/model").is_ok());
        assert!(validate_repo_id("https://huggingface.co/org/model").is_err());
        assert!(validate_repo_id("org/../model").is_err());
        assert!(validate_repo_path("Q4/model.gguf").is_ok());
        assert!(validate_repo_path("../model.gguf").is_err());
        assert!(validate_repo_path("Q4\\model.gguf").is_err());
        assert!(validate_repo_path("README.md").is_err());
    }

    #[test]
    fn target_is_nested_under_the_selected_models_root() {
        let root =
            std::env::temp_dir().join(format!("llama-board-discover-{}", uuid::Uuid::new_v4()));
        let path = target_path(&root.to_string_lossy(), "org/model", "Q4/model.gguf")
            .expect("safe target");
        let canonical_root = root.canonicalize().expect("canonical root");
        assert!(path.starts_with(canonical_root.join("hf").join("org").join("model")));
        assert!(path.ends_with(Path::new("Q4").join("model.gguf")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn temporary_download_paths_are_unique_and_not_predictable_target_part_files() {
        let target = Path::new("C:/models/model.gguf");
        let first = temporary_download_path(target).expect("temporary path");
        let second = temporary_download_path(target).expect("temporary path");
        assert_ne!(first, second);
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".model.gguf."));
        assert!(first
            .extension()
            .is_some_and(|extension| extension == "part"));
    }

    #[test]
    fn repository_names_that_share_a_slug_get_distinct_directories() {
        let root =
            std::env::temp_dir().join(format!("llama-board-discover-{}", uuid::Uuid::new_v4()));
        let first = target_path(&root.to_string_lossy(), "a--b/c", "model.gguf").unwrap();
        let second = target_path(&root.to_string_lossy(), "a/b--c", "model.gguf").unwrap();
        assert_ne!(first, second);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn activation_is_no_replace_and_cleans_the_staging_file() {
        let root =
            std::env::temp_dir().join(format!("llama-board-activation-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create activation directory");
        let part = root.join("model.part");
        let target = root.join("model.gguf");
        fs::write(&part, b"downloaded").expect("write staged model");
        activate_download(&part, &target)
            .await
            .expect("activate staged model");
        assert_eq!(
            fs::read(&target).expect("read activated model"),
            b"downloaded"
        );
        assert!(!part.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn activation_rejects_an_existing_destination_without_overwrite() {
        let root =
            std::env::temp_dir().join(format!("llama-board-activation-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create activation directory");
        let part = root.join("model.part");
        let target = root.join("model.gguf");
        fs::write(&part, b"downloaded").expect("write staged model");
        fs::write(&target, b"existing").expect("write existing model");
        assert!(activate_download(&part, &target).await.is_err());
        assert_eq!(fs::read(&target).expect("read existing model"), b"existing");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_only_sha256_oids_for_verification() {
        assert_eq!(
            expected_sha256(Some(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into())
        );
        assert_eq!(expected_sha256(Some("git-oid")), None);
    }
}
