// src-tauri/src/models.rs
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
pub struct GgufModel {
    pub name: String,
    pub path: String,
    pub size_mb: f64,
    pub is_vision: bool, // mmproj / vision sidecar
}

pub fn scan(models_dir: &str) -> Vec<GgufModel> {
    let mut out = Vec::new();
    walk(Path::new(models_dir), &mut out, 0);
    out.sort_by(|a, b| b.size_mb.partial_cmp(&a.size_mb).unwrap_or(std::cmp::Ordering::Equal));
    out
}

fn walk(dir: &Path, out: &mut Vec<GgufModel>, depth: u32) {
    if depth > 6 { return; }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out, depth + 1);
        } else if p.extension().map(|x| x == "gguf").unwrap_or(false) {
            let size_mb = e.metadata().map(|m| m.len() as f64 / 1_048_576.0).unwrap_or(0.0);
            let fname = p.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
            out.push(GgufModel {
                name: fname.clone(),
                path: p.to_string_lossy().to_string(),
                size_mb,
                is_vision: fname.contains("mmproj"),
            });
        }
    }
}
