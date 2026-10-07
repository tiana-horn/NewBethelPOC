#!/usr/bin/env bash
# Build + push the LibreOffice render container image and deploy the Worker
# (CHANGE-01 §3.4). The container is now part of the default wrangler.jsonc, so a
# plain `wrangler deploy` builds the image from container/Dockerfile, pushes it
# to Cloudflare's registry, and deploys — the seal step then renders the frozen
# PDF of record via LibreOffice (verifiable pagination).
#
# Requires: a Docker-compatible engine running, Containers enabled on the
# account, and CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) in the environment.
# On Apple Silicon the image is built for linux/amd64 (emulated — slower).
set -euo pipefail
cd "$(dirname "$0")/.."
npx wrangler deploy
