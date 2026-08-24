// src-tauri/src/models.rs
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_DEPTH: u32 = 8;
const MAX_MODELS: usize = 10_000;

#[derive(Serialize, Clone, Debug)]
pub struct GgufModel {
    pub name: String,
    pub path: String,
    pub size_mb: f64,
    pub is_vision: bool,
}

pub fn scan(models_dir: &str) -> Result<Vec<GgufModel>, String> {
    let root = Path::new(models_dir.trim());
    if models_dir.trim().is_empty() {
        return Err("models directory is empty".into());
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("cannot open models directory {}: {error}", root.display()))?;
    if !root.is_dir() {
        return Err(format!(
            "models path is not a directory: {}",
            root.display()
        ));
    }

    let mut models = Vec::new();
    let mut visited = HashSet::new();
    walk(&root, &mut models, &mut visited, 0)?;
    models.sort_by(|left, right| {
        right
            .size_mb
            .partial_cmp(&left.size_mb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.name.cmp(&right.name))
    });
    Ok(models)
}

fn walk(
    dir: &Path,
    models: &mut Vec<GgufModel>,
    visited: &mut HashSet<PathBuf>,
    depth: u32,
) -> Result<(), String> {
    if depth > MAX_DEPTH || models.len() >= MAX_MODELS {
        return Ok(());
    }
    let canonical = dir
        .canonicalize()
        .map_err(|error| format!("cannot read models directory {}: {error}", dir.display()))?;
    if !visited.insert(canonical.clone()) {
        return Ok(());
    }

    let entries = fs::read_dir(&canonical).map_err(|error| {
        format!(
            "cannot enumerate models directory {}: {error}",
            canonical.display()
        )
    })?;
    for entry in entries.flatten() {
        if models.len() >= MAX_MODELS {
            break;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            walk(&path, models, visited, depth + 1)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let is_gguf = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"));
        if !is_gguf {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        models.push(GgufModel {
            name: name.clone(),
            path: path.to_string_lossy().into_owned(),
            size_mb: metadata.len() as f64 / 1_048_576.0,
            is_vision: name.to_ascii_lowercase().contains("mmproj"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn scan_reports_missing_directory_instead_of_empty_success() {
        let missing =
            std::env::temp_dir().join(format!("llama-board-missing-{}", std::process::id()));
        let result = scan(&missing.to_string_lossy());
        assert!(result.is_err());
    }

    #[test]
    fn scan_finds_nested_gguf_and_marks_mmproj() {
        let root = std::env::temp_dir().join(format!("llama-board-models-{}", std::process::id()));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create model directory");
        let mut model = fs::File::create(nested.join("model.GGUF")).expect("create model");
        model.write_all(b"fixture").expect("write model");
        let mut sidecar = fs::File::create(root.join("mmproj-test.gguf")).expect("create sidecar");
        sidecar.write_all(b"fixture").expect("write sidecar");

        let models = scan(&root.to_string_lossy()).expect("scan should succeed");
        assert_eq!(models.len(), 2);
        assert!(models.iter().any(|model| model.is_vision));
        let _ = fs::remove_dir_all(root);
    }
}
