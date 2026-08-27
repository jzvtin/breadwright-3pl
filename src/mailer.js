/**
 * src/mailer.js
 * Plain SMTP email sender (no paid API). Uses nodemailer against any normal
 * mailbox — DreamHost, Gmail app-password, etc. Safe NO-OP that just logs the
 * intended recipients until SMTP creds are set, so nothing breaks meanwhile.
 *
 * Env (all optional until you want real sends):
 *   SMTP_HOST   e.g. smtp.dreamhost.com  |  smtp.gmail.com
 *   SMTP_PORT   465 (SSL, default) or 587 (STARTTLS)
 *   SMTP_USER   full mailbox address, e.g. j@dynaradigital.com
 *   SMTP_PASS   that mailbox's password (Gmail: a 16-char App Password)
 *   MAIL_FROM   defaults to SMTP_USER
 *   MAIL_TO_DEFAULT  comma list, defaults to the two ops addresses below.
 */
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
  });
  return _transport;
}

/**
 * Send a plain-text (and optional HTML) email over SMTP.
 * @returns {{sent:boolean, to:string[], id?:string, skipped?:string, error?:string}}
 */
async function sendMail({ to, subject, text, html }) {
  const recipients = (Array.isArray(to) && to.length ? to : DEFAULT_TO);
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log(`[mailer] NO-OP (SMTP creds unset) — would email ${recipients.join(', ')}: "${subject}"`);
    return { sent: false, to: recipients, skipped: 'SMTP not configured' };
  }
  try {
    const info = await transport().sendMail({
      from: MAIL_FROM, to: recipients.join(', '), subject, text, html: html || undefined,
    });
    return { sent: true, to: recipients, id: info.messageId };
  } catch (e) {
    console.error('[mailer] SMTP send failed:', e.message);
    return { sent: false, to: recipients, error: e.message };
  }
}

module.exports = { sendMail, DEFAULT_TO };
