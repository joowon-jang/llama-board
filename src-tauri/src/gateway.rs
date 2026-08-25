use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_UPSTREAM_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_STREAM_PENDING_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_PORT: u16 = 8081;

fn upstream_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .expect("static gateway client configuration must be valid")
}

async fn bounded_upstream_bytes(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!(
            "OpenAI upstream response exceeds the {limit} byte limit"
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("OpenAI upstream response read failed: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(format!(
                "OpenAI upstream response exceeds the {limit} byte limit"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn bounded_upstream_text(response: reqwest::Response) -> String {
    bounded_upstream_bytes(response, 2 * 1024 * 1024)
        .await
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_else(|_| "upstream returned an oversized or unreadable error".into())
}

async fn bounded_upstream_json(response: reqwest::Response) -> Result<Value, String> {
    let bytes = bounded_upstream_bytes(response, MAX_UPSTREAM_JSON_BYTES).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid OpenAI upstream response: {error}"))
}

pub struct GatewayHandle {
    pub stop: Arc<AtomicBool>,
    pub task: JoinHandle<()>,
    pub port: u16,
    pub active_requests: Arc<AtomicUsize>,
}

const MAX_RESPONSES: usize = 128;

#[derive(Clone)]
struct StoredResponse {
    response: Value,
    messages: Vec<Value>,
}

struct ActiveRequestGuard(Arc<AtomicUsize>);

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub async fn start(upstream: String, upstream_key: String) -> Result<GatewayHandle, String> {
    let listener = TcpListener::bind(("127.0.0.1", DEFAULT_PORT))
        .await
        .map_err(|error| {
            format!("cannot bind Anthropic gateway on 127.0.0.1:{DEFAULT_PORT}: {error}")
        })?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("cannot inspect Anthropic gateway address: {error}"))?
        .port();
    let stop = Arc::new(AtomicBool::new(false));
    let responses = Arc::new(tokio::sync::Mutex::new(
        HashMap::<String, StoredResponse>::new(),
    ));
    let active_requests = Arc::new(AtomicUsize::new(0));
    let task_stop = Arc::clone(&stop);
    let task_responses = Arc::clone(&responses);
    let task_active_requests = Arc::clone(&active_requests);
    let task = tokio::spawn(async move {
        run(
            listener,
            upstream,
            upstream_key,
            task_stop,
            task_responses,
            task_active_requests,
        )
        .await;
    });
    Ok(GatewayHandle {
        stop,
        task,
        port,
        active_requests,
    })
}

pub async fn stop(handle: GatewayHandle) {
    handle.stop.store(true, Ordering::Release);
    let _ = handle.task.await;
}

async fn run(
    listener: TcpListener,
    upstream: String,
    upstream_key: String,
    stop: Arc<AtomicBool>,
    responses: Arc<tokio::sync::Mutex<HashMap<String, StoredResponse>>>,
    active_requests: Arc<AtomicUsize>,
) {
    loop {
        if stop.load(Ordering::Acquire) {
            break;
        }
        let accepted =
            tokio::time::timeout(std::time::Duration::from_millis(250), listener.accept()).await;
        let Ok(Ok((stream, _))) = accepted else {
            continue;
        };
        let upstream = upstream.clone();
        let upstream_key = upstream_key.clone();
        let stop = Arc::clone(&stop);
        let responses = Arc::clone(&responses);
        let active_requests = Arc::clone(&active_requests);
        tokio::spawn(async move {
            let _ = handle_connection(
                stream,
                &upstream,
                &upstream_key,
                stop,
                responses,
                active_requests,
            )
            .await;
        });
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    upstream: &str,
    upstream_key: &str,
    stop: Arc<AtomicBool>,
    responses: Arc<tokio::sync::Mutex<HashMap<String, StoredResponse>>>,
    active_requests: Arc<AtomicUsize>,
) -> Result<(), String> {
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    active_requests.fetch_add(1, Ordering::AcqRel);
    let _active_request = ActiveRequestGuard(active_requests);
    let (method, path, headers, body) = read_http_request(&mut stream).await?;
    if path == "/v1/responses" || path.starts_with("/v1/responses/") {
        return handle_responses(ResponsesRequest {
            stream: &mut stream,
            method: &method,
            path: &path,
            headers: &headers,
            body: &body,
            upstream,
            upstream_key,
            responses,
        })
        .await;
    }
    if method != "POST" || path != "/v1/messages" {
        write_json_response(&mut stream, 404, json!({"type":"error","error":{"type":"not_found","message":"POST /v1/messages is the only supported route"}})).await?;
        return Ok(());
    }
    if headers.get("x-api-key").map(String::as_str) != Some(upstream_key) {
        write_json_response(&mut stream, 401, json!({"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}})).await?;
        return Ok(());
    }
    if !headers.contains_key("anthropic-version") {
        write_json_response(&mut stream, 400, json!({"type":"error","error":{"type":"invalid_request_error","message":"anthropic-version header is required"}})).await?;
        return Ok(());
    }
    let request: Value = serde_json::from_slice(&body)
        .map_err(|error| format!("invalid Anthropic JSON: {error}"))?;
    let stream_requested = request
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let openai_request = anthropic_to_openai(&request)?;
    let client = upstream_client();
    let endpoint = format!("{}/chat/completions", upstream.trim_end_matches('/'));
    let mut request_builder = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {upstream_key}"))
        .json(&openai_request);
    if stream_requested {
        request_builder = request_builder.header("Accept", "text/event-stream");
    }
    let response = request_builder
        .send()
        .await
        .map_err(|error| format!("OpenAI upstream request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = bounded_upstream_text(response).await;
        write_json_response(&mut stream, status, json!({"type":"error","error":{"type":"api_error","message":text.chars().take(2000).collect::<String>()}})).await?;
        return Ok(());
    }
    if stream_requested {
        stream_response(&mut stream, response, &request).await
    } else {
        let value = bounded_upstream_json(response).await?;
        write_json_response(&mut stream, 200, openai_to_anthropic(&value)).await
    }
}

struct ResponsesRequest<'a> {
    stream: &'a mut TcpStream,
    method: &'a str,
    path: &'a str,
    headers: &'a std::collections::HashMap<String, String>,
    body: &'a [u8],
    upstream: &'a str,
    upstream_key: &'a str,
    responses: Arc<tokio::sync::Mutex<HashMap<String, StoredResponse>>>,
}

async fn handle_responses(request: ResponsesRequest<'_>) -> Result<(), String> {
    let ResponsesRequest {
        stream,
        method,
        path,
        headers,
        body,
        upstream,
        upstream_key,
        responses,
    } = request;
    let bearer_ok = headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == upstream_key);
    let key_ok = headers
        .get("x-api-key")
        .is_some_and(|value| value == upstream_key);
    if !bearer_ok && !key_ok {
        write_json_response(
            stream,
            401,
            json!({"error":{"type":"authentication_error","message":"invalid local API key"}}),
        )
        .await?;
        return Ok(());
    }

    if let Some(id) = path.strip_prefix("/v1/responses/") {
        if let Some(cancel_id) = id.strip_suffix("/cancel") {
            if cancel_id.is_empty() || cancel_id.contains('/') || method != "POST" {
                write_json_response(stream, 405, json!({"error":{"type":"method_not_allowed","message":"use POST /v1/responses/{id}/cancel"}})).await?;
            } else {
                let removed = responses.lock().await.remove(cancel_id).is_some();
                write_json_response(stream, if removed { 200 } else { 404 }, json!({"id":cancel_id,"object":"response","status":if removed { "cancelled" } else { "not_found" }})).await?;
            }
            return Ok(());
        }
        if id.is_empty() || id.contains('/') {
            write_json_response(
                stream,
                404,
                json!({"error":{"type":"not_found","message":"response id is invalid"}}),
            )
            .await?;
            return Ok(());
        }
        match method {
            "GET" => {
                let stored = responses.lock().await.get(id).cloned();
                if let Some(stored) = stored {
                    write_json_response(stream, 200, stored.response).await?;
                } else {
                    write_json_response(stream, 404, json!({"error":{"type":"not_found","message":"response was not found"}})).await?;
                }
            }
            "DELETE" => {
                let removed = responses.lock().await.remove(id).is_some();
                write_json_response(stream, if removed { 200 } else { 404 }, json!({"id":id,"object":"response","deleted":removed})).await?;
            }
            _ => write_json_response(stream, 405, json!({"error":{"type":"method_not_allowed","message":"use GET or DELETE for a response id"}})).await?,
        }
        return Ok(());
    }

    if method != "POST" || path != "/v1/responses" {
        write_json_response(stream, 404, json!({"error":{"type":"not_found","message":"supported response route is POST /v1/responses"}})).await?;
        return Ok(());
    }
    let request: Value =
        serde_json::from_slice(body).map_err(|error| format!("invalid Responses JSON: {error}"))?;
    let response_id = format!("resp_{}", uuid::Uuid::new_v4().simple());
    let previous_id = request.get("previous_response_id").and_then(Value::as_str);
    let history = if let Some(previous_id) = previous_id {
        let history = responses
            .lock()
            .await
            .get(previous_id)
            .map(|stored| stored.messages.clone());
        let Some(history) = history else {
            write_json_response(stream, 404, json!({"error":{"type":"not_found","message":format!("previous_response_id {previous_id} was not found")}})).await?;
            return Ok(());
        };
        history
    } else {
        Vec::new()
    };
    let mut messages = history;
    messages.extend(responses_input_to_openai(&request)?);
    let openai_request = responses_to_openai(&request, messages.clone())?;
    let stream_requested = request
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let endpoint = format!("{}/chat/completions", upstream.trim_end_matches('/'));
    let client = upstream_client();
    let mut request_builder = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {upstream_key}"))
        .json(&openai_request);
    if stream_requested {
        request_builder = request_builder.header("Accept", "text/event-stream");
    }
    let response = request_builder
        .send()
        .await
        .map_err(|error| format!("Responses upstream request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = bounded_upstream_text(response).await;
        write_json_response(stream, status, json!({"error":{"type":"api_error","message":text.chars().take(2000).collect::<String>()}})).await?;
        return Ok(());
    }
    if stream_requested {
        stream_responses(stream, response, &request, response_id, messages, responses).await
    } else {
        let value = bounded_upstream_json(response).await?;
        let assistant = openai_assistant_message(&value);
        messages.push(assistant);
        let response_value = openai_to_responses(&value, &request, &response_id);
        remember_response(&responses, response_id, response_value.clone(), messages).await;
        write_json_response(stream, 200, response_value).await
    }
}

fn responses_input_to_openai(request: &Value) -> Result<Vec<Value>, String> {
    let mut messages = Vec::new();
    if let Some(instructions) = request.get("instructions") {
        if !instructions.is_null() {
            messages
                .push(json!({"role":"system","content":response_content_to_openai(instructions)?}));
        }
    }
    let Some(input) = request.get("input") else {
        return Err("input is required for a Responses request".into());
    };
    if let Some(text) = input.as_str() {
        messages.push(json!({"role":"user","content":text}));
        return Ok(messages);
    }
    let items = input
        .as_array()
        .ok_or_else(|| "input must be a string or array".to_string())?;
    for item in items {
        if let Some(text) = item.as_str() {
            messages.push(json!({"role":"user","content":text}));
            continue;
        }
        let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
        let empty_content = Value::String(String::new());
        let content = item
            .get("content")
            .or_else(|| item.get("output"))
            .unwrap_or(&empty_content);
        messages.push(json!({"role":role,"content":response_content_to_openai(content)?}));
    }
    Ok(messages)
}

fn response_content_to_openai(value: &Value) -> Result<Value, String> {
    if value.is_string() {
        return Ok(value.clone());
    }
    let Some(blocks) = value.as_array() else {
        return Ok(value.clone());
    };
    let mut output = Vec::new();
    for block in blocks {
        let kind = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("input_text");
        match kind {
            "input_text" | "output_text" | "text" => output.push(json!({"type":"text","text":block.get("text").cloned().unwrap_or(Value::String(String::new()))})),
            "input_image" | "image" => {
                let image = block.get("image_url").or_else(|| block.get("url")).cloned().unwrap_or(Value::Null);
                let url = image.as_str().map(str::to_owned).or_else(|| block.get("image_url").and_then(|value| value.get("url")).and_then(Value::as_str).map(str::to_owned));
                if let Some(url) = url { output.push(json!({"type":"image_url","image_url":{"url":url}})); }
            }
            "function_call_output" => output.push(json!({"type":"text","text":block.get("output").cloned().unwrap_or(Value::String(String::new()))})),
            _ => {}
        }
    }
    Ok(
        if output.len() == 1 && output[0].get("type").and_then(Value::as_str) == Some("text") {
            output
                .remove(0)
                .get("text")
                .cloned()
                .unwrap_or(Value::String(String::new()))
        } else {
            Value::Array(output)
        },
    )
}

fn responses_to_openai(request: &Value, messages: Vec<Value>) -> Result<Value, String> {
    let mut body = Map::new();
    body.insert(
        "model".into(),
        request
            .get("model")
            .cloned()
            .unwrap_or(Value::String("local-model".into())),
    );
    body.insert("messages".into(), Value::Array(messages));
    body.insert(
        "stream".into(),
        request.get("stream").cloned().unwrap_or(Value::Bool(false)),
    );
    for (source, target) in [
        ("temperature", "temperature"),
        ("top_p", "top_p"),
        ("max_output_tokens", "max_tokens"),
        ("stop", "stop"),
        ("tools", "tools"),
        ("tool_choice", "tool_choice"),
        ("response_format", "response_format"),
    ] {
        if let Some(value) = request.get(source) {
            body.insert(target.into(), value.clone());
        }
    }
    if let Some(reasoning) = request.get("reasoning") {
        body.insert(
            "reasoning_effort".into(),
            reasoning
                .get("effort")
                .cloned()
                .unwrap_or(Value::String("default".into())),
        );
    }
    Ok(Value::Object(body))
}

fn openai_assistant_message(value: &Value) -> Value {
    value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or_else(|| json!({"role":"assistant","content":""}))
}

fn response_usage(value: &Value) -> Value {
    let usage = value.get("usage").cloned().unwrap_or_else(|| json!({}));
    json!({
        "input_tokens": usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
        "output_tokens": usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        "total_tokens": usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0)
    })
}

fn openai_to_responses(value: &Value, request: &Value, response_id: &str) -> Value {
    let message = openai_assistant_message(value);
    let text = message.get("content").and_then(Value::as_str).unwrap_or("");
    let reasoning = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
        .unwrap_or("");
    response_value(
        response_id,
        request
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("local-model"),
        text,
        reasoning,
        response_usage(value),
        "completed",
    )
}

fn response_value(
    id: &str,
    model: &str,
    text: &str,
    reasoning: &str,
    usage: Value,
    status: &str,
) -> Value {
    let mut output = Vec::new();
    if !reasoning.is_empty() {
        output.push(json!({"id":format!("rs_{}", uuid::Uuid::new_v4().simple()),"type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":reasoning}]}));
    }
    output.push(json!({"id":format!("msg_{}", uuid::Uuid::new_v4().simple()),"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]}));
    json!({"id":id,"object":"response","created_at":chrono_like_timestamp(),"status":status,"model":model,"output":output,"output_text":text,"usage":usage})
}

fn chrono_like_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

async fn remember_response(
    responses: &Arc<tokio::sync::Mutex<HashMap<String, StoredResponse>>>,
    id: String,
    response: Value,
    messages: Vec<Value>,
) {
    let mut guard = responses.lock().await;
    guard.insert(id, StoredResponse { response, messages });
    while guard.len() > MAX_RESPONSES {
        if let Some(key) = guard.keys().next().cloned() {
            guard.remove(&key);
        } else {
            break;
        }
    }
}

async fn stream_responses(
    stream: &mut TcpStream,
    response: reqwest::Response,
    request: &Value,
    response_id: String,
    mut messages: Vec<Value>,
    responses: Arc<tokio::sync::Mutex<HashMap<String, StoredResponse>>>,
) -> Result<(), String> {
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").await.map_err(|error| format!("Responses SSE header failed: {error}"))?;
    let model = request
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("local-model");
    let created = response_value(&response_id, model, "", "", json!({}), "in_progress");
    write_event(
        stream,
        "response.created",
        json!({"type":"response.created","response":created}),
    )
    .await?;
    let mut state = ResponseStreamState::default();
    let mut pending = String::new();
    let mut body_stream = response.bytes_stream();
    while let Some(chunk) = body_stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Responses upstream SSE read failed: {error}"))?;
        pending.push_str(&String::from_utf8_lossy(&chunk));
        if pending.len() > MAX_STREAM_PENDING_BYTES {
            return Err("upstream SSE line exceeded the 4 MiB limit".into());
        }
        while let Some(index) = pending.find('\n') {
            let line = pending[..index].trim_end_matches('\r').to_string();
            pending.drain(..=index);
            if let Some(data) = line.strip_prefix("data:") {
                if data.trim() == "[DONE]" {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                    state.apply(&value, stream).await?;
                }
            }
        }
    }
    if !pending.trim().is_empty() {
        if let Some(data) = pending.trim().strip_prefix("data:") {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                state.apply(&value, stream).await?;
            }
        }
    }
    messages
        .push(json!({"role":"assistant","content":state.text,"reasoning_content":state.reasoning}));
    let completed = response_value(
        &response_id,
        model,
        &state.text,
        &state.reasoning,
        state.usage.unwrap_or_else(|| json!({})),
        "completed",
    );
    remember_response(&responses, response_id, completed.clone(), messages).await;
    write_event(
        stream,
        "response.completed",
        json!({"type":"response.completed","response":completed}),
    )
    .await?;
    stream
        .shutdown()
        .await
        .map_err(|error| format!("Responses SSE shutdown failed: {error}"))
}

#[derive(Default)]
struct ResponseStreamState {
    text: String,
    reasoning: String,
    usage: Option<Value>,
}

impl ResponseStreamState {
    async fn apply(&mut self, value: &Value, stream: &mut TcpStream) -> Result<(), String> {
        if let Some(usage) = value.get("usage") {
            self.usage = Some(response_usage(value));
            let _ = usage;
        }
        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
        else {
            return Ok(());
        };
        let Some(delta) = choice.get("delta") else {
            return Ok(());
        };
        if let Some(text) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            self.reasoning.push_str(text);
            write_event(
                stream,
                "response.reasoning_summary_text.delta",
                json!({"type":"response.reasoning_summary_text.delta","delta":text}),
            )
            .await?;
        }
        if let Some(text) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            self.text.push_str(text);
            write_event(
                stream,
                "response.output_text.delta",
                json!({"type":"response.output_text.delta","delta":text}),
            )
            .await?;
        }
        Ok(())
    }
}

async fn read_http_request(
    stream: &mut TcpStream,
) -> Result<
    (
        String,
        String,
        std::collections::HashMap<String, String>,
        Vec<u8>,
    ),
    String,
> {
    let mut bytes = Vec::with_capacity(8192);
    let mut header_end = None;
    let mut buffer = [0_u8; 8192];
    while header_end.is_none() && bytes.len() <= MAX_BODY {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|error| format!("gateway read failed: {error}"))?;
        if count == 0 {
            return Err("gateway client closed before headers".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
        header_end = bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4);
    }
    let header_end =
        header_end.ok_or_else(|| "gateway headers exceeded the safety limit".to_string())?;
    let header_text = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "gateway request line is missing".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or_default().to_string();
    let mut headers = std::collections::HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| "Content-Length header is required".to_string())?;
    if content_length > MAX_BODY {
        return Err("gateway request body exceeds the 4 MiB limit".into());
    }
    let mut body = bytes[header_end..].to_vec();
    while body.len() < content_length {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|error| format!("gateway body read failed: {error}"))?;
        if count == 0 {
            return Err("gateway client closed before body completed".into());
        }
        body.extend_from_slice(&buffer[..count]);
    }
    body.truncate(content_length);
    Ok((method, path, headers, body))
}

