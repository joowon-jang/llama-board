// Local MCP stdio client with explicit per-call approval.
use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::timeout;

const MCP_FILE: &str = "mcp-servers.json";
const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RPC_LINE: usize = 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES: usize = 256 * 1024;
const MAX_APPROVAL_DESCRIPTION_BYTES: usize = 4096;
const PROTOCOL_VERSION: &str = "2024-11-05";
static CONFIG_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Value,
}

fn default_enabled() -> bool {
    true
}

fn contains_forbidden_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| character == '\0' || character == '\r' || character == '\n')
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn validate_server(server: &McpServer) -> Result<(), String> {
    if !valid_id(&server.id) {
        return Err("MCP server id must contain only letters, numbers, '-' or '_'.".into());
    }
    if server.name.trim().is_empty() || server.name.len() > 80 {
        return Err("MCP server name must be between 1 and 80 characters.".into());
    }
    if server.command.trim().is_empty()
        || server.command.len() > 512
        || contains_forbidden_control(&server.command)
        || server
            .command
            .chars()
            .any(|character| matches!(character, '&' | '|' | ';' | '<' | '>'))
    {
        return Err(
            "MCP command must be one executable path; shell operators are not allowed.".into(),
        );
    }
    if server.args.len() > 64
        || server
            .args
            .iter()
            .any(|argument| argument.len() > 4096 || contains_forbidden_control(argument))
    {
        return Err("MCP arguments must be at most 64 newline-free values.".into());
    }
    Ok(())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(MCP_FILE))
        .map_err(|error| format!("cannot resolve MCP config directory: {error}"))
}

async fn load_servers(app: &AppHandle) -> Result<Vec<McpServer>, String> {
    let path = config_path(app)?;
    if !tokio::fs::try_exists(&path)
        .await
        .map_err(|error| format!("cannot inspect MCP config: {error}"))?
    {
        return Ok(Vec::new());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("cannot read MCP config: {error}"))?;
    let servers: Vec<McpServer> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("cannot parse MCP config: {error}"))?;
    for server in &servers {
        validate_server(server)?;
    }
    Ok(servers)
}

async fn save_servers(app: &AppHandle, servers: &[McpServer]) -> Result<(), String> {
    for server in servers {
        validate_server(server)?;
    }
    let path = config_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "MCP config has no parent directory".to_string())?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("cannot create MCP config directory: {error}"))?;
    let temp = directory.join(format!(".mcp-servers-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(servers)
        .map_err(|error| format!("cannot encode MCP config: {error}"))?;
    tokio::fs::write(&temp, bytes)
        .await
        .map_err(|error| format!("cannot stage MCP config: {error}"))?;
    if let Err(error) = activate_staged_file(&temp, &path).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(format!("cannot activate MCP config: {error}"));
    }
    Ok(())
}

/// Activate a staged config without relying on POSIX rename-overwrite semantics.
/// Windows' `MoveFileEx` equivalent is not exposed by Tokio's portable API and
/// `tokio::fs::rename` fails when the destination already exists. Moving the old
/// file to a sibling backup first keeps replacement recoverable if activation
/// fails, while retaining same-directory atomic renames for each step.
async fn activate_staged_file(temp: &PathBuf, path: &PathBuf) -> Result<(), std::io::Error> {
    let backup = path.with_extension(format!("json.backup-{}", uuid::Uuid::new_v4()));
    let had_existing = tokio::fs::try_exists(path).await?;
    if had_existing {
        tokio::fs::rename(path, &backup).await?;
    }
    match tokio::fs::rename(temp, path).await {
        Ok(()) => {
            if had_existing {
                let _ = tokio::fs::remove_file(&backup).await;
            }
            Ok(())
        }
        Err(error) => {
            if had_existing && tokio::fs::try_exists(&backup).await.unwrap_or(false) {
                let _ = tokio::fs::rename(&backup, path).await;
            }
            Err(error)
        }
    }
}

