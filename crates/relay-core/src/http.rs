use crate::Result;
use serde_json::Value;
use std::io::Read;
use std::time::Duration;

pub fn fixture_mode() -> bool {
    cfg!(feature = "test-fixtures") && std::env::var_os("RELAY_TEST_HOME").is_some()
}

pub fn request(
    url: &str,
    token: Option<&str>,
    body: Option<String>,
    seconds: u64,
    limit: u64,
) -> Result<(u16, Vec<u8>)> {
    #[cfg(feature = "test-fixtures")]
    if fixture_mode() {
        if let Ok(path) = std::env::var("RELAY_TEST_HTTP_CALLS") {
            use std::io::Write;
            let mut log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|_| "cannot record fixture request")?;
            writeln!(log, "{url}").map_err(|_| "cannot record fixture request")?;
        }
        let path = std::env::var("RELAY_TEST_HTTP").map_err(|_| "no HTTP fixture")?;
        let fixtures: Value = crate::storage::read(std::path::Path::new(&path))?;
        let value = fixtures.get(url).ok_or("missing HTTP fixture")?;
        if let Some(status) = value.get("error").and_then(Value::as_u64) {
            return Ok((status as u16, Vec::new()));
        }
        let bytes = if let Some(file) = value.get("body_file").and_then(Value::as_str) {
            std::fs::read(file).map_err(|_| "cannot read fixture body")?
        } else {
            serde_json::to_vec(value).map_err(|_| "invalid fixture")?
        };
        if bytes.len() as u64 > limit {
            return Err("HTTP body too large");
        }
        return Ok((200, bytes));
    }
    let builder = reqwest::blocking::Client::builder();
    #[cfg(test)]
    let builder = builder.no_proxy();
    let client = builder
        .timeout(Duration::from_secs(seconds))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("relay/2.0")
        .build()
        .map_err(|_| "cannot initialize HTTP client")?;
    let mut request = if let Some(body) = body {
        client
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("anthropic-version", "oauth-2025-04-20")
            .body(body)
    } else {
        client.get(url)
    };
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().map_err(|_| "HTTP request failed")?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "HTTP body read failed")?;
    if bytes.len() as u64 > limit {
        return Err("HTTP body too large");
    }
    Ok((status, bytes))
}

pub fn json(
    url: &str,
    token: Option<&str>,
    body: Option<String>,
    seconds: u64,
) -> Result<(u16, Value)> {
    let (status, bytes) = request(url, token, body, seconds, 1024 * 1024)?;
    if !(200..300).contains(&status) {
        return Ok((status, Value::Null));
    }
    Ok((
        status,
        serde_json::from_slice(&bytes).map_err(|_| "invalid HTTP JSON")?,
    ))
}

pub fn encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    fn server(status: u16, body: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let body = body.to_owned();
        let worker = thread::spawn(move || {
            let start = std::time::Instant::now();
            let mut stream = loop {
                if let Ok((stream, _)) = listener.accept() {
                    break stream;
                }
                assert!(start.elapsed() < Duration::from_secs(5));
                thread::sleep(Duration::from_millis(5));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                assert_eq!(stream.read(&mut byte).unwrap(), 1);
                bytes.push(byte[0]);
                assert!(bytes.len() < 16384);
            }
            let headers = String::from_utf8(bytes).unwrap();
            let len = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|n| n.parse::<usize>().ok())
                })
                .unwrap_or(0);
            let mut request_body = vec![0; len];
            stream.read_exact(&mut request_body).unwrap();
            if body == "STALL" {
                thread::sleep(Duration::from_millis(1500));
            }
            let _ = write!(stream, "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/not-followed\r\nConnection: close\r\n\r\n{body}", body.len());
            headers + &String::from_utf8(request_body).unwrap()
        });
        (url, worker)
    }

    #[test]
    fn real_transport_preserves_form_body_and_auth_headers() {
        let (url, worker) = server(200, "{\"ok\":true}");
        let body = format!("refresh_token={}", encode("a+b &中文"));
        let (status, value) = json(&url, Some("synthetic"), Some(body.clone()), 2).unwrap();
        assert_eq!(status, 200);
        assert_eq!(value["ok"], true);
        let request = worker.join().unwrap();
        assert!(request.starts_with("POST "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer synthetic"));
        assert!(request
            .to_lowercase()
            .contains("application/x-www-form-urlencoded"));
        assert!(request.ends_with(&body));
        assert_eq!(encode("a+b &中文"), "a%2Bb%20%26%E4%B8%AD%E6%96%87");
    }

    #[test]
    fn real_transport_rejects_oversize_and_malformed_json() {
        let (url, worker) = server(200, "too large");
        assert_eq!(
            request(&url, None, None, 2, 3).unwrap_err(),
            "HTTP body too large"
        );
        worker.join().unwrap();
        let (url, worker) = server(200, "SECRET invalid json");
        assert_eq!(json(&url, None, None, 2).unwrap_err(), "invalid HTTP JSON");
        worker.join().unwrap();
    }

    #[test]
    fn real_transport_does_not_follow_redirects_or_parse_error_bodies() {
        for status in [302, 401, 429, 503] {
            let (url, worker) = server(status, "SECRET not JSON");
            assert_eq!(json(&url, None, None, 2).unwrap(), (status, Value::Null));
            worker.join().unwrap();
        }
    }

    #[test]
    fn real_transport_timeout_is_bounded() {
        let (url, worker) = server(200, "STALL");
        let start = std::time::Instant::now();
        assert_eq!(
            request(&url, None, None, 1, 100).unwrap_err(),
            "HTTP request failed"
        );
        assert!(start.elapsed() < Duration::from_secs(3));
        worker.join().unwrap();
    }
}
