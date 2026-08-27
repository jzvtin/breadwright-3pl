/**
 * src/mailer.js
 * Email sender with two transports, picked automatically:
 *   1. Resend HTTP API (RESEND_API_KEY) — sends over HTTPS/443. USE THIS ON
 *      RAILWAY: Railway blocks outbound SMTP ports, so plain SMTP times out there.
 *   2. SMTP (nodemailer) — any normal mailbox, for hosts that allow SMTP.
 * Falls back to a safe NO-OP (logs intended recipients) until one is configured.
 *
 * Env:
 *   RESEND_API_KEY   re_...  (preferred on Railway)
 *   MAIL_FROM        verified sender, e.g. "Breadwright 3PL <alerts@dynaradigital.com>"
 *   -- OR SMTP --
 *   SMTP_HOST/PORT/USER/PASS  (465 SSL default; Gmail needs a 16-char App Password)
 *   MAIL_TO_DEFAULT  comma list, defaults to the two ops addresses below.
 */
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const DEFAULT_TO = (process.env.MAIL_TO_DEFAULT || 'muhammad@breadwrightbox.com,j@dynaradigital.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

let _transport = null;
function transport() {
  if (_transport) return _transport;
  const nodemailer = require('nodemailer');
  _transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // 465 = implicit SSL; 587 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Fail fast instead of hanging a request/poll if the host is unreachable or
    // the port is blocked (some PaaS block outbound SMTP). Distinguishes a
    // timeout (port block) from a 535 (bad creds).
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 15000,
  });
  return _transport;
}

/**
 * Send a plain-text (and optional HTML) email over SMTP.
 * @returns {{sent:boolean, to:string[], id?:string, skipped?:string, error?:string}}
 */
const RELAY_URL = process.env.MAIL_RELAY_URL || ''; // e.g. https://dynaradigital.com/bw-mail.php
const RELAY_KEY = process.env.MAIL_RELAY_KEY || '';

async function sendMail({ to, subject, text, html }) {
  const recipients = (Array.isArray(to) && to.length ? to : DEFAULT_TO);

  // 0) DreamHost HTTPS relay (preferred on Railway — own domain, no signup, no SMTP)
  if (RELAY_URL && RELAY_KEY) {
    try {
      const res = await fetch(`${RELAY_URL}?key=${encodeURIComponent(RELAY_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Mail-Key': RELAY_KEY },
        body: JSON.stringify({ to: recipients, subject, text, html: html || undefined, from: MAIL_FROM || 'Breadwright 3PL <no-reply@dynaradigital.com>' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) { console.error(`[mailer] relay HTTP ${res.status}:`, body); return { sent: false, to: recipients, error: (body && body.error) || `HTTP ${res.status}` }; }
      return { sent: true, to: recipients, id: body.id, via: 'relay' };
    } catch (e) {
      console.error('[mailer] relay failed:', e.message);
      return { sent: false, to: recipients, error: e.message };
    }
  }

  // 1) Resend HTTP (works on Railway — no SMTP ports needed)
  if (RESEND_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: MAIL_FROM || 'onboarding@resend.dev', to: recipients, subject, text, html: html || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { console.error(`[mailer] Resend HTTP ${res.status}:`, body); return { sent: false, to: recipients, error: (body && body.message) || `HTTP ${res.status}` }; }
      return { sent: true, to: recipients, id: body.id, via: 'resend' };
    } catch (e) {
      console.error('[mailer] Resend failed:', e.message);
      return { sent: false, to: recipients, error: e.message };
    }
  }

  // 2) SMTP fallback (blocked on Railway; fine elsewhere)
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log(`[mailer] NO-OP (no RESEND_API_KEY or SMTP creds) — would email ${recipients.join(', ')}: "${subject}"`);
    return { sent: false, to: recipients, skipped: 'no email transport configured' };
  }
  try {
    const info = await transport().sendMail({ from: MAIL_FROM || SMTP_USER, to: recipients.join(', '), subject, text, html: html || undefined });
    return { sent: true, to: recipients, id: info.messageId, via: 'smtp' };
  } catch (e) {
    console.error('[mailer] SMTP send failed:', e.message);
    return { sent: false, to: recipients, error: e.message };
  }
}

module.exports = { sendMail, DEFAULT_TO };