fn config_lock() -> &'static tokio::sync::Mutex<()> {
    CONFIG_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn append_bounded_line(target: &mut Vec<u8>, bytes: &[u8]) -> Result<(), String> {
    if target.len().saturating_add(bytes.len()) > MAX_RPC_LINE {
        return Err("MCP response exceeded the 1 MiB safety limit".to_string());
    }
    target.extend_from_slice(bytes);
    Ok(())
}

fn inherited_environment() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    // MCP servers are third-party executables. Do not hand them the complete
    // desktop process environment, which commonly contains API keys/tokens.
    const ALLOWED: &[&str] = &[
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOME",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
    ];
    ALLOWED
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|value| ((*name).into(), value)))
        .collect()
}

async fn spawn_session(server: &McpServer) -> Result<McpSession, String> {
    if !server.enabled {
        return Err("MCP server is disabled".into());
    }
    let mut command = Command::new(&server.command);
    command
        .args(&server.args)
        .env_clear()
        .envs(inherited_environment())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot start MCP server '{}': {error}", server.name))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "MCP server stdin was not captured".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "MCP server stdout was not captured".to_string())?;
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut buffer = [0_u8; 4096];
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }
    let mut session = McpSession {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    };
    send_message(
        &mut session.stdin,
        1,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "llama-board", "version": env!("CARGO_PKG_VERSION")}
        }),
    )
    .await?;
    let _ = read_response(&mut session.stdout, 1).await?;
    send_notification(&mut session.stdin, "notifications/initialized", json!({})).await?;
    Ok(session)
}

struct McpSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

async fn send_message(
    stdin: &mut ChildStdin,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    write_line(stdin, message).await
}

async fn send_notification(
    stdin: &mut ChildStdin,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let message = json!({"jsonrpc": "2.0", "method": method, "params": params});
    write_line(stdin, message).await
}

async fn write_line(stdin: &mut ChildStdin, message: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&message)
        .map_err(|error| format!("cannot encode MCP request: {error}"))?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| format!("cannot write MCP request: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("cannot flush MCP request: {error}"))
}

async fn read_bounded_line(reader: &mut BufReader<ChildStdout>) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|error| format!("cannot read MCP response: {error}"))?;
        if buffer.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|error| format!("MCP response was not UTF-8: {error}"));
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        append_bounded_line(&mut bytes, &buffer[..take])?;
        reader.consume(take);
        if newline.is_some() {
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|error| format!("MCP response was not UTF-8: {error}"));
        }
    }
}

async fn read_response(reader: &mut BufReader<ChildStdout>, id: u64) -> Result<Value, String> {
    let read = timeout(RPC_TIMEOUT, async {
        loop {
            let Some(line) = read_bounded_line(reader).await? else {
                return Err("MCP server closed stdout before responding".to_string());
            };
            let message: Value = serde_json::from_str(&line)
                .map_err(|error| format!("MCP returned invalid JSON: {error}"))?;
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!("MCP request failed: {error}"));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    })
    .await
    .map_err(|_| "MCP request timed out after 15 seconds".to_string())?;
    read
}

async fn close_session(mut session: McpSession) {
    #[cfg(windows)]
    {
        let Some(pid) = session.child.id() else {
            let _ = session.child.kill().await;
            let _ = session.child.wait().await;
            return;
        };
        let killed_tree = tokio::task::spawn_blocking(move || {
            let pid = pid.to_string();
            std::process::Command::new("taskkill")
                .args(["/PID", &pid, "/T", "/F"])
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false);
        if !killed_tree {
            let _ = session.child.kill().await;
        }
    }
    #[cfg(not(windows))]
    {
        let _ = session.child.kill().await;
    }
    let _ = session.child.wait().await;
}

pub async fn list(app: AppHandle) -> Result<Vec<McpServer>, String> {
    load_servers(&app).await
}

pub async fn save(app: AppHandle, server: McpServer) -> Result<Vec<McpServer>, String> {
    let _config_guard = config_lock().lock().await;
    let mut servers = load_servers(&app).await?;
    validate_server(&server)?;
    if let Some(existing) = servers
        .iter_mut()
        .find(|candidate| candidate.id == server.id)
    {
        *existing = server;
    } else {
        servers.push(server);
    }
    save_servers(&app, &servers).await?;
    Ok(servers)
}

pub async fn remove(app: AppHandle, id: &str) -> Result<Vec<McpServer>, String> {
    if !valid_id(id) {
        return Err("invalid MCP server id".into());
    }
    let _config_guard = config_lock().lock().await;
    let mut servers = load_servers(&app).await?;
    servers.retain(|server| server.id != id);
    save_servers(&app, &servers).await?;
    Ok(servers)
}

pub async fn tools(app: AppHandle, id: &str) -> Result<Vec<McpTool>, String> {
    let server = load_servers(&app)
        .await?
        .into_iter()
        .find(|server| server.id == id)
        .ok_or_else(|| "MCP server was not found".to_string())?;
    let mut session = spawn_session(&server).await?;
    let result = send_tools_request(&mut session).await;
    close_session(session).await;
    let result = result?;
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "MCP tools/list returned no tools array".to_string())?;
    tools
        .iter()
        .cloned()
        .map(|tool| {
            serde_json::from_value(tool)
                .map_err(|error| format!("invalid MCP tool metadata: {error}"))
        })
        .collect()
}

