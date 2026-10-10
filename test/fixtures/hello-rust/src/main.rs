use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).expect("bind");
    for mut stream in listener.incoming().flatten() {
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).ok();
        let out = hello::handle(line.split_whitespace().nth(1).unwrap_or("/"));
        let (code, body) = out.split_once(' ').unwrap();
        let reply = format!("HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        stream.write_all(reply.as_bytes()).ok();
    }
}
