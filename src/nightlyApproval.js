/**
 * src/nightlyApproval.js
 * APPROVAL-GATED NIGHTLY BATCH — replaces straight-to-SFTP `runBatch` for the
 * unattended schedule. Two phases, run by two separate crons:
 *
 *   1. prepareNightly()  ~9pm — pulls today's sendable orders, builds the Datex
 *      batch XML (same buildBatchChunks as batch.js), does NOT touch SFTP.
 *      Writes it to out/.nightly/<date>/ and emails Muhammad ("Sam") an
 *      approve/reject link pair. Status starts 'pending'.
 *   2. sendNightly()     ~4:30am — reads that day's record. Only SFTP-drops +
 *      tags-sent if status === 'approved' (Sam clicked Approve). Anything else
 *      (pending/rejected/missing) is a NO-SEND, with an alert email explaining
 *      why so it never fails silently.
 *
 * Decision is recorded via a random per-date token embedded in the email links
 * (GET /nightly/approve|reject?date=&token=) — no login needed for Sam.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeOrder, fetchOrdersForBatch, tagOrderSent } = require('./shopify');
const { buildBatchChunks, buildCustomerOrder } = require('./xml/buildOrder');
const { putXml, DRY_RUN } = require('./sftp');
const { sendMail } = require('./mailer');
const { appendAuditRows } = require('./auditLog');

const NIGHTLY_DIR = path.join(__dirname, '../out/.nightly');
fs.mkdirSync(NIGHTLY_DIR, { recursive: true });

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://api.breadwright.com';
// Sam (Muhammad) approves; Justin stays cc'd so a missed click doesn't go unnoticed.
const APPROVAL_TO = (process.env.NIGHTLY_APPROVAL_TO || 'muhammad@breadwrightbox.com,j@dynaradigital.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ALERT_TO = (process.env.NIGHTLY_ALERT_TO || APPROVAL_TO.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

function dateStamp(now) {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}
function dayDir(date) {
  return path.join(NIGHTLY_DIR, date);
}
function metaPath(date) {
  return path.join(dayDir(date), 'meta.json');
}
function readMeta(date) {
  try { return JSON.parse(fs.readFileSync(metaPath(date), 'utf8')); } catch (_) { return null; }
}
function writeMeta(date, meta) {
  fs.mkdirSync(dayDir(date), { recursive: true });
  fs.writeFileSync(metaPath(date), JSON.stringify(meta, null, 2));
}

// Plain-English service tier — Sam reviews this, not Datex/Priority-Shippers codes.
const TIER_LABEL = { '1_DAY': 'Ground (1 day)', '2_DAY': 'Ground (2 day)', '3_DAY': 'Ground (3 day)', '1_AIR': 'Overnight Air', '2_AIR': '2nd Day Air' };
function tierLabel(tier) { return TIER_LABEL[tier] || tier || 'Ground'; }

/** One human-readable line per order for the approval email — no XML, no material codes. */
function orderSummaryLine(order, pack) {
  const s = order.shipping || {};
  const dest = [s.city, s.state].filter(Boolean).join(', ');
  const dry = pack && pack.dryIceSlabs
    ? `, dry ice: ${pack.dryIceSlabs} slab${pack.dryIceSlabs === 1 ? '' : 's'}${pack.declareDryIce ? ' (declared)' : ''}`
    : '';
  return `#${order.number} — ${s.accountName || 'customer'} (${dest || 'no city'}) — ${tierLabel(order.serviceTier)}${dry}`;
}

/** Structured per-order detail — persisted in meta so sendNightly can build the audit-log rows without re-fetching/re-building anything. */
function orderDetail(order, pack) {
  const s = order.shipping || {};
  return {
    number: order.number,
    customer: s.accountName || '',
    city: s.city || '',
    state: s.state || '',
    serviceTier: order.serviceTier || '',
    dryIceSlabs: (pack && pack.dryIceSlabs) || 0,
    declareDryIce: !!(pack && pack.declareDryIce),
    contents: pack ? (pack.contents || []).map((c) => `${c.qty} ${c.desc || c.code}`).join(' | ') : '',
  };
}

