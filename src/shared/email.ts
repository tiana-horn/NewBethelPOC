// Transactional email via Resend (Rev A). Sends a notification when a Project
// Manual finishes rendering. Credentials are PLACEHOLDERS — set RESEND_API_KEY
// (and MAIL_FROM) as secrets before real use. With no key configured the send is
// a no-op that returns { sent: false } so the pipeline never fails on email.

import type { Env } from '../env';

export interface ManualReadyEmail {
  to: string;
  name?: string;
  projectName: string;
  projectId: string;
  contentHash: string;
  pageCount: number;
  appUrl?: string;
}

export async function sendManualReadyEmail(env: Env, msg: ManualReadyEmail): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = env.RESEND_API_KEY;
  const from = env.MAIL_FROM || 'SpecPilot <notifications@specpilot.example>';
  if (!apiKey || apiKey.startsWith('PLACEHOLDER')) {
    return { sent: false, reason: 'RESEND_API_KEY not configured (placeholder)' };
  }
  if (!msg.to) return { sent: false, reason: 'no recipient' };

  // Normalize a trailing slash on APP_URL so the link isn't `...dev//project/...`.
  const link = msg.appUrl ? `${msg.appUrl.replace(/\/+$/, '')}/project/${msg.projectId}` : msg.projectId;
  const html = [
    `<p>Hello ${escapeHtml(msg.name || 'there')},</p>`,
    `<p>Your Project Manual <strong>${escapeHtml(msg.projectName)}</strong> has finished rendering and is ready for review.</p>`,
    `<ul>`,
    `<li>Content hash: <code>${escapeHtml(msg.contentHash)}</code></li>`,
    `<li>Pages: ${msg.pageCount}</li>`,
    `</ul>`,
    `<p>Open it in SpecPilot: ${escapeHtml(link)}</p>`,
    `<p>This is an automated notification. The manual is a draft, approved for seal — a licensed architect of record seals it through their own process.</p>`,
  ].join('');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [msg.to],
        subject: `Project Manual ready — ${msg.projectName}`,
        html,
      }),
    });
    if (!res.ok) return { sent: false, reason: `resend ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
