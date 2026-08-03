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
const { verifyWebhook, normalizeOrder } = require('./shopify');
const { buildCustomerOrder } = require('./xml/buildOrder');
const { putXml, peekList, peekFile, DRY_RUN } = require('./sftp');

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Read-only status peek (for the dynaradigital dashboard). Key-gated; the key is
// held server-side by the dashboard proxy and never reaches a browser.
const PEEK_KEY = process.env.PEEK_KEY;
const PEEK_DIRS = ['/Test', '/Test/Archive', '/Test/Error'];
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
