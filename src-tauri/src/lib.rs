// llama-board backend — command handlers + managed state.
pub mod backends;
pub mod bench;
pub mod config;
mod discover;
mod gateway;
pub mod hardware;
mod mcp;
pub mod models;
pub mod runtime;
pub mod server;

pub use config::AppConfig;
pub use server::ErrBuf;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::fs;
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{Manager, RunEvent, State};
use uuid::Uuid;
use zip::ZipArchive;

const MAX_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EXTRACTED_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;

struct AppState {
    server: Arc<Mutex<server::ServerState>>,
    err: Arc<server::ErrBuf>,
    operation: Arc<tokio::sync::Mutex<()>>,
    bench_cancel: Arc<AtomicBool>,
    bench_pid: Arc<Mutex<Option<u32>>>,
    runtime_cancel: Arc<AtomicBool>,
    discover_cancel: Arc<AtomicBool>,
    gateway: Arc<Mutex<Option<gateway::GatewayHandle>>>,
    selected_image: Mutex<Option<PathBuf>>,
    selected_document: Mutex<Option<PathBuf>>,
    exiting: Arc<AtomicBool>,
}

#[tauri::command]
fn get_config() -> Result<config::AppConfig, String> {
    config::load_result()
}

#[tauri::command]
async fn save_config(
    state: State<'_, AppState>,
    cfg: config::AppConfig,
) -> Result<config::AppConfig, String> {
    let _operation = state.operation.lock().await;
    {
        let server = state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        if server.lifecycle.blocks_resource_change() && cfg.mmproj != server.mmproj {
            return Err("stop the server before changing the multimodal projector".into());
        }
    }
    config::save(&cfg)
}

#[tauri::command]
async fn list_models(models_dir: String) -> Result<models::ModelScan, String> {
    tokio::task::spawn_blocking(move || {
        let dir = if models_dir.trim().is_empty() {
            config::load_result()?.models_dir
        } else {
            models_dir
        };
        models::scan(&dir)
    })
    .await
    .map_err(|error| format!("model scan task failed: {error}"))?
}

#[cfg(windows)]
fn remove_verified_file(path: &Path, expected: &Path) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileDispositionInfo, GetFileInformationByHandle, SetFileInformationByHandle,
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let resolved_before = path
        .canonicalize()
        .map_err(|error| format!("cannot resolve model before deletion: {error}"))?;
    if resolved_before != expected {
        return Err("model path changed before deletion".into());
    }
    let wide_path: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "cannot open model for deletion: {}",
            std::io::Error::last_os_error()
        ));
    }
    let result = (|| {
        let mut file_info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(handle, &mut file_info) } == 0 {
            return Err(format!(
                "cannot inspect model before deletion: {}",
                std::io::Error::last_os_error()
            ));
        }
        if file_info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("model path must not be a reparse point".into());
        }
        let resolved_after = path
            .canonicalize()
            .map_err(|error| format!("cannot resolve model before deletion: {error}"))?;
        if resolved_after != expected {
            return Err("model path changed while it was being opened".into());
        }
        let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                handle,
                FileDispositionInfo,
                (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(format!(
                "cannot delete model file: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    })();
    unsafe { CloseHandle(handle) };
    result
}

#[cfg(not(windows))]
fn remove_verified_file(path: &Path, expected: &Path) -> Result<(), String> {
    let _file = open_verified_file(path, expected, "model")?;
    fs::remove_file(path).map_err(|error| format!("cannot delete model file: {error}"))
}

#[tauri::command]
async fn delete_model(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    if state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?
        .lifecycle
        .blocks_resource_change()
    {
        return Err("stop the server before deleting a model".into());
    }
    let cfg = config::load_result()?;
    let candidate = ensure_deletable_model_path(
        Path::new(&cfg.models_dir),
        Path::new(&path),
        &cfg.active_model,
        &cfg.mmproj,
    )?;
    if cfg.lora_adapters.iter().any(|adapter| {
        adapter.enabled
            && fs::canonicalize(&adapter.path)
                .ok()
                .is_some_and(|adapter_path| adapter_path == candidate)
    }) {
        return Err("select another configuration before deleting an enabled LoRA adapter".into());
    }
    remove_verified_file(&candidate, &candidate)
}

#[tauri::command]
fn pick_models_dir() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose a GGUF models directory")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn pick_lora_adapter() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose a LoRA adapter GGUF")
        .add_filter("GGUF adapter", &["gguf"])
        .pick_file()
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("gguf"))
        })
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn hf_search_models(query: String, limit: u32) -> Result<Vec<discover::HfModel>, String> {
    discover::search(&query, limit).await
}

#[tauri::command]
async fn hf_model_files(repo_id: String) -> Result<Vec<discover::HfFile>, String> {
    discover::files(&repo_id).await
}

#[tauri::command]
async fn hf_download_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    file_path: String,
    models_dir: String,
) -> Result<discover::DownloadedModel, String> {
    let _operation = state.operation.lock().await;
    state.discover_cancel.store(false, Ordering::Release);
    let root = if models_dir.trim().is_empty() {
        config::load_result()?.models_dir
    } else {
        models_dir
    };
    discover::download(
        app,
        &repo_id,
        &file_path,
        &root,
        state.discover_cancel.clone(),
    )
    .await
}

#[tauri::command]
fn hf_cancel_download(state: State<'_, AppState>) {
    state.discover_cancel.store(true, Ordering::Release);
}

#[tauri::command]
async fn mcp_list_servers(app: tauri::AppHandle) -> Result<Vec<mcp::McpServer>, String> {
    mcp::list(app).await
}

#[tauri::command]
async fn mcp_save_server(
    app: tauri::AppHandle,
    server: mcp::McpServer,
) -> Result<Vec<mcp::McpServer>, String> {
    mcp::save(app, server).await
}

