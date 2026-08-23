use std::{
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use async_stream::stream;
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GatewayConfig {
    pub target_url: String,
    pub api_key: String,
    pub port: u16,
}

#[derive(Clone)]
pub struct GatewayState {
    pub config: Arc<RwLock<GatewayConfig>>,
    client: Client,
}

impl Default for GatewayState {
    fn default() -> Self {
        Self {
            config: Arc::new(RwLock::new(GatewayConfig {
                target_url: "http://127.0.0.1:8080".into(),
                api_key: String::new(),
                port: 8081,
            })),
            client: Client::new(),
        }
    }
}

fn message_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{}_{}", prefix, millis)
}

fn error_response(status: StatusCode, error_type: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "type": "error",
            "error": { "type": error_type, "message": message }
        })),
    )
        .into_response()
}

fn validate_headers(headers: &HeaderMap, config: &GatewayConfig) -> Result<(), Box<Response>> {
    if !config.api_key.is_empty() {
        let supplied = headers
            .get("x-api-key")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if supplied != config.api_key {
            return Err(Box::new(error_response(
                StatusCode::UNAUTHORIZED,
                "authentication_error",
                "Invalid x-api-key.",
            )));
        }
    }
    if !headers.contains_key("anthropic-version") {
        return Err(Box::new(error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "The anthropic-version header is required.",
        )));
    }
    Ok(())
}

fn content_to_openai(content: &Value) -> Value {
    match content {
        Value::String(_) => content.clone(),
        Value::Array(items) => {
            let translated = items
                .iter()
                .filter_map(|item| {
                    let kind = item.get("type")?.as_str()?;
                    match kind {
                        "text" => Some(json!({
                            "type": "text",
                            "text": item.get("text").and_then(Value::as_str).unwrap_or_default()
                        })),
                        "image" | "image_url" => {
                            let source = item.get("source").or_else(|| item.get("image_url"))?;
                            let url = source
                                .get("url")
                                .or_else(|| source.get("data"))
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            Some(json!({"type":"image_url","image_url":{"url":url}}))
                        }
                        "tool_result" => Some(json!({
                            "type": "text",
                            "text": item.get("content").map(Value::to_string).unwrap_or_default()
                        })),
                        _ => None,
                    }
                })
                .collect::<Vec<_>>();
            Value::Array(translated)
        }
        _ => Value::String(content.to_string()),
    }
}

fn anthropic_to_openai(request: &Value, stream: bool) -> Value {
    let mut messages = Vec::new();
    if let Some(system) = request.get("system") {
        let content = if system.is_string() {
            system.clone()
        } else {
            content_to_openai(system)
        };
        messages.push(json!({"role":"system","content":content}));
    }
    if let Some(items) = request.get("messages").and_then(Value::as_array) {
        for item in items {
            let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
            let content = item
                .get("content")
                .map(content_to_openai)
                .unwrap_or(Value::String(String::new()));
            messages.push(json!({"role":role,"content":content}));
        }
    }

    let mut body = json!({
        "model": request.get("model").cloned().unwrap_or_else(|| json!("local-model")),
        "messages": messages,
        "max_tokens": request.get("max_tokens").cloned().unwrap_or_else(|| json!(1024)),
        "stream": stream,
    });
    for key in ["temperature", "top_p", "stop", "tools", "tool_choice"] {
        if let Some(value) = request.get(key) {
            body[key] = value.clone();
        }
    }
    if let Some(tools) = request.get("tools").and_then(Value::as_array) {
        body["tools"] = Value::Array(
            tools
                .iter()
                .filter_map(|tool| {
                    Some(json!({
                        "type": "function",
                        "function": {
                            "name": tool.get("name")?,
                            "description": tool.get("description").cloned().unwrap_or(Value::Null),
                            "parameters": tool.get("input_schema").cloned().unwrap_or_else(|| json!({}))
                        }
                    }))
                })
                .collect(),
        );
    }
    body
}

