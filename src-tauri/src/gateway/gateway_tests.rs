use super::*;

#[test]
fn translates_anthropic_messages_to_openai_shape() {
    let request = json!({
        "model": "local-model",
        "system": "Be concise",
        "messages": [{"role":"user","content":"Hello"}],
        "max_tokens": 128,
        "stream": true
    });
    let translated = anthropic_to_openai(&request, true);
    assert_eq!(translated["model"], "local-model");
    assert_eq!(translated["messages"][0]["role"], "system");
    assert_eq!(translated["messages"][1]["content"], "Hello");
    assert_eq!(translated["stream"], true);
    assert_eq!(translated["max_tokens"], 128);
}

#[test]
fn translates_openai_reasoning_and_tool_response_to_anthropic_shape() {
    let response = json!({
        "model": "local-model",
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {
                "reasoning_content": "check the file",
                "content": "I will inspect it.",
                "tool_calls": [{
                    "id": "call_1",
                    "function": {"name": "read_file", "arguments": "{\"path\":\"README.md\"}"}
                }]
            }
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 7}
    });
    let translated = openai_to_anthropic(&response);
    assert_eq!(translated["type"], "message");
    assert_eq!(translated["role"], "assistant");
    assert_eq!(translated["stop_reason"], "tool_use");
    assert_eq!(translated["usage"]["input_tokens"], 10);
    assert_eq!(translated["content"][0]["type"], "thinking");
    assert_eq!(translated["content"][1]["type"], "text");
    assert_eq!(translated["content"][2]["type"], "tool_use");
    assert_eq!(translated["content"][2]["input"]["path"], "README.md");
}

#[test]
fn emits_anthropic_sse_event_frames() {
    let bytes = sse_event("message_stop", json!({"type":"message_stop"}));
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(text.starts_with("event: message_stop\n"));
    assert!(text.contains("\"type\":\"message_stop\""));
    assert!(text.ends_with("\n\n"));
}
