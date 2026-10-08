// RenderContainer (CHANGE-01 §3.4) — a Cloudflare Container running LibreOffice
// headless (container/Dockerfile). Pure function: DOCX in -> PDF out, so the
// PDF of record is laid out by a real office engine and pagination can be
// VERIFIED rather than hoped. No state, no secrets, no signing key (G8).
//
// Exported from src/index.ts since the container was folded into the default
// deploy (wrangler.jsonc binds it as RENDER), so the main bundle does include
// @cloudflare/containers.

import { Container } from '@cloudflare/containers';
import type { Env } from './env';

export class RenderContainer extends Container<Env> {
  defaultPort = 8080; // container/server.py listens here
  sleepAfter = '10m'; // scale to zero when idle
}