fn anthropic_content(response: &Value) -> Vec<Value> {
    let message = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut content = Vec::new();
    if let Some(reasoning) = message.get("reasoning_content").and_then(Value::as_str) {
        if !reasoning.is_empty() {
            content.push(json!({"type":"thinking","thinking":reasoning,"signature":"local"}));
        }
    }
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        if !text.is_empty() {
            content.push(json!({"type":"text","text":text}));
        }
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in tool_calls {
            let function = call.get("function").cloned().unwrap_or_else(|| json!({}));
            let input = function
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_else(|| json!({}));
            content.push(json!({
                "type":"tool_use",
                "id":call.get("id").cloned().unwrap_or_else(|| json!(message_id("toolu"))),
                "name":function.get("name").cloned().unwrap_or_else(|| json!("tool")),
                "input":input
            }));
        }
    }
    if content.is_empty() {
        content.push(json!({"type":"text","text":""}));
    }
    content
}

fn openai_to_anthropic(response: &Value) -> Value {
    let choice = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let finish = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .unwrap_or("stop");
    let stop_reason = match finish {
        "length" => "max_tokens",
        "tool_calls" => "tool_use",
        _ => "end_turn",
    };
    let usage = response.get("usage").cloned().unwrap_or_else(|| json!({}));
    json!({
        "id": message_id("msg_local"),
        "type": "message",
        "role": "assistant",
        "model": response.get("model").cloned().unwrap_or_else(|| json!("local-model")),
        "content": anthropic_content(response),
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": {
            "input_tokens": usage.get("prompt_tokens").cloned().unwrap_or_else(|| json!(0)),
            "output_tokens": usage.get("completion_tokens").cloned().unwrap_or_else(|| json!(0))
        }
    })
}

fn sse_event(event: &str, data: Value) -> Bytes {
    Bytes::from(format!("event: {}\ndata: {}\n\n", event, data))
}

async fn forward_non_streaming(state: &GatewayState, request: Value) -> Response {
    let config = state
        .config
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| GatewayConfig::default());
    let target = format!(
        "{}/v1/chat/completions",
        config.target_url.trim_end_matches('/')
    );
    let openai_request = anthropic_to_openai(&request, false);
    let response = match state.client.post(target).json(&openai_request).send().await {
        Ok(response) => response,
        Err(error) => {
            return error_response(StatusCode::BAD_GATEWAY, "api_error", &error.to_string())
        }
    };
    let status = response.status();
    let body = match response.json::<Value>().await {
        Ok(body) => body,
        Err(error) => {
            return error_response(StatusCode::BAD_GATEWAY, "api_error", &error.to_string())
        }
    };
    if !status.is_success() {
        return (
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(body),
        )
            .into_response();
    }
    (StatusCode::OK, Json(openai_to_anthropic(&body))).into_response()
}

