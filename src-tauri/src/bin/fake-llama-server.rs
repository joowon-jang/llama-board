//! Deterministic stand-in for `llama-server`, used only by
//! `tests/smoke_fake.rs` so the process-spawn / `/health` polling / SSE
//! streaming path in `server.rs` gets real, always-on integration coverage
//! without needing a multi-GB model or `LLAMA_BOARD_SMOKE=1`.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

fn port_arg() -> u16 {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|arg| arg == "--port")
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn handle(mut stream: TcpStream) {
    let mut reader = match stream.try_clone() {
        Ok(clone) => BufReader::new(clone),
        Err(_) => return,
    };
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    if content_length > 0 {
        let mut body = vec![0_u8; content_length];
        let _ = reader.read_exact(&mut body);
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    match (method, path) {
        ("GET", "/health") => respond(
            &mut stream,
            "200 OK",
            "application/json",
            r#"{"status":"ok"}"#,
        ),
        ("GET", "/v1/models") => respond(
            &mut stream,
            "200 OK",
            "application/json",
            r#"{"data":[{"id":"fake-model","object":"model"}]}"#,
        ),
        ("POST", "/v1/chat/completions") => {
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n";
            respond(&mut stream, "200 OK", "text/event-stream", body);
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", "not found"),
    }
}

fn main() {
    let port = port_arg();
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind fake llama-server port");
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => handle(stream),
            Err(_) => continue,
        }
    }
}
