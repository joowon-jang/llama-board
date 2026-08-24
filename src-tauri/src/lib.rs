// llama-board backend — command handlers + managed state.
pub mod bench;
mod config;
mod models;
mod runtime;
pub mod server;

pub use config::AppConfig;
pub use server::ErrBuf;

use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, RunEvent, State};
use uuid::Uuid;

struct AppState {
    server: Arc<Mutex<server::ServerState>>,
    err: Arc<server::ErrBuf>,
    operation: Arc<tokio::sync::Mutex<()>>,
    bench_cancel: Arc<AtomicBool>,
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
    config::save(&cfg)
}

#[tauri::command]
async fn list_models(models_dir: String) -> Result<Vec<models::GgufModel>, String> {
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

#[tauri::command]
fn pick_models_dir() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose a GGUF models directory")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

fn validate_start_config(cfg: &mut config::AppConfig) -> Result<(), String> {
    cfg.normalize();
    cfg.validate()?;
    if cfg.active_model.trim().is_empty() {
        return Err("select a GGUF model before starting the server".into());
    }
    if !Path::new(&cfg.active_model).is_file() {
        return Err(format!("model file does not exist: {}", cfg.active_model));
    }
    if !cfg.active_backend.is_empty() {
        runtime::validate_runtime_identifiers(&cfg.active_backend, &cfg.active_build)?;
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
    validate_start_config(&mut next)?;
    let saved = config::save(&next)?;

    {
        let mut server = state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        server.lifecycle = server::Lifecycle::Starting;
        server.last_error = None;
        server.url.clear();
        server.api_key.clear();
        server::kill(&mut server.child, Some(state.err.clone()));
    }
    state.err.clear();

    let api_key = format!("lb-{}", Uuid::new_v4().simple());
    let (child, url) = match server::spawn(&saved, &api_key, &state.err) {
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
            server.lifecycle = server::Lifecycle::Stopped;
            server.url.clear();
            server.api_key.clear();
            return Err("application is exiting".into());
        }
        server.attach_starting(child, url.clone(), api_key.clone());
    }

    match server::wait_ready(state.server.clone(), &url, &api_key, 120, &state.err).await {
        Ok(()) => {
            let mut server = state
                .server
                .lock()
                .map_err(|_| "server state lock was poisoned".to_string())?;
            if state.exiting.load(Ordering::Acquire) {
                server::kill(&mut server.child, Some(state.err.clone()));
                server.url.clear();
                server.api_key.clear();
                server.lifecycle = server::Lifecycle::Stopped;
                return Err("application is exiting".into());
            }
            server.lifecycle = server::Lifecycle::Ready;
            server.last_error = None;
            Ok(url)
        }
        Err(error) => {
            let mut server = state
                .server
                .lock()
                .map_err(|_| "server state lock was poisoned".to_string())?;
            server::kill(&mut server.child, None);
            server.url = url;
            server.api_key.clear();
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
    let mut server = state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?;
    server.lifecycle = server::Lifecycle::Stopping;
    server::kill(&mut server.child, Some(state.err.clone()));
    server.url.clear();
    server.api_key.clear();
    server.last_error = None;
    server.lifecycle = server::Lifecycle::Stopped;
    Ok(())
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
    if !server.url.is_empty() {
        response.insert("url".into(), server.url.clone().into());
    }
    if server.lifecycle == server::Lifecycle::Ready && !server.api_key.is_empty() {
        response.insert("api_key".into(), server.api_key.clone().into());
    }
    if let Some(error) = &server.last_error {
        response.insert("error".into(), error.clone().into());
    }
    Ok(response.into())
}

#[tauri::command]
async fn run_bench(
    state: State<'_, AppState>,
    mut cfg: config::AppConfig,
) -> Result<Vec<bench::BenchRow>, String> {
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
    let result = tokio::task::spawn_blocking(move || bench::run(&cfg, cancel))
        .await
        .map_err(|error| format!("benchmark task failed: {error}"))?;
    state.bench_cancel.store(false, Ordering::Release);
    result
}

#[tauri::command]
fn bench_cancel(state: State<'_, AppState>) {
    state.bench_cancel.store(true, Ordering::Release);
}

#[tauri::command]
fn rt_list() -> Vec<runtime::InstalledRuntime> {
    runtime::list_installed()
}

#[tauri::command]
async fn rt_latest(backend: String) -> Result<runtime::LatestInfo, String> {
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
    runtime::install(app, &backend, &build).await
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
    runtime::uninstall(&backend, &build)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState {
            server: Arc::new(Mutex::new(server::ServerState::default())),
            err: Arc::new(server::ErrBuf::default()),
            operation: Arc::new(tokio::sync::Mutex::new(())),
            bench_cancel: Arc::new(AtomicBool::new(false)),
            exiting: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            list_models,
            pick_models_dir,
            start_server,
            stop_server,
            server_status,
            run_bench,
            bench_cancel,
            rt_list,
            rt_latest,
            rt_install,
            rt_uninstall,
            rt_select
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.exiting.store(true, Ordering::Release);
                state.bench_cancel.store(true, Ordering::Release);
                if let Ok(mut server) = state.server.lock() {
                    server::kill(&mut server.child, Some(state.err.clone()));
                    server.lifecycle = server::Lifecycle::Stopped;
                    server.api_key.clear();
                }
            }
        }
    });
}