#[tauri::command]
async fn mcp_remove_server(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<mcp::McpServer>, String> {
    mcp::remove(app, &id).await
}

#[tauri::command]
async fn mcp_list_tools(app: tauri::AppHandle, id: String) -> Result<Vec<mcp::McpTool>, String> {
    mcp::tools(app, &id).await
}

#[tauri::command]
async fn mcp_call_tool(
    app: tauri::AppHandle,
    id: String,
    name: String,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    mcp::call_tool(app, &id, &name, arguments).await
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[tauri::command]
fn pick_image(state: State<'_, AppState>) -> Option<String> {
    if let Ok(mut selected) = state.selected_image.lock() {
        *selected = None;
    }
    let path = rfd::FileDialog::new()
        .set_title("Choose an image for vision chat")
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .pick_file()?;
    let canonical = path.canonicalize().ok()?;
    image_mime_type(&canonical)?;
    let mut selected = state.selected_image.lock().ok()?;
    *selected = Some(canonical.clone());
    Some(canonical.to_string_lossy().into_owned())
}

fn document_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some(
            "txt"
                | "md"
                | "markdown"
                | "csv"
                | "json"
                | "log"
                | "xml"
                | "html"
                | "htm"
                | "yaml"
                | "yml"
                | "toml"
                | "ini"
                | "py"
                | "rs"
                | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "css"
                | "sql"
                | "sh"
                | "ps1"
                | "docx"
                | "pdf"
        )
    )
}

fn ensure_deletable_model_path(
    models_root: &Path,
    path: &Path,
    active_model: &str,
    active_mmproj: &str,
) -> Result<PathBuf, String> {
    let root = fs::canonicalize(models_root)
        .map_err(|error| format!("cannot resolve models root: {error}"))?;
    let candidate =
        fs::canonicalize(path).map_err(|error| format!("cannot resolve model path: {error}"))?;
    if !candidate.starts_with(&root) {
        return Err("model path must stay inside the configured models directory".into());
    }
    if !candidate.is_file() {
        return Err("model path is not a regular file".into());
    }
    if !matches!(
        candidate
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("gguf") | Some("mmproj")
    ) {
        return Err("only GGUF and mmproj files can be deleted".into());
    }
    for active in [active_model, active_mmproj] {
        if active.is_empty() {
            continue;
        }
        if let Ok(active_path) = fs::canonicalize(active) {
            if active_path == candidate {
                return Err(
                    "select another model/projector before deleting the active file".into(),
                );
            }
        }
    }
    Ok(candidate)
}

/// Validate a model/projector deletion request for non-GUI clients.
pub fn deletable_model_path(
    models_root: &Path,
    path: &Path,
    active_model: &str,
    active_mmproj: &str,
) -> Result<PathBuf, String> {
    ensure_deletable_model_path(models_root, path, active_model, active_mmproj)
}

fn xml_text(value: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    let mut tag = String::new();
    for character in value.chars() {
        match character {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let lower = tag.to_ascii_lowercase();
                if lower.starts_with("/w:p") || lower.starts_with("w:br") {
                    output.push('\n');
                } else if lower.starts_with("w:tab") {
                    output.push('\t');
                }
            }
            _ if in_tag => tag.push(character),
            '&' => output.push('&'),
            _ => output.push(character),
        }
    }
    output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

struct LimitedWriter {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl LimitedWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(limit.min(64 * 1024)),
            limit,
            exceeded: false,
        }
    }
}

impl Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = self.limit.saturating_sub(self.bytes.len());
        if bytes.len() > remaining {
            self.bytes.extend_from_slice(&bytes[..remaining]);
            self.exceeded = true;
            return Err(io::Error::other(
                "extracted document text exceeds the safety limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn extract_docx_text(bytes: &[u8]) -> Result<String, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("cannot read DOCX archive: {error}"))?;
    let document = archive
        .by_name("word/document.xml")
        .map_err(|error| format!("DOCX document.xml is missing: {error}"))?;
    if document.size() > MAX_DOCUMENT_BYTES {
        return Err("DOCX document.xml exceeds the 8 MiB safety limit".into());
    }
    let mut xml = String::new();
    document
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_string(&mut xml)
        .map_err(|error| format!("cannot read DOCX XML: {error}"))?;
    if xml.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("DOCX document.xml exceeds the 8 MiB safety limit".into());
    }
    Ok(xml_text(&xml))
}

fn extract_pdf_text(bytes: &[u8]) -> Result<String, String> {
    let mut document = pdf_extract::Document::load_mem(bytes)
        .map_err(|error| format!("cannot load PDF: {error}"))?;
    if document.is_encrypted() {
        document
            .decrypt("")
            .map_err(|error| format!("cannot decrypt PDF without a password: {error}"))?;
    }
    let mut writer = LimitedWriter::new(MAX_EXTRACTED_DOCUMENT_BYTES);
    let extraction = {
        let mut output = pdf_extract::PlainTextOutput::new(&mut writer as &mut dyn Write);
        pdf_extract::output_doc(&document, &mut output)
    };
    if writer.exceeded {
        return Err("extracted PDF text exceeds the 16 MiB safety limit".into());
    }
    extraction.map_err(|error| {
        format!("PDF text extraction failed; scanned/image-only PDFs need OCR: {error}")
    })?;
    Ok(String::from_utf8_lossy(&writer.bytes).into_owned())
}

fn extract_document_text(path: &Path, bytes: &[u8]) -> Result<String, String> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("docx") => extract_docx_text(bytes),
        Some("pdf") => extract_pdf_text(bytes),
        _ => {
            if bytes.contains(&0) {
                return Err(
                    "binary documents are not supported; choose a text, DOCX, or PDF document"
                        .into(),
                );
            }
            Ok(String::from_utf8_lossy(bytes).into_owned())
        }
    }
}