async fn write_json_response(
    stream: &mut TcpStream,
    status: u16,
    value: Value,
) -> Result<(), String> {
    let body = serde_json::to_vec(&value)
        .map_err(|error| format!("gateway response encode failed: {error}"))?;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Upstream Error",
    };
    let header = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|error| format!("gateway response header failed: {error}"))?;
    stream
        .write_all(&body)
        .await
        .map_err(|error| format!("gateway response body failed: {error}"))?;
    stream
        .shutdown()
        .await
        .map_err(|error| format!("gateway shutdown failed: {error}"))
}

async fn stream_response(
    stream: &mut TcpStream,
    response: reqwest::Response,
    request: &Value,
) -> Result<(), String> {
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").await.map_err(|error| format!("gateway SSE header failed: {error}"))?;
    let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    write_event(stream, "message_start", json!({"type":"message_start","message":{"id":message_id,"type":"message","role":"assistant","model":request.get("model").and_then(Value::as_str).unwrap_or("local-model"),"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}})).await?;
    let mut parser = OpenAiStream::default();
    let mut pending = String::new();
    let mut body_stream = response.bytes_stream();
    while let Some(chunk) = body_stream.next().await {
        let chunk = chunk.map_err(|error| format!("upstream SSE read failed: {error}"))?;
        pending.push_str(&String::from_utf8_lossy(&chunk));
        if pending.len() > MAX_STREAM_PENDING_BYTES {
            return Err("upstream SSE line exceeded the 4 MiB limit".into());
        }
        while let Some(index) = pending.find('\n') {
            let line = pending[..index].trim_end_matches('\r').to_string();
            pending.drain(..=index);
            if let Some(data) = line.strip_prefix("data:") {
                if data.trim() == "[DONE]" {
                    break;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                    parser.apply(&value, stream).await?;
                }
            }
        }
    }
    if !pending.trim().is_empty() && pending.trim() != "data: [DONE]" {
        if let Some(data) = pending.trim().strip_prefix("data:") {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                parser.apply(&value, stream).await?;
            }
        }
    }
    parser.finish(stream).await
}

async fn write_event(stream: &mut TcpStream, event: &str, value: Value) -> Result<(), String> {
    let data = serde_json::to_string(&value)
        .map_err(|error| format!("gateway SSE encode failed: {error}"))?;
    stream
        .write_all(format!("event: {event}\ndata: {data}\n\n").as_bytes())
        .await
        .map_err(|error| format!("gateway SSE write failed: {error}"))
}

#[derive(Default)]
struct OpenAiStream {
    thinking_index: Option<u32>,
    text_index: Option<u32>,
    output_tokens: u64,
    finish_reason: Option<String>,
    usage: Option<Value>,
}

impl OpenAiStream {
    async fn apply(&mut self, value: &Value, stream: &mut TcpStream) -> Result<(), String> {
        if let Some(usage) = value.get("usage") {
            self.usage = Some(usage.clone());
        }
        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
        else {
            return Ok(());
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        let Some(delta) = choice.get("delta") else {
            return Ok(());
        };
        if let Some(text) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            let index = if let Some(index) = self.thinking_index {
                index
            } else {
                let index = 0;
                self.thinking_index = Some(index);
                write_event(stream, "content_block_start", json!({"type":"content_block_start","index":index,"content_block":{"type":"thinking","thinking":""}})).await?;
                index
            };
            self.output_tokens += text.chars().count() as u64;
            write_event(stream, "content_block_delta", json!({"type":"content_block_delta","index":index,"delta":{"type":"thinking_delta","thinking":text}})).await?;
        }
        if let Some(text) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            let index = if let Some(index) = self.text_index {
                index
            } else {
                let index = if self.thinking_index.is_some() { 1 } else { 0 };
                self.text_index = Some(index);
                write_event(stream, "content_block_start", json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}})).await?;
                index
            };
            self.output_tokens += text.chars().count() as u64;
            write_event(stream, "content_block_delta", json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}})).await?;
        }
        Ok(())
    }

    async fn finish(&self, stream: &mut TcpStream) -> Result<(), String> {
        if let Some(index) = self.thinking_index {
            write_event(
                stream,
                "content_block_stop",
                json!({"type":"content_block_stop","index":index}),
            )
            .await?;
        }
        if let Some(index) = self.text_index {
            write_event(
                stream,
                "content_block_stop",
                json!({"type":"content_block_stop","index":index}),
            )
            .await?;
        }
        let stop_reason = match self.finish_reason.as_deref() {
            Some("length") => "max_tokens",
            Some("tool_calls") => "tool_use",
            Some("content_filter") => "refusal",
            _ => "end_turn",
        };
        write_event(stream, "message_delta", json!({"type":"message_delta","delta":{"stop_reason":stop_reason,"stop_sequence":null},"usage":{"output_tokens":self.usage.as_ref().and_then(|v| v.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(self.output_tokens)}})).await?;
        write_event(stream, "message_stop", json!({"type":"message_stop"})).await?;
        stream
            .shutdown()
            .await
            .map_err(|error| format!("gateway SSE shutdown failed: {error}"))
    }
}

