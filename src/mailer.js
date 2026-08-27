/**
 * src/mailer.js
 * Minimal, dependency-free email sender. Uses the Resend HTTP API when
 * RESEND_API_KEY + MAIL_FROM are set; otherwise it is a safe NO-OP that just
 * logs who it WOULD have emailed (so nothing breaks before the key is dropped).
 *
 * Env:
 *   RESEND_API_KEY  - Resend key (re_...)
 *   MAIL_FROM       - verified sender, e.g. "Breadwright 3PL <alerts@dynaradigital.com>"
 *   MAIL_TO_DEFAULT - comma list, defaults to the two ops addresses below.
 */
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Breadwright 3PL <alerts@dynaradigital.com>';
const DEFAULT_TO = (process.env.MAIL_TO_DEFAULT || 'muhammad@breadwrightbox.com,j@dynaradigital.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Send a plain-text (and optional HTML) email.
 * @returns {{sent:boolean, to:string[], id?:string, skipped?:string, error?:string}}
 */
async function sendMail({ to, subject, text, html }) {
  const recipients = (Array.isArray(to) && to.length ? to : DEFAULT_TO);
  if (!RESEND_KEY) {
    console.log(`[mailer] NO-OP (RESEND_API_KEY unset) — would email ${recipients.join(', ')}: "${subject}"`);
    return { sent: false, to: recipients, skipped: 'RESEND_API_KEY not set' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: recipients, subject, text, html: html || undefined }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[mailer] Resend HTTP ${res.status}:`, body);
      return { sent: false, to: recipients, error: (body && body.message) || `HTTP ${res.status}` };
    }
    return { sent: true, to: recipients, id: body.id };
  } catch (e) {
    console.error('[mailer] send failed:', e.message);
    return { sent: false, to: recipients, error: e.message };
  }
}

module.exports = { sendMail, DEFAULT_TO };