fn open_verified_file(path: &Path, expected: &Path, label: &str) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("cannot open {label}: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("cannot inspect {label}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("{label} must not be a reparse point"));
        }
    }
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("cannot resolve {label}: {error}"))?;
    if resolved != expected {
        return Err(format!("{label} changed while it was being opened"));
    }
    Ok(file)
}

#[tauri::command]
fn pick_document(state: State<'_, AppState>) -> Option<String> {
    if let Ok(mut selected) = state.selected_document.lock() {
        *selected = None;
    }
    let path = rfd::FileDialog::new()
        .set_title("Choose a document for offline chat")
        .add_filter(
            "Documents",
            &[
                "txt", "md", "markdown", "csv", "json", "log", "xml", "html", "htm", "yaml", "yml",
                "toml", "ini", "py", "rs", "ts", "tsx", "js", "jsx", "css", "sql", "sh", "ps1",
                "docx", "pdf",
            ],
        )
        .pick_file()?;
    let canonical = path.canonicalize().ok()?;
    if !document_extension(&canonical) {
        return None;
    }
    let mut selected = state.selected_document.lock().ok()?;
    *selected = Some(canonical.clone());
    Some(canonical.to_string_lossy().into_owned())
}

fn ensure_selected_document_path(
    selected: Option<&Path>,
    requested: &Path,
) -> Result<PathBuf, String> {
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("cannot read document: {error}"))?;
    if selected != Some(canonical.as_path()) {
        return Err("document path was not selected by the native picker".into());
    }
    if !document_extension(&canonical) {
        return Err("unsupported document type; choose a text, DOCX, or PDF document".into());
    }
    Ok(canonical)
}

fn ensure_document_binding_path(requested: &Path) -> Result<PathBuf, String> {
    if !requested.is_absolute() {
        return Err("persisted document bindings must use an absolute path".into());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("cannot read document binding: {error}"))?;
    if !document_extension(&canonical) {
        return Err("unsupported document type; choose a text, DOCX, or PDF document".into());
    }
    let metadata = fs::symlink_metadata(&canonical)
        .map_err(|error| format!("cannot inspect document binding: {error}"))?;
    if !metadata.is_file() {
        return Err("document binding is not a regular file".into());
    }
    Ok(canonical)
}

async fn read_document_path(canonical: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let file = open_verified_file(&canonical, &canonical, "document")?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("cannot inspect document: {error}"))?;
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err("document exceeds the 8 MiB limit".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_DOCUMENT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read document: {error}"))?;
        if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err("document exceeds the 8 MiB limit".into());
        }
        let text = extract_document_text(&canonical, &bytes)?;
        if text.trim().is_empty() {
            return Err(
                "document has no extractable text; scanned/image-only PDFs need OCR".into(),
            );
        }
        if text.len() > MAX_EXTRACTED_DOCUMENT_BYTES {
            return Err("extracted document text exceeds the 16 MiB safety limit".into());
        }
        Ok(text)
    })
    .await
    .map_err(|error| format!("document read task failed: {error}"))?
}

#[tauri::command]
async fn read_document_text(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let canonical = {
        let mut selected = state
            .selected_document
            .lock()
            .map_err(|_| "document selection state was poisoned".to_string())?;
        let canonical = ensure_selected_document_path(selected.as_deref(), Path::new(path.trim()))?;
        *selected = None;
        canonical
    };
    read_document_path(canonical).await
}

#[tauri::command]
async fn read_document_binding(path: String) -> Result<String, String> {
    let canonical = ensure_document_binding_path(Path::new(path.trim()))?;
    read_document_path(canonical).await
}

fn ensure_selected_image_path(
    selected: Option<&Path>,
    requested: &Path,
) -> Result<PathBuf, String> {
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("cannot read image: {error}"))?;
    if selected != Some(canonical.as_path()) {
        return Err("image path was not selected by the native picker".into());
    }
    Ok(canonical)
}

#[tauri::command]
async fn read_image_data(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let canonical = {
        let mut selected = state
            .selected_image
            .lock()
            .map_err(|_| "image selection state was poisoned".to_string())?;
        let canonical = ensure_selected_image_path(selected.as_deref(), Path::new(path.trim()))?;
        *selected = None;
        canonical
    };
    tokio::task::spawn_blocking(move || {
        let mime = image_mime_type(&canonical)
            .ok_or_else(|| "unsupported image type; use PNG, JPEG, or WebP".to_string())?;
        let file = open_verified_file(&canonical, &canonical, "image")?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("cannot inspect image: {error}"))?;
        const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
        if metadata.len() > MAX_IMAGE_BYTES {
            return Err("image exceeds the 20 MiB limit".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read image: {error}"))?;
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err("image exceeds the 20 MiB limit".into());
        }
        Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
    })
    .await
    .map_err(|error| format!("image read task failed: {error}"))?
}

fn validate_start_config(cfg: &mut config::AppConfig) -> Result<(), String> {
    cfg.normalize();
    cfg.validate()?;
    if cfg.active_model.trim().is_empty() {
        return Err("select a GGUF model before starting the server".into());
    }
    validate_adapter_file(&cfg.active_model, "model", &["gguf"])?;
    if !cfg.mmproj.trim().is_empty() {
        validate_adapter_file(&cfg.mmproj, "projector", &["gguf", "mmproj"])?;
    }
    for adapter in cfg.lora_adapters.iter().filter(|adapter| adapter.enabled) {
        validate_adapter_file(&adapter.path, "LoRA adapter", &["gguf"])?;
    }
    if !cfg.active_backend.is_empty() {
        runtime::validate_runtime_identifiers(&cfg.active_backend, &cfg.active_build)?;
    }
    Ok(())
}

