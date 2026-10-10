/// Answers a path with a status line and a JSON body.
pub fn handle(path: &str) -> String {
    let (status, body) = match path {
        "/hello" => (200, r#"{"message":"hello"}"#),
        "/health" => (200, r#"{"status":"ok"}"#),
        _ => (404, r#"{"error":"not found"}"#),
    };
    format!("{} {}", itoa::Buffer::new().format(status), body)
}

#[cfg(test)]
mod tests {
    use super::handle;

    #[test]
    fn ac_001_hello_answers_200_with_the_message() {
        assert_eq!(handle("/hello"), r#"200 {"message":"hello"}"#);
    }

    #[test]
    fn ac_002_health_answers_ok() {
        assert_eq!(handle("/health"), r#"200 {"status":"ok"}"#);
    }

    #[test]
    fn ac_003_unknown_path_answers_404() {
        assert!(handle("/nope").starts_with("404 "));
    }
}
