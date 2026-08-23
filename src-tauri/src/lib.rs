use std::{
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Command, Stdio},
    sync::Arc,
    thread,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

mod gateway;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub mode: String,
    pub executable: String,
    pub model_path: String,
    pub mmproj_path: String,
    pub backend: String,
    pub device: String,
    pub gpu_layers: String,
    pub context_size: u32,
    pub batch_size: u32,
    pub ubatch_size: u32,
    pub cache_type_k: String,
    pub cache_type_v: String,
    pub flash_attn: String,
    pub kv_unified: bool,
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: i32,
    pub min_p: f32,
    pub presence_penalty: f32,
    pub repeat_penalty: f32,
    pub reasoning: bool,
    pub reasoning_effort: String,
    pub reasoning_preserve: bool,
    pub spec_type: String,
    pub spec_draft_n_max: u32,
    pub spec_draft_n_min: u32,
    pub host: String,
    pub port: u16,
    pub parallel: u32,
    pub ui: bool,
    pub extra_args: String,
    pub env_overrides: Vec<EnvVar>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandPreview {
    pub executable: String,
    pub args: Vec<String>,
    pub powershell: String,
    pub cmd: String,
    pub posix: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackendInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub status: String,
    pub devices: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvironmentSnapshot {
    pub platform: String,
    pub runtime_path: String,
    pub version: String,
    pub help_available: bool,
    pub devices: Vec<String>,
    pub backends: Vec<BackendInfo>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelpOption {
    pub flag: String,
    pub aliases: Vec<String>,
    pub section: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LaunchResult {
    pub pid: u32,
    pub command: CommandPreview,
}

fn default_profile() -> Profile {
    Profile {
        name: "Qwen3.8 27B · MTP medium".into(),
        mode: "server".into(),
        executable: "llama-server.exe".into(),
        model_path: String::new(),
        mmproj_path: String::new(),
        backend: "auto".into(),
        device: String::new(),
        gpu_layers: "all".into(),
        context_size: 65_536,
        batch_size: 2_048,
        ubatch_size: 256,
        cache_type_k: "q4_0".into(),
        cache_type_v: "q4_0".into(),
        flash_attn: "auto".into(),
        kv_unified: true,
        temperature: 1.0,
        top_p: 0.95,
        top_k: 20,
        min_p: 0.0,
        presence_penalty: 0.0,
        repeat_penalty: 1.0,
        reasoning: true,
        reasoning_effort: "medium".into(),
        reasoning_preserve: false,
        spec_type: "draft-mtp".into(),
        spec_draft_n_max: 4,
        spec_draft_n_min: 0,
        host: "127.0.0.1".into(),
        port: 8080,
        parallel: 1,
        ui: true,
        extra_args: String::new(),
        env_overrides: Vec::new(),
    }
}

fn find_executable(requested: &str) -> String {
    if requested.trim().is_empty() {
        return "llama-server.exe".into();
    }
    let path = Path::new(requested);
    if path.is_file() {
        return requested.into();
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for root in std::env::split_paths(&path_var) {
            let candidate = root.join(requested);
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    requested.into()
}

fn shell_quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn shell_quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn shell_quote_cmd(value: &str) -> String {
    if value.is_empty() || value.chars().any(|c| c.is_whitespace() || c == '"') {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

fn split_extra_args(input: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escape = false;

    for ch in input.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escape = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if ch.is_whitespace() {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if escape {
        current.push('\\');
    }
    if quote.is_some() {
        return Err("Advanced arguments contain an unterminated quote.".into());
    }
    if !current.is_empty() {
        result.push(current);
    }
    Ok(result)
}

fn build_args(profile: &Profile) -> Result<CommandPreview, String> {
    if profile.model_path.trim().is_empty() {
        return Err("Select a GGUF model before building the command.".into());
    }

    let executable = find_executable(&profile.executable);
    let mut args = vec!["--model".into(), profile.model_path.clone()];

    if profile.mode == "server" {
        args.extend(["--host".into(), profile.host.clone()]);
        args.extend(["--port".into(), profile.port.to_string()]);
        args.extend(["--parallel".into(), profile.parallel.max(1).to_string()]);
        if profile.ui {
            args.push("--ui".into());
        } else {
            args.push("--no-ui".into());
        }
    } else {
        args.push("--single-turn".into());
    }

    if !profile.device.trim().is_empty() {
        args.extend(["--device".into(), profile.device.clone()]);
    }
    if !profile.gpu_layers.trim().is_empty() {
        args.extend(["--gpu-layers".into(), profile.gpu_layers.clone()]);
    }
    if profile.context_size > 0 {
        args.extend(["--ctx-size".into(), profile.context_size.to_string()]);
    }
    if profile.batch_size > 0 {
        args.extend(["--batch-size".into(), profile.batch_size.to_string()]);
    }
    if profile.ubatch_size > 0 {
        args.extend(["--ubatch-size".into(), profile.ubatch_size.to_string()]);
    }
    if !profile.cache_type_k.trim().is_empty() {
        args.extend(["--cache-type-k".into(), profile.cache_type_k.clone()]);
    }
    if !profile.cache_type_v.trim().is_empty() {
        args.extend(["--cache-type-v".into(), profile.cache_type_v.clone()]);
    }
    if profile.flash_attn != "auto" {
        args.extend(["--flash-attn".into(), profile.flash_attn.clone()]);
    }
    if profile.kv_unified {
        args.push("--kv-unified".into());
    }

    args.extend(["--temperature".into(), profile.temperature.to_string()]);
    args.extend(["--top-p".into(), profile.top_p.to_string()]);
    args.extend(["--top-k".into(), profile.top_k.to_string()]);
    args.extend(["--min-p".into(), profile.min_p.to_string()]);
    args.extend([
        "--presence-penalty".into(),
        profile.presence_penalty.to_string(),
    ]);
    args.extend([
        "--repeat-penalty".into(),
        profile.repeat_penalty.to_string(),
    ]);

    if profile.reasoning {
        args.extend(["--reasoning".into(), "on".into()]);
    } else {
        args.extend(["--reasoning".into(), "off".into()]);
    }
    if !profile.reasoning_effort.trim().is_empty() && profile.reasoning_effort != "default" {
        args.extend([
            "--chat-template-kwargs".into(),
            json!({"reasoning_effort": profile.reasoning_effort}).to_string(),
        ]);
    }
    if profile.reasoning_preserve {
        args.push("--reasoning-preserve".into());
    }

    if profile.spec_type != "none" && !profile.spec_type.trim().is_empty() {
        args.extend(["--spec-type".into(), profile.spec_type.clone()]);
        if profile.spec_draft_n_max > 0 {
            args.extend([
                "--spec-draft-n-max".into(),
                profile.spec_draft_n_max.to_string(),
            ]);
        }
        if profile.spec_draft_n_min > 0 {
            args.extend([
                "--spec-draft-n-min".into(),
                profile.spec_draft_n_min.to_string(),
            ]);
        }
    }
    if !profile.mmproj_path.trim().is_empty() {
        args.extend(["--mmproj".into(), profile.mmproj_path.clone()]);
    }

    args.extend(split_extra_args(&profile.extra_args)?);

    let powershell = std::iter::once(shell_quote_powershell(&executable))
        .chain(args.iter().map(|arg| shell_quote_powershell(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    let cmd = std::iter::once(shell_quote_cmd(&executable))
        .chain(args.iter().map(|arg| shell_quote_cmd(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    let posix = std::iter::once(shell_quote_posix(&executable))
        .chain(args.iter().map(|arg| shell_quote_posix(arg)))
        .collect::<Vec<_>>()
        .join(" ");

    Ok(CommandPreview {
        executable,
        args,
        powershell,
        cmd,
        posix,
    })
}

fn command_output(executable: &str, args: &[&str]) -> (bool, String) {
    match Command::new(executable).args(args).output() {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            if text.trim().is_empty() {
                text = String::from_utf8_lossy(&output.stderr).into_owned();
            }
            (output.status.success(), text)
        }
        Err(error) => (false, error.to_string()),
    }
}

fn add_backend(
    backends: &mut Vec<BackendInfo>,
    id: &str,
    label: &str,
    device: &str,
    available: bool,
    status: &str,
) {
    if let Some(existing) = backends.iter_mut().find(|item| item.id == id) {
        if !device.is_empty() && !existing.devices.iter().any(|d| d == device) {
            existing.devices.push(device.into());
        }
        existing.available |= available;
        if available {
            existing.status = status.into();
        }
        return;
    }
    let devices = if device.is_empty() {
        Vec::new()
    } else {
        vec![device.into()]
    };
    backends.push(BackendInfo {
        id: id.into(),
        label: label.into(),
        available,
        status: status.into(),
        devices,
    });
}

fn detect_backends(device_text: &str) -> Vec<BackendInfo> {
    let lower = device_text.to_lowercase();
    let mut backends = Vec::new();
    add_backend(&mut backends, "cpu", "CPU", "none", true, "available");

    let families = [
        ("vulkan", "Vulkan", "vulkan"),
        ("cuda", "CUDA / cuBLAS", "cuda"),
        ("hip-rocm", "HIP / ROCm", "hip"),
        ("sycl", "SYCL / oneAPI", "sycl"),
        ("opencl", "OpenCL", "opencl"),
        ("metal", "Metal", "metal"),
    ];
    for (id, label, marker) in families {
        if lower.contains(marker) {
            for line in device_text.lines() {
                let line_lower = line.to_lowercase();
                if line_lower.contains(marker) {
                    let device = line.trim().to_string();
                    add_backend(&mut backends, id, label, &device, true, "available");
                }
            }
            if !backends.iter().any(|item| item.id == id) {
                add_backend(&mut backends, id, label, "", true, "reported by runtime");
            }
        }
    }
    backends
}

fn parse_help(executable: &str, help_text: &str) -> Vec<HelpOption> {
    let mut section = "General".to_string();
    let mut options = Vec::new();
    for line in help_text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("-----") {
            section = trimmed.trim_matches('-').trim().to_string();
            if section.is_empty() {
                section = "General".into();
            }
            continue;
        }
        if !trimmed.starts_with('-') || !trimmed.contains("--") {
            continue;
        }
        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        let mut flags = Vec::new();
        let mut description_start = 0;
        for (index, token) in tokens.iter().enumerate() {
            if token.starts_with('-') && !token.contains('=') {
                flags.push((*token).to_string());
                description_start = index + 1;
            } else {
                break;
            }
        }
        let Some(flag) = flags.iter().find(|item| item.starts_with("--")).cloned() else {
            continue;
        };
        if options.iter().any(|item: &HelpOption| item.flag == flag) {
            continue;
        }
        let description = tokens
            .iter()
            .skip(description_start)
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        let aliases = flags.into_iter().filter(|item| item != &flag).collect();
        let _ = executable;
        options.push(HelpOption {
            flag,
            aliases,
            section: section.clone(),
            description,
        });
    }
    options
}

#[tauri::command]
fn default_profile_command() -> Profile {
    default_profile()
}

#[tauri::command]
fn build_command(profile: Profile) -> Result<CommandPreview, String> {
    build_args(&profile)
}

#[tauri::command]
fn get_help_options(executable: String) -> Result<Vec<HelpOption>, String> {
    let exe = find_executable(&executable);
    let (ok, help) = command_output(&exe, &["--help"]);
    if !ok && help.trim().is_empty() {
        return Err(format!("Could not run {} --help", exe));
    }
    Ok(parse_help(&exe, &help))
}

#[tauri::command]
fn detect_environment(executable: Option<String>) -> EnvironmentSnapshot {
    let requested = executable.unwrap_or_else(|| "llama-server.exe".into());
    let runtime_path = find_executable(&requested);
    let (version_ok, version) = command_output(&runtime_path, &["--version"]);
    let (devices_ok, device_text) = command_output(&runtime_path, &["--list-devices"]);
    let (help_ok, _) = command_output(&runtime_path, &["--help"]);
    let mut notes = Vec::new();
    if !version_ok {
        notes.push(format!(
            "Runtime not found or --version failed: {}",
            runtime_path
        ));
    }
    if !devices_ok {
        notes.push("Device enumeration failed; CPU fallback remains available.".into());
    }
    if help_ok {
        notes.push("Runtime flags loaded dynamically from --help.".into());
    }
    let devices = device_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    EnvironmentSnapshot {
        platform: std::env::consts::OS.into(),
        runtime_path,
        version: version.trim().into(),
        help_available: help_ok,
        devices,
        backends: detect_backends(&device_text),
        notes,
    }
}

fn emit_reader<R: Read + Send + 'static>(app: AppHandle, stream: &'static str, reader: R) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = app.emit("runtime-log", json!({"stream": stream, "line": line}));
        }
    });
}

#[tauri::command]
fn launch_runtime(app: AppHandle, profile: Profile) -> Result<LaunchResult, String> {
    let preview = build_args(&profile)?;
    let mut command = Command::new(&preview.executable);
    command.args(&preview.args);
    for variable in &profile.env_overrides {
        if !variable.key.trim().is_empty() {
            command.env(&variable.key, &variable.value);
        }
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to launch runtime: {}", error))?;
    let pid = child.id();
    if let Some(stdout) = child.stdout.take() {
        emit_reader(app.clone(), "stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        emit_reader(app.clone(), "stderr", stderr);
    }
    let wait_app = Arc::new(app);
    let wait_app_clone = wait_app.clone();
    thread::spawn(move || {
        let status = child.wait().map(|value| value.code());
        let _ = wait_app_clone.emit(
            "runtime-exit",
            json!({"pid": pid, "status": status.ok().flatten()}),
        );
    });
    Ok(LaunchResult {
        pid,
        command: preview,
    })
}

#[tauri::command]
fn stop_runtime(pid: u32) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let result = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map_err(|error| error.to_string())?;
        if result.status.success() {
            return Ok(format!("Stopped process tree {}", pid));
        }
        Err(String::from_utf8_lossy(&result.stderr).trim().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let result = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .map_err(|e| e.to_string())?;
        if result.status.success() {
            Ok(format!("Stopped process {}", pid))
        } else {
            Err(String::from_utf8_lossy(&result.stderr).trim().into())
        }
    }
}

#[tauri::command]
fn configure_anthropic_gateway(
    state: State<'_, gateway::GatewayState>,
    target_url: String,
    api_key: String,
) -> gateway::GatewayConfig {
    let mut config = state.config.write().expect("gateway config lock poisoned");
    config.target_url = target_url.trim_end_matches('/').to_string();
    config.api_key = api_key;
    config.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let gateway_state = gateway::GatewayState::default();
    tauri::Builder::default()
        .manage(gateway_state.clone())
        .setup(move |_app| {
            gateway::spawn(gateway_state.clone());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            default_profile_command,
            build_command,
            detect_environment,
            get_help_options,
            launch_runtime,
            stop_runtime,
            configure_anthropic_gateway
        ])
        .run(tauri::generate_context!())
        .expect("error while running llama command builder");
}