pub async fn validate_launch_config(cfg: &mut config::AppConfig) -> Result<(), String> {
    validate_start_config(cfg)?;
    if !cfg.active_backend.is_empty() {
        let capabilities = runtime::probe(&cfg.active_backend, &cfg.active_build).await?;
        validate_runtime_adapter_capabilities(cfg, &capabilities)?;
    }
    Ok(())
}

fn validate_adapter_file(path: &str, label: &str, extensions: &[&str]) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!("{label} file does not exist or is unreadable: {path} ({error})")
    })?;
    if !metadata.is_file() {
        return Err(format!("{label} path is not a regular file: {path}"));
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    if !extension
        .as_deref()
        .is_some_and(|value| extensions.contains(&value))
    {
        return Err(format!(
            "{label} must use one of [{}]: {path}",
            extensions.join(", ")
        ));
    }
    Ok(())
}

fn runtime_has_flag(capabilities: &runtime::RuntimeCapabilities, aliases: &[&str]) -> bool {
    aliases.iter().any(|alias| {
        capabilities.flags.iter().any(|flag| {
            flag == alias || flag.split_once('=').is_some_and(|(name, _)| name == *alias)
        })
    })
}

fn validate_runtime_adapter_capabilities(
    cfg: &config::AppConfig,
    capabilities: &runtime::RuntimeCapabilities,
) -> Result<(), String> {
    if capabilities.state != "available" {
        let details = capabilities.diagnostics.join("; ");
        return Err(format!(
            "selected runtime failed preflight ({}): {}",
            capabilities.state,
            if details.is_empty() {
                "no diagnostics"
            } else {
                &details
            }
        ));
    }
    if !cfg.mmproj.trim().is_empty() && !runtime_has_flag(capabilities, &["--mmproj", "-mm"]) {
        return Err("selected runtime does not expose an mmproj/projector flag".into());
    }
    if cfg.lora_adapters.iter().any(|adapter| adapter.enabled)
        && !runtime_has_flag(capabilities, &["--lora"])
    {
        return Err("selected runtime does not expose the --lora flag".into());
    }
    if cfg
        .lora_adapters
        .iter()
        .any(|adapter| adapter.enabled && (adapter.scale - 1.0).abs() >= f32::EPSILON)
        && !runtime_has_flag(capabilities, &["--lora-scaled"])
    {
        return Err("a scaled LoRA adapter requires the runtime --lora-scaled flag".into());
    }
    Ok(())
}

