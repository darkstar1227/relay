use crate::Result;
use reqwest::blocking::Client;
use serde_json::Value;
use std::io::Read;
use std::time::Duration;

const SOURCES: [(&str, &str); 2] = [
    (
        "https://api.github.com/repos/darkstar1227/relay/releases/latest",
        "tag_name",
    ),
    (
        "https://registry.npmjs.org/@dst-justin%2frelay/latest",
        "version",
    ),
];
const MAX_BODY: u64 = 1024 * 1024;

fn client(timeout: Duration) -> Result<Client> {
    let builder = Client::builder();
    #[cfg(test)]
    let builder = builder.no_proxy();
    builder
        .timeout(timeout)
        .connect_timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("relay-update")
        .build()
        .map_err(|_| "cannot initialize update HTTP client")
}

fn latest(client: &Client, sources: &[(&str, &str)]) -> Result<String> {
    for &(url, field) in sources {
        let attempt = || -> Result<String> {
            let response = client
                .get(url)
                .send()
                .map_err(|_| "update request failed")?;
            if !response.status().is_success() {
                return Err("update HTTP status failed");
            }
            let mut bytes = Vec::new();
            response
                .take(MAX_BODY + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "cannot read update response")?;
            if bytes.len() as u64 > MAX_BODY {
                return Err("update response too large");
            }
            let json: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid update JSON")?;
            let value = json
                .get(field)
                .and_then(Value::as_str)
                .ok_or("missing update version")?;
            let version = if field == "tag_name" {
                value.trim_start_matches('v')
            } else {
                value
            };
            // Keep untrusted metadata out of terminal escape sequences and npm options.
            if version.is_empty()
                || version.len() > 128
                || !version.starts_with(|c: char| c.is_ascii_digit())
                || !version
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c))
            {
                return Err("invalid update version");
            }
            Ok(version.to_owned())
        };
        if let Ok(version) = attempt() {
            return Ok(version);
        }
    }
    Err("cannot determine latest version")
}

pub fn run(args: &[String]) -> Result<()> {
    if !args.is_empty() {
        return Err("invalid update query arguments");
    }
    println!("{}", latest(&client(Duration::from_secs(6))?, &SOURCES)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn request_deadline_is_bounded() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.local_addr().unwrap());
        server.set_nonblocking(true).unwrap();
        let worker = thread::spawn(move || {
            let start = std::time::Instant::now();
            loop {
                if let Ok((stream, _)) = server.accept() {
                    thread::sleep(Duration::from_millis(300));
                    drop(stream);
                    break;
                }
                assert!(start.elapsed() < Duration::from_secs(3));
                thread::sleep(Duration::from_millis(5));
            }
        });
        let start = std::time::Instant::now();
        assert!(latest(
            &client(Duration::from_millis(50)).unwrap(),
            &[(&url, "version")]
        )
        .is_err());
        assert!(start.elapsed() < Duration::from_millis(1000));
        worker.join().unwrap();
    }

    fn check(responses: Vec<(u16, String)>, expected: Option<&str>) {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        let base = format!("http://{}", server.local_addr().unwrap());
        let worker = thread::spawn(move || {
            for (status, body) in responses {
                let start = std::time::Instant::now();
                let mut stream = loop {
                    if let Ok((stream, _)) = server.accept() {
                        break stream;
                    }
                    assert!(
                        start.elapsed() < Duration::from_secs(5),
                        "request not received"
                    );
                    thread::sleep(Duration::from_millis(5));
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    assert_eq!(stream.read(&mut byte).unwrap(), 1);
                    request.push(byte[0]);
                    assert!(request.len() < 16384);
                }
                assert!(String::from_utf8_lossy(&request)
                    .to_lowercase()
                    .contains("user-agent: relay-update"));
                let _ = write!(stream, "HTTP/1.1 {status} test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        let result = latest(
            &client(Duration::from_secs(1)).unwrap(),
            &[(&base, "tag_name"), (&base, "version")],
        );
        worker.join().unwrap();
        assert_eq!(result.ok().as_deref(), expected);
    }

    #[test]
    fn github_success_skips_fallback() {
        check(
            vec![(200, r#"{"tag_name":"v2.9.1"}"#.into())],
            Some("2.9.1"),
        );
    }
    #[test]
    fn http_failure_falls_back() {
        check(
            vec![
                (429, "limited".into()),
                (200, r#"{"version":"2.9.2"}"#.into()),
            ],
            Some("2.9.2"),
        );
    }
    #[test]
    fn malformed_json_falls_back() {
        check(
            vec![
                (200, "not-json".into()),
                (200, r#"{"version":"2.9.2"}"#.into()),
            ],
            Some("2.9.2"),
        );
    }
    #[test]
    fn invalid_types_and_terminal_controls_fail() {
        check(
            vec![
                (200, r#"{"tag_name":[]}"#.into()),
                (200, r#"{"version":"2.9.1\u001b[0m"}"#.into()),
            ],
            None,
        );
    }
    #[test]
    fn oversized_body_falls_back() {
        check(
            vec![
                (200, "x".repeat(MAX_BODY as usize + 2)),
                (200, r#"{"version":"2.9.2"}"#.into()),
            ],
            Some("2.9.2"),
        );
    }
    #[test]
    fn redirect_is_not_success() {
        check(
            vec![(302, "redirect".into()), (503, "unavailable".into())],
            None,
        );
    }
}
