import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

from itsdangerous import URLSafeSerializer

signer = URLSafeSerializer("hello-secret")
ROUTES = {"/hello": {"message": "hello"}, "/health": {"status": "ok"}}


def handle(path):
    """Return the status, the JSON body and the signature header for a path."""
    body = ROUTES.get(path)
    if body is None:
        return 404, {"error": "not found"}, None
    return 200, body, signer.dumps(body)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status, body, signature = handle(self.path)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if signature:
            self.send_header("X-Signature", signature)
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())


if __name__ == "__main__":
    HTTPServer(("", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
