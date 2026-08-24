// llama-board backend — command handlers + managed state.
pub mod bench;
mod config;
mod models;
mod runtime;
pub mod server;

pub use config::AppConfig;
pub use server::ErrBuf;

use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, State};

/// Managed state shared across commands: one live server + its stderr ring.
struct AppState {
    server: Mutex<server::ServerState>,
    err: Arc<server::ErrBuf>,
}

// ---------- config ----------
#[tauri::command] fn get_config() -> config::AppConfig { config::load() }
#[tauri::command] fn save_config(cfg: config::AppConfig) -> Result<(), String> { config::save(&cfg) }

// ---------- models ----------
#[tauri::command] async fn list_models(models_dir: String) -> Result<Vec<models::GgufModel>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = if models_dir.trim().is_empty() { config::load().models_dir } else { models_dir };
        Ok(models::scan(&dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command] fn pick_models_dir() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose a GGUF models directory")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

// ---------- server ----------
#[tauri::command]
async fn start_server(state: State<'_, AppState>, cfg: config::AppConfig) -> Result<String, String> {
    config::save(&cfg).map_err(|e| e)?;
    // Replace any running server first (§0.6 #1: one server at a time) and reset the ring.
    {
        let mut s = state.server.lock().unwrap();
        server::kill(&mut s.child, Some(state.err.clone()));
        s.running = false;
    }
    // Drain into the shared managed ring so server_status can surface stderr on failure.
    state.err.clear();
    let (mut child, url, ring) = server::spawn(&cfg, &state.err)?;
    match server::wait_ready(&mut child, &url, 120, &ring).await {
        Ok(()) => {
            let mut s = state.server.lock().unwrap();
            s.child = Some(child);
            s.url = url.clone();
            s.running = true;
            Ok(url)
        }
        Err(e) => {
            // Keep stderr tail in the shared ring so server_status reports 'failed'.
            let mut s = state.server.lock().unwrap();
            s.running = false;
            s.child = None;
            Err(e)
        }
    }
}
#[tauri::command] fn stop_server(state: State<'_, AppState>) {
    let mut s = state.server.lock().unwrap();
    server::kill(&mut s.child, Some(state.err.clone()));
    s.running = false;
}
/// JSON status per §0.6: { state, url?, error? }; state ∈ stopped | running | failed.
#[tauri::command] fn server_status(state: State<'_, AppState>) -> serde_json::Value {
    let s = state.server.lock().unwrap();
    if s.running {
        serde_json::json!({ "state": "running", "url": s.url })
    } else if !s.url.is_empty() {
        let tail = state.err.tail();
        if !tail.is_empty() {
            serde_json::json!({ "state": "failed", "error": tail })
        } else {
            serde_json::json!({ "state": "stopped" })
        }
    } else {
        serde_json::json!({ "state": "stopped" })
    }
}

// ---------- benchmark ----------
#[tauri::command] async fn run_bench(cfg: config::AppConfig) -> Result<Vec<bench::BenchRow>, String> {
    tokio::task::spawn_blocking(move || bench::run(&cfg))
        .await
        .map_err(|e| e.to_string())?
}
/// v0.1: no-op (run_bench completes on its own). See §0.6 #4.
#[tauri::command] fn bench_cancel() {}

// ---------- runtime manager ----------
#[tauri::command] fn rt_list() -> Vec<runtime::InstalledRuntime> { runtime::list_installed() }
#[tauri::command] async fn rt_latest(backend: String) -> Result<runtime::LatestInfo, String> {
    runtime::latest_for(&backend).await
}
#[tauri::command] async fn rt_install(app: tauri::AppHandle, backend: String, build: String)
    -> Result<runtime::InstalledRuntime, String> {
    runtime::install(app, &backend, &build).await
}
#[tauri::command] fn rt_uninstall(backend: String, build: String) -> Result<(), String> {
    runtime::uninstall(&backend, &build)
}
#[tauri::command] fn rt_select(backend: String, build: String) -> Result<(), String> {
    let mut cfg = config::load();
    cfg.active_backend = backend;
    cfg.active_build = build;
    config::save(&cfg)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            server: Mutex::new(server::ServerState::new()),
            err: Arc::new(server::ErrBuf::default()),
        })
        .invoke_handler(tauri::generate_handler![
            get_config, save_config,
            list_models, pick_models_dir,
            start_server, stop_server, server_status,
            run_bench, bench_cancel,
            rt_list, rt_latest, rt_install, rt_uninstall, rt_select
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            // Clean up the managed llama-server when the app exits (§0.6 #3).
            if let Some(state) = app_handle.try_state::<AppState>() {
                let mut s = state.server.lock().unwrap();
                server::kill(&mut s.child, Some(state.err.clone()));
                s.running = false;
            }
        }
    });
}