#[tauri::command]
async fn start_server(
    state: State<'_, AppState>,
    cfg: config::AppConfig,
) -> Result<String, String> {
    let _operation = state.operation.lock().await;
    if state.exiting.load(Ordering::Acquire) {
        return Err("application is exiting".into());
    }
    let mut next = cfg;
    validate_launch_config(&mut next).await?;
    let saved = config::save(&next)?;
    abort_gateway_now(&state);

    {
        let mut server = state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        server.lifecycle = server::Lifecycle::Starting;
        server.last_error = None;
        server.url.clear();
        server.api_key.clear();
        server.redaction_secret.clear();
        server.model.clear();
        server.mmproj.clear();
        server::kill(&mut server.child, Some(state.err.clone()));
    }
    state.err.clear();

    let api_key = format!("lb-{}", Uuid::new_v4().simple());
    let (child, url, api_key_file) = match server::spawn(&saved, &api_key, &state.err) {
        Ok(value) => value,
        Err(error) => {
            let mut server = state
                .server
                .lock()
                .map_err(|_| "server state lock was poisoned".to_string())?;
            server.lifecycle = if state.exiting.load(Ordering::Acquire) {
                server::Lifecycle::Stopped
            } else {
                server::Lifecycle::Failed
            };
            server.last_error = Some(error.clone());
            return Err(error);
        }
    };

    {
        let mut server = state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        if state.exiting.load(Ordering::Acquire) {
            let mut orphan = Some(child);
            server::kill(&mut orphan, Some(state.err.clone()));
            server::cleanup_api_key_file(api_key_file.as_deref());
            server.lifecycle = server::Lifecycle::Stopped;
            server.url.clear();
            server.api_key.clear();
            server.redaction_secret.clear();
            server.model.clear();
            server.mmproj.clear();
            return Err("application is exiting".into());
        }
        server.attach_starting(
            child,
            url.clone(),
            api_key.clone(),
            saved.active_model.clone(),
            saved.mmproj.clone(),
        );
    }

    match server::wait_ready(state.server.clone(), &url, &api_key, 120, &state.err).await {
        Ok(()) => {
            let mut server = state
                .server
                .lock()
                .map_err(|_| "server state lock was poisoned".to_string())?;
            if state.exiting.load(Ordering::Acquire) {
                server::kill(&mut server.child, Some(state.err.clone()));
                server::cleanup_api_key_file(api_key_file.as_deref());
                server.url.clear();
                server.api_key.clear();
                server.redaction_secret.clear();
                server.mmproj.clear();
                server.lifecycle = server::Lifecycle::Stopped;
                return Err("application is exiting".into());
            }
            server.lifecycle = server::Lifecycle::Ready;
            server.last_error = None;
            server.touch_activity();
            server::cleanup_api_key_file(api_key_file.as_deref());
            Ok(url)
        }
        Err(error) => {
            let mut server = state
                .server
                .lock()
                .map_err(|_| "server state lock was poisoned".to_string())?;
            server::kill(&mut server.child, None);
            server::cleanup_api_key_file(api_key_file.as_deref());
            server.url = url;
            server.api_key.clear();
            server.mmproj.clear();
            server.lifecycle = if state.exiting.load(Ordering::Acquire) {
                server.url.clear();
                server::Lifecycle::Stopped
            } else {
                server::Lifecycle::Failed
            };
            server.last_error = Some(error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
async fn stop_server(state: State<'_, AppState>) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    let gateway = state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?
        .take();
    if let Some(gateway) = gateway {
        gateway::stop(gateway).await;
    }
    {
        let mut server = state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        server.lifecycle = server::Lifecycle::Stopping;
        server::kill(&mut server.child, Some(state.err.clone()));
        server.url.clear();
        server.api_key.clear();
        server.redaction_secret.clear();
        server.model.clear();
        server.mmproj.clear();
        server.last_error = None;
        server.active_requests = 0;
        server.touch_activity();
        server.lifecycle = server::Lifecycle::Stopped;
    }
    Ok(())
}

#[tauri::command]
async fn unload_model(state: State<'_, AppState>) -> Result<(), String> {
    // llama-server is configured as a single-model process in this app. A
    // safe unload tears down the process instead of claiming the model remains resident.
    stop_server(state).await
}

#[tauri::command]
async fn start_anthropic_gateway(state: State<'_, AppState>) -> Result<String, String> {
    let _operation = state.operation.lock().await;
    let old = state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?
        .take();
    if let Some(handle) = old {
        gateway::stop(handle).await;
    }
    let (upstream, upstream_key) = {
        let server = state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        if server.lifecycle != server::Lifecycle::Ready
            || server.url.is_empty()
            || server.api_key.is_empty()
        {
            return Err("start llama-server before enabling the Anthropic gateway".into());
        }
        (server.url.clone(), server.api_key.clone())
    };
    let handle = gateway::start(upstream, upstream_key).await?;
    let url = format!("http://127.0.0.1:{}/v1/messages", handle.port);
    state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?
        .replace(handle);
    Ok(url)
}

#[tauri::command]
async fn stop_anthropic_gateway(state: State<'_, AppState>) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    let handle = state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?
        .take();
    if let Some(handle) = handle {
        gateway::stop(handle).await;
    }
    Ok(())
}

#[tauri::command]
fn anthropic_gateway_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let gateway = state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?;
    Ok(serde_json::json!({
        "running": gateway.is_some(),
        "url": gateway.as_ref().map(|handle| format!("http://127.0.0.1:{}/v1/messages", handle.port)),
    }))
}

fn abort_gateway_now(state: &AppState) {
    if let Ok(mut gateway) = state.gateway.lock() {
        if let Some(handle) = gateway.take() {
            handle.stop.store(true, Ordering::Release);
            handle.task.abort();
        }
    }
}

#[tauri::command]
async fn server_activity(state: State<'_, AppState>, phase: String) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    let mut server = state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?;
    if server.lifecycle != server::Lifecycle::Ready {
        return Err("server is not ready for activity tracking".into());
    }
    match phase.as_str() {
        "start" => server.begin_request(),
        "end" => server.end_request(),
        "touch" => server.touch_activity(),
        _ => return Err("server activity phase must be start, end, or touch".into()),
    }
    Ok(())
}

async fn unload_idle_server(state: &AppState) -> bool {
    let _operation = state.operation.lock().await;
    let Some(cfg) = config::load_result().ok() else {
        return false;
    };
    let (gateway_running, gateway_active) = {
        let gateway = state.gateway.lock().ok();
        (
            gateway.as_ref().is_some_and(|value| value.is_some()),
            gateway
                .as_ref()
                .and_then(|value| {
                    value
                        .as_ref()
                        .map(|handle| handle.active_requests.load(Ordering::Acquire))
                })
                .unwrap_or(0),
        )
    };
    let should_unload = {
        let Ok(mut server) = state.server.lock() else {
            return false;
        };
        if server.lifecycle != server::Lifecycle::Ready
            || gateway_running
            || gateway_active > 0
            || !server.auto_unload_due(cfg.sleep_idle_seconds)
        {
            return false;
        }
        server.lifecycle = server::Lifecycle::Stopping;
        server::kill(&mut server.child, Some(state.err.clone()));
        server.url.clear();
        server.api_key.clear();
        server.redaction_secret.clear();
        server.model.clear();
        server.mmproj.clear();
        server.active_requests = 0;
        server.touch_activity();
        server.last_error = None;
        server.lifecycle = server::Lifecycle::Stopped;
        true
    };
    if !should_unload {
        return false;
    }
    let gateway = state
        .gateway
        .lock()
        .ok()
        .and_then(|mut gateway| gateway.take());
    state.err.clear();
    if let Some(gateway) = gateway {
        gateway::stop(gateway).await;
    }
    true
}

async fn idle_watchdog(app: tauri::AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let Some(state) = app.try_state::<AppState>() else {
            break;
        };
        if state.exiting.load(Ordering::Acquire) {
            break;
        }
        let _ = unload_idle_server(&state).await;
    }
}

#[tauri::command]
fn server_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut server = state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?;
    if server.lifecycle == server::Lifecycle::Ready {
        let exited = match server.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(status) => status,
                Err(error) => {
                    let tail = state.err.tail();
                    server::kill(&mut server.child, Some(state.err.clone()));
                    server.api_key.clear();
                    server.redaction_secret.clear();
                    server.mmproj.clear();
                    server.lifecycle = server::Lifecycle::Crashed;
                    server.last_error = Some(if tail.trim().is_empty() {
                        format!("failed to inspect server process: {error}")
                    } else {
                        format!("failed to inspect server process: {error}. {}", tail.trim())
                    });
                    None
                }
            },
            None => Some(std::process::ExitStatus::default()),
        };
        if let Some(status) = exited {
            server.child = None;
            server.api_key.clear();
            server.redaction_secret.clear();
            server.mmproj.clear();
            server.lifecycle = server::Lifecycle::Crashed;
            let tail = state.err.tail();
            let code = status
                .code()
                .map(|value| value.to_string())
                .unwrap_or_else(|| "signal".into());
            server.last_error = Some(if tail.trim().is_empty() {
                format!("llama-server exited unexpectedly ({code})")
            } else {
                format!("llama-server exited unexpectedly ({code}). {}", tail.trim())
            });
        }
    }

    let mut response = serde_json::Map::new();
    response.insert("state".into(), server.lifecycle.as_str().into());
    response.insert("active_requests".into(), server.active_requests.into());
    response.insert("idle_seconds".into(), server.idle_seconds().into());
    if !server.url.is_empty() {
        response.insert("url".into(), server.url.clone().into());
    }
    if !server.model.is_empty() {
        response.insert("model".into(), server.model.clone().into());
    }
    if server.lifecycle == server::Lifecycle::Ready && !server.api_key.is_empty() {
        response.insert("api_key".into(), server.api_key.clone().into());
        if !server.mmproj.is_empty() {
            response.insert("mmproj".into(), server.mmproj.clone().into());
        }
    }
    if let Some(child) = server.child.as_ref() {
        response.insert("pid".into(), child.id().into());
    }
    let log_tail = state.err.tail();
    if !log_tail.trim().is_empty() {
        response.insert("log_tail".into(), log_tail.into());
    }
    if let Some(error) = &server.last_error {
        response.insert(
            "error".into(),
            server::redact_text(error, &server.redaction_secret).into(),
        );
    }
    if let Ok(cfg) = config::load_result() {
        response.insert(
            "memory".into(),
            serde_json::to_value(server::estimate_memory(&cfg, &server.model, &server.mmproj))
                .unwrap_or(serde_json::Value::Null),
        );
        response.insert(
            "lifecycle".into(),
            serde_json::json!({
                "sleep_idle_seconds": cfg.sleep_idle_seconds,
                "request_timeout_seconds": cfg.request_timeout_seconds,
                "parallel": cfg.parallel,
                "active_requests": server.active_requests,
                "idle_seconds": server.idle_seconds(),
                "auto_unload_due": server.auto_unload_due(cfg.sleep_idle_seconds),
                "effective_model": if server.model.is_empty() { serde_json::Value::Null } else { server.model.clone().into() },
                "effective_backend": if cfg.active_backend.is_empty() { serde_json::Value::Null } else { cfg.active_backend.into() },
            }),
        );
    }
    if server.lifecycle == server::Lifecycle::Crashed {
        abort_gateway_now(&state);
    }
    Ok(response.into())
}