async fn forward_streaming(state: &GatewayState, request: Value) -> Response {
    let config = state
        .config
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| GatewayConfig::default());
    let target = format!(
        "{}/v1/chat/completions",
        config.target_url.trim_end_matches('/')
    );
    let openai_request = anthropic_to_openai(&request, true);
    let response = match state.client.post(target).json(&openai_request).send().await {
        Ok(response) => response,
        Err(error) => {
            return error_response(StatusCode::BAD_GATEWAY, "api_error", &error.to_string())
        }
    };
    if !response.status().is_success() {
        let status =
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let body = response.text().await.unwrap_or_default();
        return error_response(status, "api_error", &body);
    }

    let mut upstream = response.bytes_stream();
    let stream = stream! {
        let message = json!({
            "id": message_id("msg_local"),
            "type": "message",
            "role": "assistant",
            "model": request.get("model").cloned().unwrap_or_else(|| json!("local-model")),
            "content": [],
            "stop_reason": null,
            "stop_sequence": null,
            "usage": {"input_tokens": 0, "output_tokens": 0}
        });
        yield Ok::<Bytes, std::io::Error>(sse_event("message_start", json!({"type":"message_start","message":message})));
        let mut buffer = String::new();
        let mut text_index: Option<usize> = None;
        let mut thinking_index: Option<usize> = None;
        let mut finished = false;
        while let Some(chunk) = upstream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    yield Err::<Bytes, std::io::Error>(std::io::Error::other(error.to_string()));
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(position) = buffer.find("\n\n") {
                let frame = buffer[..position].to_string();
                buffer.drain(..position + 2);
                for line in frame.lines() {
                    let Some(raw) = line.strip_prefix("data:") else { continue; };
                    let data = raw.trim();
                    if data == "[DONE]" {
                        finished = true;
                        break;
                    }
                    let Ok(payload) = serde_json::from_str::<Value>(data) else { continue; };
                    let delta = payload.get("choices").and_then(Value::as_array).and_then(|items| items.first()).and_then(|item| item.get("delta")).cloned().unwrap_or_else(|| json!({}));
                    if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
                        if !reasoning.is_empty() {
                            let index = if let Some(index) = thinking_index { index } else {
                                let index = 0;
                                thinking_index = Some(index);
                                yield Ok::<Bytes, std::io::Error>(sse_event("content_block_start", json!({"type":"content_block_start","index":index,"content_block":{"type":"thinking","thinking":""}})));
                                index
                            };
                            yield Ok::<Bytes, std::io::Error>(sse_event("content_block_delta", json!({"type":"content_block_delta","index":index,"delta":{"type":"thinking_delta","thinking":reasoning}})));
                        }
                    }
                    if let Some(text) = delta.get("content").and_then(Value::as_str) {
                        if !text.is_empty() {
                            let index = if let Some(index) = text_index { index } else {
                                let index = if thinking_index.is_some() { 1 } else { 0 };
                                text_index = Some(index);
                                yield Ok::<Bytes, std::io::Error>(sse_event("content_block_start", json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}})));
                                index
                            };
                            yield Ok::<Bytes, std::io::Error>(sse_event("content_block_delta", json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}})));
                        }
                    }
                    if let Some(finish) = payload.get("choices").and_then(Value::as_array).and_then(|items| items.first()).and_then(|item| item.get("finish_reason")).and_then(Value::as_str) {
                        let stop_reason = if finish == "length" { "max_tokens" } else if finish == "tool_calls" { "tool_use" } else { "end_turn" };
                        yield Ok::<Bytes, std::io::Error>(sse_event("message_delta", json!({"type":"message_delta","delta":{"stop_reason":stop_reason,"stop_sequence":null},"usage":{"output_tokens":0}})));
                    }
                }
                if finished { break; }
            }
            if finished { break; }
        }
        if let Some(index) = thinking_index {
            yield Ok::<Bytes, std::io::Error>(sse_event("content_block_stop", json!({"type":"content_block_stop","index":index})));
        }
        if let Some(index) = text_index {
            yield Ok::<Bytes, std::io::Error>(sse_event("content_block_stop", json!({"type":"content_block_stop","index":index})));
        }
        yield Ok::<Bytes, std::io::Error>(sse_event("message_stop", json!({"type":"message_stop"})));
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| {
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "api_error",
                "Could not create stream response.",
            )
        })
}

async fn messages(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let config = state
        .config
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| GatewayConfig::default());
    if let Err(response) = validate_headers(&headers, &config) {
        return *response;
    }
    if request
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        forward_streaming(&state, request).await
    } else {
        forward_non_streaming(&state, request).await
    }
}

async fn models(State(state): State<GatewayState>) -> Response {
    let config = state
        .config
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| GatewayConfig::default());
    let target = format!("{}/v1/models", config.target_url.trim_end_matches('/'));
    match state.client.get(target).send().await {
        Ok(response) => {
            let status =
                StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            match response.json::<Value>().await {
                Ok(body) => (status, Json(body)).into_response(),
                Err(error) => {
                    error_response(StatusCode::BAD_GATEWAY, "api_error", &error.to_string())
                }
            }
        }
        Err(error) => error_response(StatusCode::BAD_GATEWAY, "api_error", &error.to_string()),
    }
}
pub fn spawn(state: GatewayState) {
    tauri::async_runtime::spawn(async move {
        let port = state.config.read().map(|guard| guard.port).unwrap_or(8081);
        let router = Router::new()
            .route("/v1/messages", post(messages))
            .route("/v1/models", get(models))
            .with_state(state);
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!(
                    "Anthropic gateway could not bind 127.0.0.1:{}: {}",
                    port, error
                );
                return;
            }
        };
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("Anthropic gateway stopped: {}", error);
        }
    });
}

#[cfg(test)]
mod gateway_tests;