fn anthropic_to_openai(request: &Value) -> Result<Value, String> {
    let messages = request
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "messages must be an array".to_string())?;
    let mut converted = Vec::new();
    if let Some(system) = request.get("system") {
        let content = content_blocks_to_openai(system)?;
        converted.push(json!({"role":"system","content":content}));
    }
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| "message role is required".to_string())?;
        let content = message
            .get("content")
            .cloned()
            .unwrap_or(Value::String(String::new()));
        if let Some(blocks) = content.as_array() {
            let tool_results = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"));
            let mut had_tool_result = false;
            for block in tool_results {
                had_tool_result = true;
                converted.push(json!({
                    "role": "tool",
                    "tool_call_id": block.get("tool_use_id").cloned().unwrap_or(Value::Null),
                    "content": block.get("content").cloned().unwrap_or(Value::String(String::new()))
                }));
            }
            let tool_calls: Vec<Value> = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
                .map(|block| {
                    json!({
                        "id": block.get("id").cloned().unwrap_or(Value::String(format!("call_{}", uuid::Uuid::new_v4().simple()))),
                        "type": "function",
                        "function": {
                            "name": block.get("name").cloned().unwrap_or(Value::String("tool".into())),
                            "arguments": serde_json::to_string(block.get("input").unwrap_or(&Value::Object(Map::new()))).unwrap_or_else(|_| "{}".into())
                        }
                    })
                })
                .collect();
            if !tool_calls.is_empty() {
                converted.push(json!({"role":"assistant","content":content_blocks_to_openai(&content)?,"tool_calls":tool_calls}));
            } else if !had_tool_result {
                converted.push(json!({"role":role,"content":content_blocks_to_openai(&content)?}));
            }
        } else {
            converted.push(json!({"role":role,"content":content_blocks_to_openai(&content)?}));
        }
    }
    let mut body = Map::new();
    body.insert(
        "model".into(),
        request
            .get("model")
            .cloned()
            .unwrap_or(Value::String("local-model".into())),
    );
    body.insert("messages".into(), Value::Array(converted));
    body.insert(
        "stream".into(),
        request.get("stream").cloned().unwrap_or(Value::Bool(false)),
    );
    for field in ["temperature", "top_p", "stop", "max_tokens"] {
        if let Some(value) = request.get(field) {
            body.insert(field.into(), value.clone());
        }
    }
    if let Some(tools) = request.get("tools").and_then(Value::as_array) {
        body.insert("tools".into(), Value::Array(tools.iter().map(|tool| json!({"type":"function","function":{"name":tool.get("name"),"description":tool.get("description"),"parameters":tool.get("input_schema")}})).collect()));
    }
    Ok(Value::Object(body))
}