#[tauri::command]
async fn run_bench(
    state: State<'_, AppState>,
    mut cfg: config::AppConfig,
) -> Result<bench::BenchResult, String> {
    let _operation = state.operation.lock().await;
    cfg.normalize();
    cfg.validate()?;
    if cfg.active_model.trim().is_empty() || !Path::new(&cfg.active_model).is_file() {
        return Err("select an existing GGUF model before benchmarking".into());
    }
    if state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?
        .lifecycle
        .blocks_resource_change()
    {
        return Err("stop the server before running a benchmark".into());
    }
    state.bench_cancel.store(false, Ordering::Release);
    let cancel = state.bench_cancel.clone();
    let active_pid = state.bench_pid.clone();
    let result = tokio::task::spawn_blocking(move || bench::run(&cfg, cancel, Some(active_pid)))
        .await
        .map_err(|error| format!("benchmark task failed: {error}"))?;
    state.bench_cancel.store(false, Ordering::Release);
    result
}

#[tauri::command]
fn bench_cancel(state: State<'_, AppState>) {
    state.bench_cancel.store(true, Ordering::Release);
    if let Ok(pid) = state.bench_pid.lock() {
        if let Some(pid) = *pid {
            bench::terminate_pid(pid);
        }
    }
}

/// Local hardware plus the backend verdicts derived from it. Detection is a
/// handful of registry reads, so it is recomputed per call rather than cached
/// into staleness when a GPU or driver changes.
#[tauri::command]
fn device_profile() -> DeviceReport {
    let profile = hardware::detect();
    let backends = backends::recommend(&profile);
    DeviceReport { profile, backends }
}

#[derive(serde::Serialize)]
struct DeviceReport {
    profile: hardware::DeviceProfile,
    backends: Vec<backends::BackendSuitability>,
}

#[tauri::command]
async fn rt_list(state: State<'_, AppState>) -> Result<Vec<runtime::InstalledRuntime>, String> {
    let _operation = state.operation.lock().await;
    tokio::task::spawn_blocking(runtime::list_installed)
        .await
        .map_err(|error| format!("runtime list task failed: {error}"))
}

#[tauri::command]
async fn rt_latest(
    state: State<'_, AppState>,
    backend: String,
    refresh: bool,
) -> Result<runtime::LatestInfo, String> {
    let _operation = state.operation.lock().await;
    if refresh {
        runtime::clear_api_cache();
    }
    runtime::latest_for(&backend).await
}

#[tauri::command]
async fn rt_install(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    backend: String,
    build: String,
) -> Result<runtime::InstalledRuntime, String> {
    let _operation = state.operation.lock().await;
    if state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?
        .lifecycle
        .blocks_resource_change()
    {
        return Err("stop the server before changing runtimes".into());
    }
    runtime::validate_runtime_identifiers(&backend, &build)?;
    state.runtime_cancel.store(false, Ordering::Release);
    runtime::install(app, &backend, &build, state.runtime_cancel.clone()).await
}

#[tauri::command]
fn rt_cancel(state: State<'_, AppState>) {
    state.runtime_cancel.store(true, Ordering::Release);
}

