#!/usr/bin/env python3
# Render container (CHANGE-01 §3.4): DOCX -> PDF via LibreOffice headless.
# Pure function: POST /render with a .docx body -> 200 with the .pdf body.
# Also reports page count so the Workflow can VERIFY pagination rather than hope.
# No state, no secrets, no signing key (G8).

import http.server
import socketserver
import subprocess
import tempfile
import os
import re

PORT = int(os.environ.get("PORT", "8080"))


def docx_to_pdf(docx_bytes: bytes) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "in.docx")
        with open(src, "wb") as f:
            f.write(docx_bytes)
        subprocess.run(
            ["libreoffice", "--headless", "--convert-to", "pdf", "--outdir", d, src],
            check=True, timeout=120,
        )
        with open(os.path.join(d, "in.pdf"), "rb") as f:
            return f.read()


def page_count(pdf_bytes: bytes) -> int:
    return len(re.findall(rb"/Type\s*/Page[^s]", pdf_bytes)) or 1


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/render":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        docx = self.rfile.read(length)
        try:
            pdf = docx_to_pdf(docx)
        except Exception as e:  # noqa: BLE001
            self.send_error(500, str(e))
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("X-Page-Count", str(page_count(pdf)))
        self.send_header("Content-Length", str(len(pdf)))
        self.end_headers()
        self.wfile.write(pdf)

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"render-container ok")


if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        httpd.serve_forever()