fn content_blocks_to_openai(value: &Value) -> Result<Value, String> {
    let Some(blocks) = value.as_array() else {
        return Ok(value.clone());
    };
    let mut output = Vec::new();
    let mut text = String::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str).unwrap_or_default() {
            "text" | "thinking" => if let Some(value) = block.get(if block.get("type").and_then(Value::as_str) == Some("thinking") { "thinking" } else { "text" }).and_then(Value::as_str) { text.push_str(value); },
            "image" => output.push(json!({"type":"image_url","image_url":{"url":block.get("source").and_then(|source| source.get("data")).and_then(Value::as_str).map(|data| format!("data:{};base64,{}", block.get("source").and_then(|source| source.get("media_type")).and_then(Value::as_str).unwrap_or("image/png"), data)).or_else(|| block.get("source").and_then(|source| source.get("url")).and_then(Value::as_str).map(str::to_owned))}})),
            _ => {}
        }
    }
    if output.is_empty() {
        Ok(Value::String(text))
    } else {
        if !text.is_empty() {
            output.insert(0, json!({"type":"text","text":text}));
        }
        Ok(Value::Array(output))
    }
}

fn openai_to_anthropic(value: &Value) -> Value {
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or(Value::Null);
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    let mut content = Vec::new();
    if let Some(thinking) = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        content.push(json!({"type":"thinking","thinking":thinking}));
    }
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        content.push(json!({"type":"text","text":text}));
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let function = call.get("function").cloned().unwrap_or(Value::Null);
            let input = function
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .unwrap_or_else(|| json!({}));
            content.push(json!({"type":"tool_use","id":call.get("id"),"name":function.get("name"),"input":input}));
        }
    }
    let finish = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(|reason| match reason {
            "tool_calls" => "tool_use",
            "length" => "max_tokens",
            _ => "end_turn",
        })
        .unwrap_or("end_turn");
    json!({"id":value.get("id").cloned().unwrap_or(Value::String(format!("msg_{}", uuid::Uuid::new_v4().simple()))),"type":"message","role":"assistant","model":value.get("model").cloned().unwrap_or(Value::String("local-model".into())),"content":content,"stop_reason":finish,"stop_sequence":null,"usage":{"input_tokens":value.get("usage").and_then(|usage| usage.get("prompt_tokens")).and_then(Value::as_u64).unwrap_or(0),"output_tokens":value.get("usage").and_then(|usage| usage.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(0)}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_anthropic_text_and_tools_to_openai() {
        let request = json!({"model":"m","max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],"tools":[{"name":"search","input_schema":{"type":"object"}}]});
        let output = anthropic_to_openai(&request).unwrap();
        assert_eq!(output["messages"][0]["content"], "hello");
        assert_eq!(output["tools"][0]["function"]["name"], "search");
    }

    #[test]
    fn translates_openai_stop_and_usage_to_anthropic() {
        let response = json!({"id":"chatcmpl-1","model":"m","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}});
        let output = openai_to_anthropic(&response);
        assert_eq!(output["content"][0]["text"], "ok");
        assert_eq!(output["usage"]["input_tokens"], 3);
        assert_eq!(output["stop_reason"], "end_turn");
    }

    #[test]
    fn translates_anthropic_tool_result_and_tool_use_without_empty_duplicate_messages() {
        let request = json!({
            "model": "m",
            "max_tokens": 32,
            "messages": [
                {"role":"assistant","content":[{"type":"tool_use","id":"call-1","name":"search","input":{"q":"llama"}}]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":"found"}]}
            ]
        });
        let output = anthropic_to_openai(&request).unwrap();
        assert_eq!(output["messages"].as_array().unwrap().len(), 2);
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["function"]["name"],
            "search"
        );
        assert_eq!(output["messages"][1]["role"], "tool");
    }

    #[test]
    fn translates_responses_input_and_preserves_previous_turn_shape() {
        let request = json!({
            "model": "m",
            "instructions": "Be concise.",
            "input": [{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
            "max_output_tokens": 24,
            "stream": true
        });
        let messages = responses_input_to_openai(&request).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["content"], "hello");
        let output = responses_to_openai(&request, messages).unwrap();
        assert_eq!(output["max_tokens"], 24);
        assert_eq!(output["stream"], true);
    }

    #[test]
    fn converts_openai_response_to_stateful_responses_shape() {
        let request = json!({"model":"m"});
        let response = json!({"model":"m","choices":[{"message":{"role":"assistant","content":"done","reasoning":"think"}}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}});
        let output = openai_to_responses(&response, &request, "resp_test");
        assert_eq!(output["object"], "response");
        assert_eq!(output["id"], "resp_test");
        assert_eq!(output["output_text"], "done");
        assert_eq!(output["usage"]["total_tokens"], 6);
        assert_eq!(output["output"][0]["type"], "reasoning");
        assert_eq!(output["output"][1]["content"][0]["type"], "output_text");
    }
}