/** Phase 1 (~9pm): build the batch, stage it, email Sam for approval. Never sends. */
async function prepareNightly({ now = new Date(), windowHours = 25 } = {}) {
  const date = dateStamp(now);
  const existing = readMeta(date);
  if (existing) return { ...existing, skipped: 'already prepared for ' + date };

  const raws = await fetchOrdersForBatch({ windowHours, now });
  const allOrders = raws.map((o) => normalizeOrder(o, now));

  const orders = [];
  const sendRaws = [];
  const blocked = [];
  const summaryLines = [];
  const orderDetails = [];
  allOrders.forEach((order, i) => {
    let b = [];
    let pack = null;
    try {
      const built = buildCustomerOrder(order);
      b = built.blocking || [];
      pack = built.pack;
    } catch (e) { b = ['build error: ' + e.message]; }
    if (b.length) blocked.push({ number: order.number, reasons: b });
    else { orders.push(order); sendRaws.push(raws[i]); summaryLines.push(orderSummaryLine(order, pack)); orderDetails.push(orderDetail(order, pack)); }
  });

  const token = crypto.randomBytes(16).toString('hex');
  const meta = {
    date, builtAt: now.toISOString(), windowHours, token,
    status: 'pending', decidedAt: null, decidedBy: null,
    count: allOrders.length, sendable: orders.length, blocked, summaryLines, orderDetails,
    files: [], sendRawsFile: 'raws.json',
  };

  if (!orders.length) {
    meta.status = 'no_orders';
    writeMeta(date, meta);
    await sendMail({
      to: ALERT_TO,
      subject: `Breadwright 3PL — no orders to batch tonight (${date})`,
      text: `No sendable orders in the ${windowHours}h window for ${date}.` +
        (blocked.length ? `\n\n${blocked.length} order(s) BLOCKED and skipped:\n` + blocked.map((b) => `#${b.number}: ${b.reasons.join('; ')}`).join('\n') : ''),
    });
    return meta;
  }

  const chunks = buildBatchChunks(orders);
  fs.mkdirSync(dayDir(date), { recursive: true });
  chunks.forEach((c, i) => {
    const filename = `part-${i + 1}.xml`;
    fs.writeFileSync(path.join(dayDir(date), filename), c.xml, 'utf8');
    meta.files.push({ filename, count: c.count, warnings: c.warnings });
  });
  fs.writeFileSync(path.join(dayDir(date), 'raws.json'), JSON.stringify(sendRaws));
  writeMeta(date, meta);

  const approveUrl = `${PUBLIC_BASE_URL}/nightly/approve?date=${date}&token=${token}`;
  const rejectUrl = `${PUBLIC_BASE_URL}/nightly/reject?date=${date}&token=${token}`;
  const previewUrl = `${PUBLIC_BASE_URL}/nightly/preview?date=${date}&token=${token}`;
  const blockedText = blocked.length
    ? `\n\n${blocked.length} order(s) BLOCKED (not included, need a fix):\n` + blocked.map((b) => `#${b.number}: ${b.reasons.join('; ')}`).join('\n')
    : '';
  const text =
    `Tonight's Breadwright batch is ready: ${meta.sendable} order(s).\n\n` +
    summaryLines.join('\n') + '\n\n' +
    `Review it, then click ONE:\n\nAPPROVE (sends at 4:30am):\n${approveUrl}\n\nREJECT (holds, will NOT send):\n${rejectUrl}\n\n` +
    `Full detail (plain-English list + raw XML):\n${previewUrl}\n\n` +
    `If nobody clicks Approve by 4:30am, this batch will NOT be sent to Ice Cube.` +
    blockedText;
  const email = await sendMail({
    to: APPROVAL_TO,
    subject: `Approve Breadwright 3PL batch — ${date} — ${meta.sendable} order(s)`,
    text,
  });
  meta.notified = email;
  writeMeta(date, meta);
  console.log(`[nightly] prepared ${date}: ${meta.sendable} order(s), ${meta.files.length} file(s), notified=${JSON.stringify(email)}`);
  return meta;
}

/** Record Sam's (or anyone with the token's) decision. Idempotent-ish: last click wins pre-send. */
function decide(date, token, decision, by) {
  const meta = readMeta(date);
  if (!meta) return { ok: false, error: `no batch prepared for ${date}` };
  if (meta.token !== token) return { ok: false, error: 'bad token' };
  if (meta.status === 'sent') return { ok: false, error: 'already sent — too late to change' };
  meta.status = decision;
  meta.decidedAt = new Date().toISOString();
  meta.decidedBy = by || 'link-click';
  writeMeta(date, meta);
  return { ok: true, meta };
}

