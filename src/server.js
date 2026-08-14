/**
 * src/server.js
 * The always-on Railway worker. Exposes:
 *   GET  /health                 -> liveness
 *   POST /webhooks/shopify/orders -> Shopify orders/create|paid webhook
 *
 * Flow: verify HMAC -> normalize -> build Datex XML -> SFTP put (or dry-run).
 * Idempotent per Shopify order id (in-memory + optional on-disk marker) so a
 * re-delivered webhook never double-sends.
 *
 * Requires: npm i express   (ssh2-sftp-client only needed when DRY_RUN != 1)
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { verifyWebhook, normalizeOrder, confirmShipment, fetchOrderRawByNumber } = require('./shopify');
const { buildCustomerOrder } = require('./xml/buildOrder');
const { packSlipHtml } = require('./packslip');
const { resolveDryIceConditions } = require('../config/dryice');
const { putXml, peekList, peekFile, sendToTest, DRY_RUN } = require('./sftp');
const { runBatch } = require('./batch');

// Named Breadwright example orders the dashboard can fire as a live test.
const TEST_FIXTURES = {
  'founders-box': { file: 'order-1002.json', label: "Founder's Box (#1002 · 7 loaves — Seeded Sourdough ×2, Zone 2 MA)" },
  'six-loaf': { file: 'sample-shopify-order.json', label: 'Six single loaves (#13532 · Melrose MA)' },
};

const app = express();
const PORT = process.env.PORT || 3000;

// Minimal HTML/attribute escapers for the small server-rendered pages.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escAttr = esc;
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Read-only status peek (for the dynaradigital dashboard). Key-gated; the key is
// held server-side by the dashboard proxy and never reaches a browser.
const PEEK_KEY = process.env.PEEK_KEY;
const PEEK_DIRS = ['/Test/to-icecube', '/Test/to-breadwright', '/Test/to-breadwright/processed', '/Test/Archive', '/Test/Error'];
const PEEK_ALLOWED = ['/Test', '/Datex'];

// Capture the raw body for HMAC verification.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

// Simple idempotency store (swap for Redis/Postgres if you outgrow one instance).
const SENT_DIR = path.join(__dirname, '../out/.sent');
fs.mkdirSync(SENT_DIR, { recursive: true });
const alreadySent = (id) => fs.existsSync(path.join(SENT_DIR, `${id}.json`));
const markSent = (id, meta) => fs.writeFileSync(path.join(SENT_DIR, `${id}.json`), JSON.stringify(meta));

app.get('/health', (_req, res) => res.json({ ok: true, dryRun: DRY_RUN }));

app.get('/peek', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  try {
    res.json({ dryRun: DRY_RUN, outboundDir: process.env.DATEX_SFTP_OUTBOUND_DIR, folders: await peekList(PEEK_DIRS) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/peek/file', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).send('unauthorized');
  const p = req.query.path || '';
  if (p.includes('..') || !PEEK_ALLOWED.some((pre) => p === pre || p.startsWith(pre + '/'))) {
    return res.status(400).send('path not allowed');
  }
  try {
    res.type('text/plain').send(await peekFile(p));
  } catch (e) {
    res.status(500).send(e.message.split(' - ')[0]);
  }
});

// List the available example orders (for the dashboard to render buttons).
app.get('/peek/test-fixtures', (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  res.json({ fixtures: Object.entries(TEST_FIXTURES).map(([id, f]) => ({ id, label: f.label })) });
});

// LIVE test-order drop. Builds a Breadwright example order and SFTP-puts it into
// /Test regardless of DRY_RUN — this is the "send Bill a real test" button. It
// only ever writes to the /Test staging folder, never the production import dir.
app.post('/peek/send-test', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  const which = TEST_FIXTURES[req.query.fixture] || TEST_FIXTURES['founders-box'];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures', which.file), 'utf8'));
    const order = normalizeOrder(raw);
    const { xml, warnings, pack } = buildCustomerOrder(order);
    // Unique-ish name so repeated live tests don't overwrite each other.
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `BW_${order.number}_TEST_${stamp}.xml`;
    const drop = await sendToTest(filename, xml);
    console.log(`[send-test] dropped ${filename} -> ${drop.dir}`);
    const slipHtml = packSlipHtml(pack, order);
    res.json({ ok: true, fixture: which.label, filename, warnings, pack, xml, slipHtml, ...drop });
  } catch (e) {
    console.error('[send-test] FAILED:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// PACKING-SLIP PREVIEW (public, read-only). Lets Bill SEE example packing lists
// — order number + small Code 128 barcode — in his browser via a plain link,
// instead of us dropping test orders into his WMS. Example data only; no SFTP,
// no Shopify writes, no creds. /packslip = gallery, /packslip/:id = one slip.
// ---------------------------------------------------------------------------
function slipForFixture(id) {
  const which = TEST_FIXTURES[id];
  if (!which) return null;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures', which.file), 'utf8'));
  const order = normalizeOrder(raw);
  const { pack } = buildCustomerOrder(order);
  return { html: packSlipHtml(pack, order), order, label: which.label };
}

app.get('/packslip', (req, res) => {
  const key = req.query.key ? `?key=${encodeURIComponent(req.query.key)}` : '';
  const kv = req.query.key ? escAttr(req.query.key) : '';
  const cards = Object.entries(TEST_FIXTURES).map(([id, f]) => {
    let num = '';
    try { num = slipForFixture(id).order.number; } catch (_) {}
    return `<li><a href="/packslip/${id}">Order #${num}</a> — ${f.label}</li>`;
  }).join('');
  res.type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Breadwright pack lists</title>` +
    `<style>body{font:15px/1.5 -apple-system,Segoe UI,Arial;max-width:640px;margin:40px auto;padding:0 20px;color:#111}` +
    `h1{font-size:20px}h2{font-size:15px;margin-top:28px}li{margin:8px 0}a{color:#7a3;font-weight:600}` +
    `form{display:flex;gap:8px;margin:10px 0}input{padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:14px}` +
    `input[name=order]{flex:1}button{padding:8px 16px;border:0;border-radius:6px;background:#7a3;color:#fff;font-weight:600;cursor:pointer}</style>` +
    `<h1>Breadwright — pack lists</h1>` +
    `<h2>Any order</h2>` +
    `<p>Enter a live Shopify order number to preview its 4×6 pack list.</p>` +
    `<form action="/packslip/order" method="get">` +
    `<input name="order" placeholder="order number, e.g. 1042" autofocus>` +
    (req.query.key ? `<input type="hidden" name="key" value="${kv}">` : '') +
    `<button>View</button></form>` +
    `<h2>Examples</h2><ul>${cards.replace(/href="(\/packslip\/[^"]+)"/g, `href="$1${key}"`)}</ul>`
  );
});

// Live order lookup: ?order=<number> (&key=<PEEK_KEY> — real customer data).
// Fetches the order from Shopify, builds the same pack, renders the 4×6 slip.
app.get('/packslip/order', async (req, res) => {
  if (PEEK_KEY && req.query.key !== PEEK_KEY) return res.status(401).send('unauthorized — append ?key=<PEEK_KEY>');
  const number = String(req.query.order || '').trim();
  if (!number) return res.status(400).send('missing ?order=<number>');
  try {
    const raw = await fetchOrderRawByNumber(number);
    if (!raw) return res.status(404).send(`order #${esc(number)} not found`);
    const order = normalizeOrder(raw);
    const { pack } = buildCustomerOrder(order);
    res.type('html').send(packSlipHtml(pack, order));
  } catch (e) {
    res.status(500).send(esc(e.message));
  }
});

app.get('/packslip/:id', (req, res) => {
  try {
    const slip = slipForFixture(req.params.id);
    if (!slip) return res.status(404).send('unknown example — see /packslip');
    res.type('html').send(slip.html);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Build a CUSTOM demo order from dashboard-entered data (name / address / items).
// Same normalize->build path as send-test, so the XML + pack list are identical to
// what a real Shopify order would produce. Body = a Shopify-shaped order object.
// ?send=1 also drops it into the /Test staging folder (never production).
app.post('/peek/generate', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  try {
    const raw = req.body && req.body.order ? req.body.order : req.body;
    const order = normalizeOrder(raw);
    // Resolve live dry-ice conditions (weather + calendar-aware transit) so the
    // pack sheet shows the weather-driven amount. Never blocks: degrades to the
    // sync zone/season estimate inside resolveDryIceConditions on any failure.
    order.dryIceConditions = await resolveDryIceConditions({
      zip: order.shipping && order.shipping.postalCode,
      shipDate: (req.body && req.body.shipDate) || undefined,
    });
    const { xml, warnings, pack } = buildCustomerOrder(order);
    let drop = null;
    if (req.query.send === '1') {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const filename = `BW_${order.number}_TEST_${stamp}.xml`;
      drop = await sendToTest(filename, xml);
      console.log(`[generate] dropped ${filename} -> ${drop.dir}`);
    }
    const slipHtml = packSlipHtml(pack, order);
    res.json({ ok: true, number: order.number, warnings, pack, xml, slipHtml, drop });
  } catch (e) {
    console.error('[generate] FAILED:', e);
    res.status(500).json({ error: e.message });
  }
});

// Dry-ice calculator (dashboard panel). Given a ship-to ZIP + optional ship date,
// returns the weather- and transit-driven dry-ice amount the packer should use.
// Read-only; no order needed. Key-gated like the other /peek routes.
app.post('/peek/dryice', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  const { zip, shipDate, service, address } = req.body || {};
  if (!zip) return res.status(400).json({ error: 'zip required' });
  try {
    const result = await resolveDryIceConditions({
      zip,
      shipDate: shipDate || undefined,
      service: service || undefined,
      address: address || undefined,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[dryice] FAILED:', e);
    res.status(500).json({ error: e.message });
  }
});

// Trigger the end-of-day batch on demand (dashboard button or external cron
// hitting this URL). Key-gated; the key stays server-side in the dashboard proxy.
app.post('/batch/run', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  try {
    const summary = await runBatch();
    res.json({ ok: true, ...summary });
  } catch (e) {
    console.error('[batch/run] FAILED:', e);
    res.status(500).json({ error: e.message });
  }
});

// Warehouse ship-confirmation (return feed): write tracking back into Shopify.
// Key-gated like the other /peek routes. Only goes live when the caller passes
// live:true AND SHOPIFY_ADMIN_TOKEN is set; otherwise it's a dry-run.
app.post('/peek/ship-confirm', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  const { number, tracking, carrier, live } = req.body || {};
  if (!number || !tracking) return res.status(400).json({ error: 'number and tracking required' });
  try {
    const dryRun = !(live === true && !!process.env.SHOPIFY_ADMIN_TOKEN);
    const result = await confirmShipment({ number, tracking, carrier: carrier || 'UPS', dryRun });
    res.json(result);
  } catch (e) {
    console.error('[ship-confirm] FAILED:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/webhooks/shopify/orders', async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!verifyWebhook(req.rawBody, hmac, WEBHOOK_SECRET)) {
    return res.status(401).send('bad hmac');
  }
  // Ack fast so Shopify doesn't retry; do the work after responding.
  res.status(200).send('ok');

  const o = req.body;
  try {
    if (alreadySent(o.id)) {
      console.log(`[webhook] order ${o.id} already sent — skipping`);
      return;
    }
    const order = normalizeOrder(o);
    const { xml, warnings } = buildCustomerOrder(order);
    if (warnings.length) console.warn(`[webhook] order #${order.number} warnings:`, warnings);

    const filename = `BW_${order.number}_${o.id}.xml`;
    const result = await putXml(filename, xml);
    markSent(o.id, { number: order.number, filename, at: new Date().toISOString(), result, warnings });
    console.log(`[webhook] sent order #${order.number} (${filename})`);
  } catch (err) {
    // TODO: push to a dead-letter/retry queue. For now, log loudly.
    console.error(`[webhook] FAILED order ${o.id}:`, err);
  }
});

app.listen(PORT, () => {
  console.log(`Breadwright 3PL service on :${PORT} (DRY_RUN=${DRY_RUN ? 'on' : 'off'})`);
});
