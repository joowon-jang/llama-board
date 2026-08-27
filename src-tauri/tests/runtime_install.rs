//! Exercises the real `runtime::install()` path against the live GitHub
//! release, including download, SHA-256 verification, extraction, the CUDA
//! sidecar and the staged preflight.
//!
//! Gated behind LLAMA_BOARD_RUNTIME_INSTALL=1 because it downloads hundreds of
//! megabytes and writes into the real app data directory.
//!
//! Run:
//!   $env:LLAMA_BOARD_RUNTIME_INSTALL = "1"
//!   cd src-tauri && cargo test --test runtime_install -- --nocapture --test-threads=1

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use llama_board_lib::runtime;

fn enabled() -> bool {
    std::env::var_os("LLAMA_BOARD_RUNTIME_INSTALL").is_some()
}

fn backends() -> Vec<String> {
    match std::env::var("LLAMA_BOARD_RUNTIME_BACKENDS") {
        Ok(list) => list
            .split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        Err(_) => vec!["vulkan".to_string()],
    }
}

#[test]
fn installs_each_requested_backend_end_to_end() {
    if !enabled() {
        eprintln!("[SKIP] Set LLAMA_BOARD_RUNTIME_INSTALL=1 to run the real runtime install test.");
        return;
    }
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");

    let mut failures = Vec::new();
    for backend in backends() {
        let result = runtime.block_on(async {
            let info = runtime::latest_for(&backend).await?;
            eprintln!(
                "[{backend}] latest={} asset={} digest={}",
                info.build,
                info.file_name,
                info.digest.as_deref().unwrap_or("<none>")
            );
            let sidecar = runtime::companion_asset_name(&info.build, &info.file_name);
            eprintln!("[{backend}] sidecar={sidecar:?}");
            runtime::install_with(
                &|phase, received, total| {
                    if phase != "downloading" || total > 0.0 {
                        eprintln!("[{backend}] {phase} {received:.0}/{total:.0}");
                    }
                },
                &backend,
                &info.build,
                Arc::new(AtomicBool::new(false)),
            )
            .await
        });
        match result {
            Ok(installed) => eprintln!(
                "[{backend}] OK {} ({:.1} MB) -> {}",
                installed.build, installed.size_mb, installed.dir
            ),
            Err(error) => {
                eprintln!("[{backend}] FAILED: {error}");
                failures.push(format!("{backend}: {error}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "runtime installs failed:\n{}",
        failures.join("\n")
    );
}