#[tauri::command]
async fn rt_uninstall(
    state: State<'_, AppState>,
    backend: String,
    build: String,
) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    if state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?
        .lifecycle
        .blocks_resource_change()
    {
        return Err("stop the server before changing runtimes".into());
    }
    let cfg = config::load_result()?;
    if cfg.active_backend == backend && cfg.active_build == build {
        return Err("select another runtime before uninstalling the active runtime".into());
    }
    tokio::task::spawn_blocking(move || runtime::uninstall(&backend, &build))
        .await
        .map_err(|error| format!("runtime uninstall task failed: {error}"))?
}

#[tauri::command]
async fn rt_select(
    state: State<'_, AppState>,
    backend: String,
    build: String,
) -> Result<config::AppConfig, String> {
    let _operation = state.operation.lock().await;
    if state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?
        .lifecycle
        .blocks_resource_change()
    {
        return Err("stop the server before selecting a different runtime".into());
    }
    runtime::validate_runtime_identifiers(&backend, &build)?;
    let server = runtime::server_bin_for(&backend, &build)?;
    let bench = runtime::bench_bin_for(&backend, &build)?;
    if !server.is_file() || !bench.is_file() {
        return Err("the selected runtime is not installed completely".into());
    }
    let mut cfg = config::load_result()?;
    cfg.active_backend = backend;
    cfg.active_build = build;
    config::save(&cfg)
}