/** Phase 2 (~4:30am): send ONLY if approved. Never sends on pending/rejected/missing. */
async function sendNightly({ now = new Date() } = {}) {
  const date = dateStamp(now);
  const meta = readMeta(date);

  if (!meta) {
    await sendMail({ to: ALERT_TO, subject: `Breadwright 3PL — NOTHING PREPARED for ${date}`, text: `4:30am send job ran but no batch was prepared for ${date} (9pm prepare step may have failed). Nothing was sent.` });
    return { ok: false, sent: false, reason: 'no_meta', date };
  }
  if (meta.status === 'no_orders') return { ok: true, sent: false, reason: 'no_orders', date };
  // Two triggers can fire close together (e.g. GitHub Actions + a redundant
  // DreamHost cron) — a prior run already sent it, so quietly no-op instead
  // of double-dropping to SFTP or firing a false "NOT sent" alarm.
  if (meta.status === 'sent') return { ok: true, sent: false, reason: 'already_sent', date, dropped: meta.dropped };
  if (meta.status !== 'approved') {
    await sendMail({
      to: ALERT_TO,
      subject: `Breadwright 3PL — batch NOT sent (${date}, status: ${meta.status})`,
      text: `${meta.sendable} order(s) were staged for ${date} but status is "${meta.status}" (not "approved") at send time — HELD, nothing dropped to Ice Cube.` +
        (meta.status === 'pending' ? `\n\nNobody clicked Approve/Reject before 4:30am.` : ''),
    });
    return { ok: true, sent: false, reason: meta.status, date };
  }

  const sendRaws = JSON.parse(fs.readFileSync(path.join(dayDir(date), 'raws.json'), 'utf8'));
  const dropped = [];
  for (const f of meta.files) {
    const xml = fs.readFileSync(path.join(dayDir(date), f.filename), 'utf8');
    const remoteName = `BW_${date}-cust order${meta.files.length > 1 ? '-' + (dropped.length + 1) : ''}.xml`;
    const put = await putXml(remoteName, xml);
    dropped.push({ filename: remoteName, count: f.count, ...put });
  }

  const tagged = [];
  const tagErrors = [];
  if (!DRY_RUN) {
    for (const o of sendRaws) {
      try { await tagOrderSent(o.id); tagged.push(o.id); }
      catch (e) { tagErrors.push({ id: o.id, error: e.message }); }
    }
  }

  meta.status = 'sent';
  meta.sentAt = now.toISOString();
  meta.dropped = dropped;
  writeMeta(date, meta);

  // Durable audit trail — every product actually sent to ICCS, persisted off
  // Railway's ephemeral disk (see src/auditLog.js). Never blocks the send.
  const auditFilename = dropped.map((d) => d.filename).join('; ');
  const auditRows = (meta.orderDetails || []).map((od) => ({
    ts: now.toISOString(), date, order: od.number, customer: od.customer, city: od.city, state: od.state,
    serviceTier: od.serviceTier, dryIceSlabs: od.dryIceSlabs, declareDryIce: od.declareDryIce ? 'yes' : 'no',
    contents: od.contents, filename: auditFilename, approvedBy: meta.decidedBy, sentVia: 'nightly-approval',
  }));
  const audit = await appendAuditRows(auditRows);

  await sendMail({
    to: ALERT_TO,
    subject: `Breadwright 3PL batch SENT — ${date} — ${meta.sendable} order(s)`,
    text: `Approved by ${meta.decidedBy} at ${meta.decidedAt}. Sent ${dropped.length} file(s), ${meta.sendable} order(s) to Ice Cube.` +
      (tagErrors.length ? `\n\n${tagErrors.length} Shopify tag-sent failure(s): ` + JSON.stringify(tagErrors) : '') +
      (audit.ok === false && !audit.skipped ? `\n\n⚠️ Audit log write failed: ${audit.error}` : ''),
  });
  console.log(`[nightly] sent ${date}: ${JSON.stringify(dropped)}, audit=${JSON.stringify(audit)}`);
  return { ok: true, sent: true, date, dropped, tagged, tagErrors, audit };
}

module.exports = { prepareNightly, sendNightly, decide, readMeta, dateStamp };
