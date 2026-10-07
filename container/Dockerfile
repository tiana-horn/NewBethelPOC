# Render container (CHANGE-01 §3.4) — LibreOffice headless, DOCX -> PDF.
#
# A PURE FUNCTION: DOCX in -> PDF out. No state, no secrets, no keys (G8).
# Only Word/LibreOffice can lay out real pages, so pagination fidelity lives
# here — the Worker generates the DOCX (Style Pack), this renders the PDF of
# record, and the Workflow verifies page count / section-page numbering.
#
# Build & push (Cloudflare Containers are GA — verify current wrangler syntax):
#   wrangler containers build -t spec-writer-render ./container --push
# Then add a `containers` binding + a Durable Object class per the Containers API
# and call it as a Workflow step, replacing renderFallbackPdf() in src/shared/seal.ts.

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-writer python3 fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py /app/server.py
EXPOSE 8080
CMD ["python3", "/app/server.py"]