#[tauri::command]
async fn rt_probe(
    state: State<'_, AppState>,
    backend: String,
    build: String,
) -> Result<runtime::RuntimeCapabilities, String> {
    let _operation = state.operation.lock().await;
    runtime::probe(&backend, &build).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState {
            server: Arc::new(Mutex::new(server::ServerState::default())),
            err: Arc::new(server::ErrBuf::default()),
            operation: Arc::new(tokio::sync::Mutex::new(())),
            bench_cancel: Arc::new(AtomicBool::new(false)),
            bench_pid: Arc::new(Mutex::new(None)),
            runtime_cancel: Arc::new(AtomicBool::new(false)),
            discover_cancel: Arc::new(AtomicBool::new(false)),
            gateway: Arc::new(Mutex::new(None)),
            selected_image: Mutex::new(None),
            selected_document: Mutex::new(None),
            exiting: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            list_models,
            delete_model,
            pick_models_dir,
            pick_lora_adapter,
            hf_search_models,
            hf_model_files,
            hf_download_model,
            hf_cancel_download,
            mcp_list_servers,
            mcp_save_server,
            mcp_remove_server,
            mcp_list_tools,
            mcp_call_tool,
            pick_document,
            read_document_text,
            read_document_binding,
            pick_image,
            read_image_data,
            start_server,
            stop_server,
            unload_model,
            start_anthropic_gateway,
            stop_anthropic_gateway,
            anthropic_gateway_status,
            server_activity,
            server_status,
            run_bench,
            bench_cancel,
            rt_list,
            rt_latest,
            rt_install,
            rt_cancel,
            rt_uninstall,
            device_profile,
            rt_select,
            rt_probe
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    tauri::async_runtime::spawn(idle_watchdog(app.handle().clone()));

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.exiting.store(true, Ordering::Release);
                state.bench_cancel.store(true, Ordering::Release);
                state.runtime_cancel.store(true, Ordering::Release);
                state.discover_cancel.store(true, Ordering::Release);
                if let Ok(mut gateway) = state.gateway.lock() {
                    if let Some(handle) = gateway.take() {
                        handle.stop.store(true, Ordering::Release);
                        handle.task.abort();
                    }
                }
                if let Ok(pid) = state.bench_pid.lock() {
                    if let Some(pid) = *pid {
                        bench::terminate_pid(pid);
                    }
                }
                if let Ok(mut server) = state.server.lock() {
                    server::kill(&mut server.child, Some(state.err.clone()));
                    server.lifecycle = server::Lifecycle::Stopped;
                    server.api_key.clear();
                    server.redaction_secret.clear();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        document_extension, ensure_deletable_model_path, ensure_selected_document_path,
        ensure_selected_image_path, image_mime_type, validate_runtime_adapter_capabilities,
        validate_start_config, xml_text, LimitedWriter, MAX_DOCUMENT_BYTES,
    };
    use crate::config;
    use crate::runtime;
    use std::fs;
    use std::io::Write;
    use std::path::Path;

    #[test]
    fn image_mime_type_accepts_supported_formats_only() {
        assert_eq!(image_mime_type(Path::new("photo.PNG")), Some("image/png"));
        assert_eq!(image_mime_type(Path::new("photo.jpeg")), Some("image/jpeg"));
        assert_eq!(image_mime_type(Path::new("photo.webp")), Some("image/webp"));
        assert_eq!(image_mime_type(Path::new("photo.svg")), None);
    }

    #[test]
    fn image_read_requires_the_path_returned_by_the_native_picker() {
        let root =
            std::env::temp_dir().join(format!("llama-board-image-path-{}", std::process::id()));
        fs::create_dir_all(&root).expect("create image test directory");
        let selected = root.join("selected.png");
        let other = root.join("other.png");
        fs::write(&selected, b"selected").expect("write selected image");
        fs::write(&other, b"other").expect("write other image");
        let canonical = selected
            .canonicalize()
            .expect("canonicalize selected image");

        assert!(ensure_selected_image_path(Some(&canonical), &selected).is_ok());
        assert!(ensure_selected_image_path(Some(&canonical), &other).is_err());
        assert!(ensure_selected_image_path(None, &selected).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verified_file_open_requires_a_regular_file_and_matching_identity() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-verified-file-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create verified file directory");
        let file_path = root.join("safe.txt");
        fs::write(&file_path, b"safe").expect("write verified file");
        let canonical = file_path
            .canonicalize()
            .expect("canonicalize verified file");
        assert!(super::open_verified_file(&canonical, &canonical, "document").is_ok());
        assert!(super::open_verified_file(&root, &root, "document").is_err());
        assert!(super::open_verified_file(&file_path, &root, "document").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn document_read_requires_native_selection_and_text_extension() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-document-path-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create document test directory");
        let selected = root.join("selected.md");
        let other = root.join("other.md");
        let binary = root.join("binary.exe");
        fs::write(&selected, b"selected").expect("write selected document");
        fs::write(&other, b"other").expect("write other document");
        fs::write(&binary, b"binary").expect("write binary document");
        let canonical = selected
            .canonicalize()
            .expect("canonicalize selected document");

        assert!(document_extension(&selected));
        assert!(document_extension(Path::new("manual.docx")));
        assert!(document_extension(Path::new("manual.PDF")));
        assert!(!document_extension(&binary));
        assert!(ensure_selected_document_path(Some(&canonical), &selected).is_ok());
        assert!(ensure_selected_document_path(Some(&canonical), &other).is_err());
        assert!(ensure_selected_document_path(None, &selected).is_err());
        assert!(ensure_selected_document_path(Some(&canonical), &binary).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn docx_xml_text_preserves_paragraphs_tabs_and_entities() {
        let xml = r#"<w:document><w:p><w:r><w:t>A &amp; B</w:t><w:tab/><w:t>C</w:t></w:r></w:p><w:p><w:t>Next</w:t></w:p></w:document>"#;
        assert_eq!(xml_text(xml), "A & B\tC\nNext\n");
    }

    #[test]
    fn limited_document_writer_stops_before_unbounded_growth() {
        let mut writer = LimitedWriter::new(4);
        assert!(writer.write_all(b"12345").is_err());
        assert_eq!(writer.bytes, b"1234");
        assert!(writer.exceeded);
    }

    #[test]
    fn docx_declared_uncompressed_xml_size_is_bounded() {
        let path = std::env::temp_dir().join(format!(
            "llama-board-docx-bomb-{}.docx",
            uuid::Uuid::new_v4()
        ));
        let file = fs::File::create(&path).expect("create DOCX fixture");
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        archive
            .start_file("word/document.xml", options)
            .expect("start document.xml");
        archive
            .write_all(&vec![b'x'; MAX_DOCUMENT_BYTES as usize + 1])
            .expect("write oversized XML");
        archive.finish().expect("finish DOCX fixture");
        let bytes = fs::read(&path).expect("read DOCX fixture");
        let error = super::extract_docx_text(&bytes).expect_err("oversized XML must be rejected");
        assert!(error.contains("8 MiB"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn model_delete_requires_root_containment_and_inactive_path() {
        let root =
            std::env::temp_dir().join(format!("llama-board-delete-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create model root");
        let model = root.join("nested").join("model.gguf");
        fs::create_dir_all(model.parent().unwrap()).expect("create nested model root");
        fs::write(&model, b"model").expect("write model");
        let canonical = model.canonicalize().expect("canonicalize model");
        assert!(ensure_deletable_model_path(&root, &model, "", "").is_ok());
        assert!(
            ensure_deletable_model_path(&root, &model, &canonical.to_string_lossy(), "").is_err()
        );
        assert!(ensure_deletable_model_path(&root, Path::new("outside.gguf"), "", "").is_err());
        assert!(ensure_deletable_model_path(&root, Path::new("nested/model.txt"), "", "").is_err());
        assert!(super::remove_verified_file(&canonical, &canonical).is_ok());
        assert!(!model.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn start_validation_rejects_missing_projector_and_enabled_adapter() {
        let root =
            std::env::temp_dir().join(format!("llama-board-adapter-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create adapter test directory");
        let model = root.join("model.gguf");
        fs::write(&model, b"model").expect("write model fixture");
        let invalid_model = root.join("model.bin");
        fs::write(&invalid_model, b"model").expect("write invalid model fixture");
        let mut invalid_cfg = config::AppConfig {
            active_model: invalid_model.to_string_lossy().into_owned(),
            ..config::AppConfig::default()
        };
        assert!(validate_start_config(&mut invalid_cfg)
            .unwrap_err()
            .contains("model must use"));
        let mut cfg = config::AppConfig {
            active_model: model.to_string_lossy().into_owned(),
            mmproj: root
                .join("missing-mmproj.gguf")
                .to_string_lossy()
                .into_owned(),
            ..config::AppConfig::default()
        };
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .contains("projector"));
        cfg.mmproj.clear();
        cfg.lora_adapters.push(config::LoraAdapterConfig {
            path: root
                .join("missing-lora.gguf")
                .to_string_lossy()
                .into_owned(),
            scale: 1.0,
            enabled: true,
        });
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .contains("LoRA"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_capability_gating_requires_adapter_flags() {
        let cfg = config::AppConfig {
            mmproj: "projector.gguf".into(),
            lora_adapters: vec![config::LoraAdapterConfig {
                path: "adapter.gguf".into(),
                scale: 0.5,
                enabled: true,
            }],
            ..config::AppConfig::default()
        };
        let mut capabilities = runtime::RuntimeCapabilities {
            backend: "vulkan".into(),
            build: "test".into(),
            executable: "llama-server".into(),
            state: "available".into(),
            version: "test".into(),
            flags: vec!["--mmproj".into(), "--lora".into()],
            devices: vec![],
            diagnostics: vec![],
            bench_available: true,
        };
        assert!(validate_runtime_adapter_capabilities(&cfg, &capabilities)
            .unwrap_err()
            .contains("lora-scaled"));
        capabilities.flags.push("--lora-scaled=PATH SCALE".into());
        assert!(validate_runtime_adapter_capabilities(&cfg, &capabilities).is_ok());
    }
}
