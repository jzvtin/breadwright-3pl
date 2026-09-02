/**
 * src/auditLog.js
 * Durable audit trail of every product actually SFTP'd to Ice Cube (ICCS) —
 * for safety/compliance review. Railway's disk is wiped on every redeploy, so
 * this POSTs each row to a DreamHost-hosted append-only CSV instead
 * (deploy/bw-audit.php, same relay pattern as the mailer). Never blocks or
 * throws on failure — a logging outage must never stop a real shipment; it
 * just logs a console warning so it's visible in Railway logs.
 *
 * Env: AUDIT_LOG_URL (e.g. https://dynaradigital.com/bw-audit.php), AUDIT_LOG_KEY.
 */
const URL = process.env.AUDIT_LOG_URL || '';
const KEY = process.env.AUDIT_LOG_KEY || '';

/** @param {Array<object>} rows - see bw-audit.php COLUMNS for the shape. */
async function appendAuditRows(rows) {
  if (!URL || !KEY || !rows || !rows.length) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${URL}?key=${encodeURIComponent(KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      console.warn(`[auditLog] append failed HTTP ${res.status}:`, body);
      return { ok: false, error: (body && body.error) || `HTTP ${res.status}` };
    }
    return { ok: true, written: body.written };
  } catch (e) {
    console.warn('[auditLog] append failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { appendAuditRows };