async fn send_tools_request(session: &mut McpSession) -> Result<Value, String> {
    send_message(&mut session.stdin, 2, "tools/list", json!({})).await?;
    read_response(&mut session.stdout, 2).await
}

fn validate_tool_arguments(schema: &Value, arguments: &Value) -> Result<(), String> {
    let Some(schema) = schema.as_object() else {
        return Ok(());
    };
    let Some(arguments) = arguments.as_object() else {
        return Err("MCP tool arguments must be a JSON object".into());
    };
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for field in required.iter().filter_map(Value::as_str) {
            if !arguments.contains_key(field) {
                return Err(format!("MCP tool argument '{field}' is required"));
            }
        }
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for (field, value) in arguments {
            let Some(expected) = properties
                .get(field)
                .and_then(Value::as_object)
                .and_then(|property| property.get("type"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let valid = match expected {
                "string" => value.is_string(),
                "number" => value.is_number(),
                "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
                "boolean" => value.is_boolean(),
                "object" => value.is_object(),
                "array" => value.is_array(),
                "null" => value.is_null(),
                _ => true,
            };
            if !valid {
                return Err(format!("MCP tool argument '{field}' must be {expected}"));
            }
        }
    }
    Ok(())
}

fn tool_approval_description(server: &McpServer, name: &str, arguments: &Value) -> String {
    let serialized = serde_json::to_string(arguments).unwrap_or_else(|_| "<unserializable>".into());
    let description = format!(
        "Server: {} ({})\nTool: {}\nArguments: {}\n\nAllow this one-time MCP tool call?",
        server.name, server.id, name, serialized
    );
    if description.len() <= MAX_APPROVAL_DESCRIPTION_BYTES {
        return description;
    }
    let mut bounded = description;
    bounded.truncate(MAX_APPROVAL_DESCRIPTION_BYTES.saturating_sub("\n…".len()));
    bounded.push_str("\n…");
    bounded
}

async fn confirm_tool_call(
    server: &McpServer,
    name: &str,
    arguments: &Value,
) -> Result<(), String> {
    let result = AsyncMessageDialog::new()
        .set_title("MCP tool approval required")
        .set_description(tool_approval_description(server, name, arguments))
        .set_buttons(MessageButtons::YesNo)
        .show()
        .await;
    if result == MessageDialogResult::Yes {
        Ok(())
    } else {
        Err("MCP tool call rejected by the user".into())
    }
}

pub async fn call_tool(
    app: AppHandle,
    id: &str,
    name: &str,
    arguments: Value,
) -> Result<Value, String> {
    if name.is_empty() || name.len() > 256 || contains_forbidden_control(name) {
        return Err("invalid MCP tool name".into());
    }
    if !arguments.is_object() {
        return Err("MCP tool arguments must be a JSON object".into());
    }
    let argument_bytes = serde_json::to_vec(&arguments)
        .map_err(|error| format!("cannot encode MCP tool arguments: {error}"))?;
    if argument_bytes.len() > MAX_TOOL_ARGUMENT_BYTES {
        return Err("MCP tool arguments exceed the 256 KiB safety limit".into());
    }
    let server = load_servers(&app)
        .await?
        .into_iter()
        .find(|server| server.id == id)
        .ok_or_else(|| "MCP server was not found".to_string())?;
    let mut session = spawn_session(&server).await?;
    let result = async {
        let tool_list = send_tools_request(&mut session).await?;
        let tool = tool_list
            .get("tools")
            .and_then(Value::as_array)
            .and_then(|tools| {
                tools
                    .iter()
                    .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
            })
            .ok_or_else(|| format!("MCP tool '{name}' is not declared by the server"))?;
        if let Some(schema) = tool.get("inputSchema") {
            validate_tool_arguments(schema, &arguments)?;
        }
        confirm_tool_call(&server, name, &arguments).await?;
        send_message(
            &mut session.stdin,
            2,
            "tools/call",
            json!({"name": name, "arguments": arguments}),
        )
        .await?;
        read_response(&mut session.stdout, 2).await
    }
    .await;
    close_session(session).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(command: &str) -> McpServer {
        McpServer {
            id: "test-server".into(),
            name: "Test server".into(),
            command: command.into(),
            args: Vec::new(),
            enabled: true,
        }
    }

    #[test]
    fn rejects_shell_operators_and_control_characters() {
        assert!(validate_server(&server("npx")).is_ok());
        assert!(validate_server(&server("npx && whoami")).is_err());
        assert!(validate_server(&server("npx\nwhoami")).is_err());
    }

    #[test]
    fn rejects_invalid_ids_and_oversized_arguments() {
        let mut candidate = server("npx");
        candidate.id = "../server".into();
        assert!(validate_server(&candidate).is_err());
        candidate.id = "test-server".into();
        candidate.args = vec!["x".repeat(4097)];
        assert!(validate_server(&candidate).is_err());
    }

    #[tokio::test]
    async fn staged_config_replaces_existing_file_and_preserves_new_content() {
        let root = std::env::temp_dir().join(format!("llama-board-mcp-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root)
            .await
            .expect("temp directory");
        let path = root.join("mcp-servers.json");
        let temp = root.join(".mcp-servers.tmp");
        tokio::fs::write(&path, b"old").await.expect("old config");
        tokio::fs::write(&temp, b"new")
            .await
            .expect("staged config");

        activate_staged_file(&temp, &path)
            .await
            .expect("replacement should succeed");
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "new");
        assert!(!tokio::fs::try_exists(&temp).await.unwrap());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn inherited_environment_excludes_common_secret_names() {
        let names: Vec<String> = inherited_environment()
            .into_iter()
            .map(|(name, _)| name.to_string_lossy().to_ascii_uppercase())
            .collect();
        assert!(!names.iter().any(|name| name.contains("TOKEN")));
        assert!(!names.iter().any(|name| name.contains("API_KEY")));
        assert!(!names.iter().any(|name| name.contains("PASSWORD")));
    }

    #[test]
    fn bounded_line_accumulator_rejects_over_limit_payloads() {
        let mut line = vec![b'x'; MAX_RPC_LINE - 1];
        assert!(append_bounded_line(&mut line, b"\n").is_ok());
        assert!(append_bounded_line(&mut line, b"x").is_err());
    }

    #[test]
    fn tool_schema_validation_rejects_missing_and_wrong_types() {
        let schema = json!({
            "type": "object",
            "required": ["query"],
            "properties": {"query": {"type": "string"}}
        });
        assert!(validate_tool_arguments(&schema, &json!({})).is_err());
        assert!(validate_tool_arguments(&schema, &json!({"query": 4})).is_err());
        assert!(validate_tool_arguments(&schema, &json!({"query": "llama"})).is_ok());
    }

    #[test]
    fn approval_description_is_bounded_and_binds_server_and_tool_identity() {
        let description =
            tool_approval_description(&server("npx"), "search", &json!({"query": "llama"}));
        assert!(description.contains("Test server"));
        assert!(description.contains("search"));
        assert!(description.contains("llama"));
        assert!(description.len() <= MAX_APPROVAL_DESCRIPTION_BYTES);
    }
}
