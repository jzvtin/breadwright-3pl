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
const { verifyWebhook, normalizeOrder, confirmShipment, fetchOrderRawByNumber, fetchOrdersForBatch, tagOrderSent } = require('./shopify');
const { buildCustomerOrder, buildBatch } = require('./xml/buildOrder');
const { packSlipHtml } = require('./packslip');
const { resolveDryIceConditions } = require('../config/dryice');
const { putXml, peekList, peekFile, sendToTest, DRY_RUN } = require('./sftp');
const { registerDashboard } = require('./dashboard');
const { runBatch } = require('./batch');
const { buildOrdersCsv } = require('./ordersCsv');
const priority = require('./priorityshippers');

// Named Breadwright example orders the dashboard can fire as a live test.
const TEST_FIXTURES = {
  'founders-box': { file: 'order-1002.json', label: "Founder's Box (#1002 · 7 loaves — Seeded Sourdough ×2, Zone 2 MA)" },
  'six-loaf': { file: 'sample-shopify-order.json', label: 'Six single loaves (#13532 · Melrose MA)' },
};

// --- Unique test-order guard ---------------------------------------------
// Datex FootPrint rejects an import whose order number OR ship-to collides with
// one already in the WMS (Bill 2026-08-14: a re-fired #1002 failed as a dup).
// Every test drop therefore gets a fresh numeric order number AND a distinct,
// valid MA ship-to. Real customer orders never pass through here.
const TEST_SHIPTOS = [
  { first_name: 'John',   last_name: 'Smith',    address1: '12 Baker St',        city: 'Boston',      province_code: 'MA', zip: '02108' },
  { first_name: 'Emily',  last_name: 'Carter',   address1: '88 Elm St',          city: 'Cambridge',   province_code: 'MA', zip: '02139' },
  { first_name: 'David',  last_name: 'Nguyen',   address1: '145 Highland Ave',   city: 'Somerville',  province_code: 'MA', zip: '02143' },
  { first_name: 'Sarah',  last_name: 'OBrien',   address1: '27 Pleasant St',     city: 'Worcester',   province_code: 'MA', zip: '01609' },
  { first_name: 'Marcus', last_name: 'Bell',     address1: '310 Chestnut St',    city: 'Springfield', province_code: 'MA', zip: '01104' },
  { first_name: 'Aisha',  last_name: 'Patel',    address1: '64 Maple Ave',       city: 'Lowell',      province_code: 'MA', zip: '01852' },
  { first_name: 'Tom',    last_name: 'Reilly',   address1: '9 Beach St',         city: 'Quincy',      province_code: 'MA', zip: '02169' },
  { first_name: 'Grace',  last_name: 'Kim',      address1: '201 Union St',       city: 'New Bedford', province_code: 'MA', zip: '02740' },
];
let TEST_SEQ = 0;
// Rewrite a Shopify-shaped raw order so it is guaranteed unique on this drop:
// numeric order number `<base><hhmmss><seq>` and a rotating distinct ship-to
// (persona + `Unit <tag>` so the literal address never repeats). If keepAddr is
// true (custom dashboard order), keep the typed address but still force a unique
// number and stamp address2 so two identical inputs don't collide in Datex.
function uniqueTestOrder(raw, { keepAddr = false } = {}) {
  const now = new Date();
  const hhmmss = now.toISOString().replace(/[-:T]/g, '').slice(8, 14); // hhmmss
  const seq = TEST_SEQ++ % 1000;
  const tag = `${hhmmss}${seq}`;
  const base = String(raw.order_number || (raw.name || '').replace(/[^0-9]/g, '') || '1000');
  const number = `${base}${tag}`;
  const persona = TEST_SHIPTOS[seq % TEST_SHIPTOS.length];
  let ship, bill;
  if (keepAddr) {
    const src = raw.shipping_address || raw.billing_address || {};
    ship = bill = { ...src, address2: src.address2 || `Unit ${tag}`, country_code: src.country_code || 'US' };
  } else {
    ship = bill = { ...persona, address2: `Unit ${tag}`, country_code: 'US', phone: '5085550100' };
  }
  return {
    ...raw,
    name: `#${number}`,
    order_number: number,
    customer: keepAddr ? raw.customer : { ...(raw.customer || {}), first_name: ship.first_name, last_name: ship.last_name },
    billing_address: bill,
    shipping_address: ship,
  };
}
// -------------------------------------------------------------------------

const app = express();
const PORT = process.env.PORT || 3000;

// Minimal HTML/attribute escapers for the small server-rendered pages.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escAttr = esc;
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Read-only status peek (for the dynaradigital dashboard). Key-gated; the key is
// held server-side by the dashboard proxy and never reaches a browser.
const PEEK_KEY = process.env.PEEK_KEY;
// Live Datex FootPrint folders (Bill deleted the old /Test/to-icecube + /Test/to-breadwright
// convention 2026-08-18; the real paths are under /Datex). WE drop orders in Import/Test;
// Ice Cube posts ship-confirms in Export/Test; Datex moves imported files to Archive / rejects to Error.
const PEEK_DIRS = ['/Datex/Import/Test', '/Datex/Export/Test', '/Test/Archive', '/Test/Error'];
const PEEK_ALLOWED = ['/Test', '/Datex'];

// Capture the raw body for HMAC verification.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

// Simple idempotency store (swap for Redis/Postgres if you outgrow one instance).
const SENT_DIR = path.join(__dirname, '../out/.sent');
fs.mkdirSync(SENT_DIR, { recursive: true });
const alreadySent = (id) => fs.existsSync(path.join(SENT_DIR, `${id}.json`));
const markSent = (id, meta) => fs.writeFileSync(path.join(SENT_DIR, `${id}.json`), JSON.stringify(meta));

// PENDING REVIEW STORE. The Shopify orders/paid webhook STAGES each raw order
// here (it does NOT auto-send); the console lists them and the operator confirms
// each one. On-disk so it survives a process restart (a full Railway REDEPLOY
// still clears it — acceptable; the order can be re-pushed or re-exported).
// No Shopify Admin token needed: confirm-send rebuilds from the stored payload.
const PENDING_DIR = path.join(__dirname, '../out/.pending');
fs.mkdirSync(PENDING_DIR, { recursive: true });
const pendingPath = (id) => path.join(PENDING_DIR, `${id}.json`);
function savePending(id, rec) { fs.writeFileSync(pendingPath(id), JSON.stringify(rec)); }
function removePending(id) { try { fs.unlinkSync(pendingPath(id)); } catch (_) {} }
function listPending() {
  return fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8')); } catch (_) { return null; }
  }).filter(Boolean);
}
function findPendingByNumber(number) {
  const bare = String(number).replace(/^#/, '');
  return listPending().find((r) => String(r.number).replace(/^#/, '') === bare) || null;
}

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
    // Force a unique order number + distinct ship-to so Datex never rejects a
    // re-fired test as a duplicate (Bill 2026-08-14).
    const order = normalizeOrder(uniqueTestOrder(raw));
    const { xml, warnings, pack } = buildCustomerOrder(order);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `BW_${order.number}_TEST_${stamp}.xml`;
    const drop = await sendToTest(filename, xml);
    console.log(`[send-test] dropped ${filename} (#${order.number} -> ${order.shipping.city}) -> ${drop.dir}`);
    const slipHtml = packSlipHtml(pack, order);
    const shipTo = `${order.shipping.accountName} — ${order.shipping.addressLine1}, ${order.shipping.city} ${order.shipping.state} ${order.shipping.postalCode}`;
    res.json({ ok: true, fixture: which.label, number: order.number, shipTo, filename, warnings, pack, xml, slipHtml, ...drop });
  } catch (e) {
    console.error('[send-test] FAILED:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// REVIEW QUEUE (pull-on-demand + human confirm). Nothing here auto-sends.
//   GET  /peek/pending          -> today's paid/unshipped/un-3pl-sent orders,
//                                  each with generated XML + pack list + warnings
//                                  + a `blocking` list (empty => safe to send).
//   POST /peek/confirm-send      -> re-build one order, drop it to Ice Cube, tag
//                                  it 3pl-sent. Server RE-CHECKS blocking and
//                                  refuses (409) — never trusts the client button.
// Both key-gated; the key stays server-side in the console proxy. Requires a
// valid SHOPIFY_ADMIN_TOKEN (read_orders + write_orders). Idempotent via the
// Shopify `3pl-sent` tag, so a double-click / restart cannot double-drop.
// ---------------------------------------------------------------------------
function summarizeOrder(raw) {
  const order = normalizeOrder(raw);
  // Dry ice is deterministic by service tier (buildCustomerOrder handles it), so
  // no per-order weather lookup is needed here.
  const { xml, warnings, blocking, pack } = buildCustomerOrder(order);
  const s = order.shipping || {};
  const shipTo = [s.addressLine1, s.addressLine2, [s.city, s.state, s.postalCode].filter(Boolean).join(' ')]
    .map((x) => (x || '').trim())
    .filter(Boolean)
    .join(', ');
  return {
    number: order.number,
    orderId: order.orderId,
    customer: s.accountName || '',
    shipTo,
    city: s.city || '',
    state: s.state || '',
    serviceLevel: order.serviceLevel,
    serviceTier: order.serviceTier,
    isFirstOrder: !!order.isFirstOrder,
    warnings,
    blocking,
    canSend: (blocking || []).length === 0,
    pack,
    xml,
  };
}

app.get('/peek/pending', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  const windowHours = Math.min(Math.max(Number(req.query.hours) || 25, 1), 24 * 30);
  try {
    // Primary source: orders staged by the Shopify webhook (no token needed).
    const byNumber = new Map();
    for (const rec of listPending()) {
      if (alreadySent(rec.id)) continue; // dropped since staging
      const sum = summarizeOrder(rec.raw);
      sum.receivedAt = rec.receivedAt;
      byNumber.set(String(sum.number), sum);
    }
    // Bonus: if a valid Admin token is configured, also pull via the API and
    // merge (webhook-staged wins on collision). Silently ignored without a token.
    if (process.env.SHOPIFY_ADMIN_TOKEN) {
      try {
        const raws = await fetchOrdersForBatch({ windowHours, sentTag: '3pl-sent' });
        for (const raw of raws) {
          const sum = summarizeOrder(raw);
          if (!byNumber.has(String(sum.number))) byNumber.set(String(sum.number), sum);
        }
      } catch (e) {
        console.warn('[pending] Admin API merge skipped:', e.message);
      }
    }
    const orders = Array.from(byNumber.values());
    res.json({ dryRun: DRY_RUN, windowHours, source: 'webhook', count: orders.length, orders });
  } catch (e) {
    console.error('[pending] FAILED:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/peek/confirm-send', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  const number = String(req.query.number || (req.body && req.body.number) || '').trim();
  if (!number) return res.status(400).json({ error: 'missing ?number=<order number>' });
  try {
    // Rebuild from the webhook-staged payload (no Admin token). Fall back to a
    // live fetch only if a token is configured and the order isn't staged.
    const rec = findPendingByNumber(number);
    let raw = rec && rec.raw;
    if (!raw && process.env.SHOPIFY_ADMIN_TOKEN) raw = await fetchOrderRawByNumber(number);
    if (!raw) {
      return res.status(404).json({ error: `order #${number} not in the review queue (staged orders are cleared on redeploy — re-push or re-export)` });
    }
    const order = normalizeOrder(raw);
    // Idempotency: never drop the same order twice (survives restarts on disk).
    if (alreadySent(order.orderId)) { removePending(order.orderId); return res.json({ ok: true, already: true, number: order.number }); }
    order.dryIceConditions = await resolveDryIceConditions({ zip: order.shipping && order.shipping.postalCode });
    const { xml, warnings, blocking, pack } = buildCustomerOrder(order);
    // Defense in depth: the console disables Confirm on blocked orders, but the
    // server must refuse independently so bad data can never reach Ice Cube.
    if ((blocking || []).length) return res.status(409).json({ error: 'order is blocked', blocking, number: order.number });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `BW_${order.number}_${stamp}.xml`;
    const drop = await putXml(filename, xml);
    markSent(order.orderId, { number: order.number, filename, at: new Date().toISOString() });
    removePending(order.orderId);
    // Tag back to Shopify only if a token is configured; the drop already
    // succeeded and the on-disk sent-marker is the real idempotency guard.
    let tagged = false;
    if (process.env.SHOPIFY_ADMIN_TOKEN) {
      try { await tagOrderSent(order.orderId); tagged = true; }
      catch (e) { warnings.push(`Dropped OK but Shopify tagging failed: ${e.message}`); }
    }
    console.log(`[confirm-send] dropped ${filename} (#${order.number}) -> ${JSON.stringify(drop)}`);
    res.json({ ok: true, number: order.number, filename, drop, tagged, warnings, pack });
  } catch (e) {
    console.error('[confirm-send] FAILED:', e);
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
    const rawIn = req.body && req.body.order ? req.body.order : req.body;
    // A custom order that will actually be SENT to Bill must also be unique.
    // Keep the operator's typed address, but force a unique number + stamp.
    const raw = req.query.send === '1' ? uniqueTestOrder(rawIn, { keepAddr: true }) : rawIn;
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

// Priority Shippers (Yahuda) live rate compare — the CHEAPEST-lane picker that
// replaces ShipStation. Read-only: calls get-rates only (no label bought). Works
// from a MANUAL address+weight (like /peek/dryice), so it is NOT blocked by the
// Shopify token. Optionally pass ?number= to auto-fill from a Shopify order once
// the token is valid.
//   POST /peek/priority-rate?key=..  body {to:{...}|zip, weightLb, dims, shipDate, dryIceLb, deadline}
app.post('/peek/priority-rate', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  const b = req.body || {};
  try {
    // Accept either a full `to` object or loose fields (zip-only is enough to rate).
    const to = b.to || {
      address_1: b.address_1 || b.address || '',
      city: b.city || '',
      state: b.state || '',
      zip: b.zip || '',
      country: b.country || 'US',
      residential: b.residential !== false, // Breadwright ships DTC -> residential default
      name: b.name || 'Customer',
    };
    if (!to.zip) return res.status(400).json({ error: 'zip (or to.zip) required' });

    const w = Number(b.weightLb || b.weight || 8);
    const pkg = { weight: w > 0 ? w : 8 };
    if (b.length) pkg.length = Number(b.length);
    if (b.width) pkg.width = Number(b.width);
    if (b.height) pkg.height = Number(b.height);

    const r = await priority.getRates({
      to,
      packages: [pkg],
      ship_date: b.shipDate || undefined,
      dryIceLb: b.dryIceLb ? Number(b.dryIceLb) : 0,
    });
    if (!r.ok) return res.status(r.fail && r.fail.http === 401 ? 401 : 422).json({ ok: false, ...r.fail, carrier_errors: r.errors });

    const pick = priority.cheapestByDeadline(r.rates, b.deadline || null);
    res.json({
      ok: true,
      to: { zip: to.zip, city: to.city, state: to.state },
      cheapest_overall: r.rates[0] || null,
      pick_for_deadline: b.deadline ? pick : null,
      deadline: b.deadline || null,
      rates: r.rates,
      carrier_errors: r.errors,
    });
  } catch (e) {
    console.error('[priority-rate] FAILED:', e);
    res.status(502).json({ error: e.message });
  }
});

// Ingest Ice Cube's "completed shipments" confirmation file (BWCompletedShipments_*.xml):
// parse -> plain-English summary (no more eyeballing 16 material rows for a 6-loaf order)
// -> email the ops team so they know it landed and can eyeball it. Read-only re: Shopify.
//   POST /peek/confirm-file?key=..  body { xml:"<...>", fileName?, notify?:true }
app.post('/peek/confirm-file', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  const b = req.body || {};
  const xml = b.xml || b.content || '';
  if (!xml || !String(xml).includes('table1_Details_Group')) {
    return res.status(400).json({ error: 'body.xml must be the Datex completed-shipments XML (no <table1_Details_Group> rows found)' });
  }
  try {
    const conf = require('./confirmations');
    const { sendMail } = require('./mailer');
    const rows = conf.parseCompletedShipments(xml);
    const summary = conf.summarize(rows);
    const fileDate = (String(b.fileName || '').match(/(\d{4}-?\d{2}-?\d{2})/) || [])[1] || null;
    const text = conf.plainText(summary, { fileDate });
    const flagged = summary.orders.filter((o) => o.unknown);

    let email = { sent: false };
    if (b.notify !== false) {
      const subject = `Ice Cube shipped ${summary.count} order(s)${flagged.length ? ` — ${flagged.length} to check` : ''}`;
      email = await sendMail({ subject, text });
    }
    res.json({
      ok: true,
      count: summary.count,
      orders: summary.orders,
      report: text,
      flagged: flagged.map((o) => o.order),
      email,
    });
  } catch (e) {
    console.error('[confirm-file] FAILED:', e);
    res.status(500).json({ error: e.message });
  }
});

// Build the branded Shipment Confirmation reconciliation doc (HTML, print/PDF-ready)
// from a posted confirmation XML: parse shipped contents, enrich each order from
// Shopify (destination + tracking + expected build + box name), reconcile
// Match/Variance, render. ?format=json returns the structured rows instead of HTML.
//   POST /peek/confirm-doc?key=..  body { xml, fileName? }
app.post('/peek/confirm-doc', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  const b = req.body || {};
  const xml = b.xml || b.content || '';
  if (!xml || !String(xml).includes('table1_Details_Group')) {
    return res.status(400).json({ error: 'body.xml must be the Datex completed-shipments XML' });
  }
  try {
    const conf = require('./confirmations');
    const { renderConfirmDoc, contentsLine } = require('./confirmDoc');
    const BREAD = new Set(['BW_CSD', 'BW_MGP', 'BW_CRANPEC', 'BW_PFRAN', 'BW_DB2PK', 'BW_SEEDSD']);

    // shipped bread map per order, straight from the confirmation rows
    const rows = conf.parseCompletedShipments(xml);
    const shippedByOrder = {};
    const svcByOrder = {};
    for (const r of rows) {
      svcByOrder[r.order] = r.service || svcByOrder[r.order];
      if (BREAD.has(r.code)) (shippedByOrder[r.order] = shippedByOrder[r.order] || {})[r.code] = (shippedByOrder[r.order][r.code] || 0) + r.qty;
    }
    const numbers = Object.keys(shippedByOrder).sort((a, z) => Number(a) - Number(z));

    const docRows = [];
    for (const n of numbers) {
      const shipped = shippedByOrder[n];
      const unitsShipped = Object.values(shipped).reduce((s, q) => s + q, 0);
      let dest = '', tracking = '', boxName = null, expected = null, blocked = null;
      try {
        const raw = await fetchOrderRawByNumber(n);
        if (raw) {
          const order = normalizeOrder(raw);
          dest = [order.shipping.city, order.shipping.state].filter(Boolean).join(', ');
          tracking = ((raw.fulfillments || []).map((f) => f.tracking_number).filter(Boolean))[0] || '';
          const boxLine = (raw.line_items || []).find((li) => /box/i.test(li.title || ''));
          if (boxLine) boxName = boxLine.title;
          try {
            const built = buildCustomerOrder(order);
            expected = {};
            (built.pack.contents || []).forEach((c) => { if (BREAD.has(c.code)) expected[c.code] = (expected[c.code] || 0) + c.qty; });
          } catch (e) { blocked = e.message; }
        }
      } catch (e) { blocked = e.message; }

      // reconcile shipped vs expected
      let status = 'Match', variances = [], unitsMatched = unitsShipped;
      if (expected) {
        const codes = new Set([...Object.keys(expected), ...Object.keys(shipped)]);
        for (const c of codes) {
          if ((expected[c] || 0) !== (shipped[c] || 0)) variances.push(`${c}: ordered ${expected[c] || 0} / shipped ${shipped[c] || 0}`);
        }
        if (variances.length) { status = 'Variance'; unitsMatched = unitsShipped - variances.length; }
      } else {
        status = 'Shipped'; // couldn't pull the order to reconcile — report as shipped, unverified
      }
      docRows.push({ order: '#' + n, service: svcByOrder[n] || '', dest, tracking, boxName, contents: contentsLine(shipped), status, variances, unitsShipped, unitsMatched });
    }

    const fileDate = (String(b.fileName || '').match(/(\d{2,4})-?(\d{2})-?(\d{2})/) || []);
    const ymd = fileDate.length ? `20${String(fileDate[1]).slice(-2)}-${fileDate[2]}-${fileDate[3]}` : new Date().toISOString().slice(0, 10);
    const issued = new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    const doc = {
      ref: `BW-SC-${ymd}`,
      fileName: b.fileName || '(pasted)',
      issued,
      orderRange: numbers.length ? `#${numbers[0]}–#${numbers[numbers.length - 1]}` : '—',
      standardPack: '1 × BW_BOX14, 2 × BW_GELPK, 1 × BW_GCF1, 1 × BW_GCF2',
      rows: docRows,
    };
    if (req.query.format === 'json') return res.json({ ok: true, doc });
    res.type('html').send(renderConfirmDoc(doc));
  } catch (e) {
    console.error('[confirm-doc] FAILED:', e);
    res.status(500).json({ error: e.message });
  }
});

// Manually run the confirmation-folder scan now (dashboard button / testing).
// ?force=1 re-processes files already seen this session AND may email them.
app.post('/peek/poll-now', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  try {
    const out = await require('./confirmPoller').runOnce({ force: req.query.force === '1' });
    res.json({ ok: true, dir: require('./confirmPoller').RETURN_DIR, ...out });
  } catch (e) {
    console.error('[poll-now] FAILED:', e);
    res.status(502).json({ error: e.message });
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
    // STAGE for human review — do NOT auto-send. Store the raw payload so
    // confirm-send can rebuild it later without any Shopify Admin token.
    const order = normalizeOrder(o);
    const { warnings, blocking } = buildCustomerOrder(order);
    savePending(o.id, { id: o.id, number: order.number, raw: o, receivedAt: new Date().toISOString() });
    console.log(
      `[webhook] staged order #${order.number} for review` +
        (blocking && blocking.length ? ` (BLOCKED: ${blocking.join('; ')})` : '') +
        (warnings && warnings.length ? ` (warnings: ${warnings.length})` : '')
    );
  } catch (err) {
    console.error(`[webhook] FAILED to stage order ${o.id}:`, err);
  }
});

// Orders CSV export (real customer data — key-gated like /peek/*).
//   GET /orders.csv?key=<PEEK_KEY>[&since=2026-01-01][&download=1]
// Pulls every order live from Shopify via the dedicated read-only export token
// (SHOPIFY_EXPORT_STORE / SHOPIFY_EXPORT_TOKEN) and streams a CSV. No disk write,
// so Railway's ephemeral filesystem is a non-issue.
app.get('/orders.csv', async (req, res) => {
  // Accepts PEEK_KEY (operator) OR a dedicated export-only EXPORT_KEY. The
  // export key unlocks NOTHING but this CSV, so it is safe to embed in a shared
  // Google Sheet / hand to the store owner. PEEK_KEY must never be shared.
  const ok = (PEEK_KEY && req.query.key === PEEK_KEY) ||
             (process.env.EXPORT_KEY && req.query.key === process.env.EXPORT_KEY);
  if (!ok) return res.status(401).send('unauthorized — append ?key=<key>');
  try {
    const { csv, count } = await buildOrdersCsv({ since: req.query.since, full: req.query.full });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Order-Count', String(count));
    if (req.query.download) {
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Disposition', `attachment; filename="breadwright-orders-${stamp}.csv"`);
    }
    res.send(csv);
  } catch (e) {
    res.status(502).send(`export failed: ${e.message}`);
  }
});

// Inspect the Datex XML a single order WOULD produce (read-only, no send).
//   GET /peek/order-xml?key=<PEEK_KEY>&number=1038
// Pulls the live order from Shopify, normalizes, builds the customer-order XML.
app.get('/peek/order-xml', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).send('unauthorized');
  const number = req.query.number;
  if (!number) return res.status(400).send('missing ?number=');
  try {
    const raw = await fetchOrderRawByNumber(number);
    if (!raw) return res.status(404).send('order ' + number + ' not found');
    if (req.query.raw) {
      return res.json({
        name: raw.name,
        note_attributes: raw.note_attributes || [],
        line_items: (raw.line_items || []).map((li) => ({
          title: li.title, sku: li.sku, quantity: li.quantity,
          properties: li.properties || [],
        })),
      });
    }
    const order = normalizeOrder(raw);
    order.dryIceConditions = await resolveDryIceConditions({ zip: order.shipping && order.shipping.postalCode });
    const { xml, warnings, blocking } = buildCustomerOrder(order);
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    // Surface warnings/blocking as an XML comment in the body (headers can't hold
    // non-ASCII like em-dashes/°). Comment-safe: strip any "--" sequences.
    // ?clean=1 => pure XML for the Ice Cube email attachment (no inspector comment).
    if (req.query.clean) { res.send(xml); return; }
    const note = [];
    if (blocking && blocking.length) note.push('BLOCKING:\n- ' + blocking.join('\n- '));
    if (warnings && warnings.length) note.push('WARNINGS:\n- ' + warnings.join('\n- '));
    const banner = note.length ? '<!--\n' + note.join('\n').replace(/--/g, '- -') + '\n-->\n' : '';
    res.send(banner + xml);
  } catch (e) {
    res.status(502).send('build failed: ' + e.message);
  }
});

// COST-CONTROL rate preview (READ-ONLY, buys nothing). For an order, rate-shops
// UPS and returns the LOCKED service by the rule: cheapest that arrives <=2
// business days => UPS Ground if it delivers in <=2 days, else UPS 2nd Day Air.
//   GET /peek/rate?key=<PEEK_KEY>&number=1036
app.get('/peek/rate', async (reqE, res) => {
  if (!PEEK_KEY || reqE.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  const number = reqE.query.number;
  if (!number) return res.status(400).json({ error: 'missing ?number=' });
  try {
    const ss = require('./shipstation');
    const raw = await fetchOrderRawByNumber(number);
    if (!raw) return res.status(404).json({ error: 'order ' + number + ' not found' });
    const order = normalizeOrder(raw);
    const { shipment } = ss.buildTestShipment(order, { includePackaging: true });
    // Explicit ship-from = the Ice Cube warehouse (label origin). Fixes the
    // "Ship Address Line 1 missing" invalid-rate flag from an incomplete warehouse.
    // ship_from and warehouse_id are mutually exclusive — drop the warehouse.
    delete shipment.warehouse_id;
    shipment.ship_from = {
      name: 'Breadwright', company_name: 'Ice Cube Cold Storage', phone: '5086857346',
      address_line1: '451 Currant Road', city_locality: 'Fall River',
      state_province: 'MA', postal_code: '02720', country_code: 'US',
      address_residential_indicator: 'no',
    };
    const UPS = process.env.SHIPSTATION_UPS_CARRIER_ID || 'se-6593179';
    const r = await ss.getRates(shipment, [UPS]);
    if (reqE.query.debug) return res.json({ sent_shipment: shipment, ups_carrier: UPS, raw: r });
    const rr = (r.body && r.body.rate_response) || {};
    // Prices live in valid `rates`; if a validation flag pushed them to
    // `invalid_rates`, the amounts are still accurate — use both for the preview.
    const rates = [...(rr.rates || []), ...(rr.invalid_rates || [])];
    const amt = (x) => (x && x.shipping_amount && x.shipping_amount.amount);
    const days = (x) => (x && (x.delivery_days != null ? x.delivery_days : x.carrier_delivery_days));
    const cheapest = (code) => rates.filter((x) => x.service_code === code)
      .sort((a, b) => (amt(a) || 1e9) - (amt(b) || 1e9))[0] || null;
    const ground = cheapest('ups_ground');
    const air2 = cheapest('ups_2nd_day_air');
    const gDays = days(ground);
    const groundOk = ground && gDays != null && gDays <= 2;
    const lockedCode = groundOk ? 'ups_ground' : 'ups_2nd_day_air';
    const chosen = groundOk ? ground : air2;
    res.json({
      order: order.number,
      locked_service: lockedCode,
      locked_label: groundOk ? 'UPS Ground' : 'UPS 2nd Day Air',
      price: amt(chosen),
      reason: groundOk ? `ground delivers in ${gDays} business day(s) (<=2)` : 'ground too slow (>2 days) or unavailable -> 2nd Day Air',
      ground: ground ? { price: amt(ground), days: gDays } : null,
      second_day_air: air2 ? { price: amt(air2), days: days(air2) } : null,
      rates_returned: rates.length,
      errors: (r.body && r.body.rate_response && r.body.rate_response.errors) || null,
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Read-only ShipStation account state — which carriers (UPS?) are connected +
// funding. Buys NOTHING. Answers "can we print UPS labels yet?".
app.get('/peek/carriers', async (reqE, res) => {
  if (!PEEK_KEY || reqE.query.key !== PEEK_KEY) return res.status(401).json({ error: 'unauthorized' });
  try {
    const ss = require('./shipstation');
    const carriers = await ss.req('GET', '/v2/carriers');
    res.json(carriers);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Combined Datex XML for MULTIPLE orders (one <Orders> batch envelope) — for
// Sam to attach ONE file covering several orders to his Ice Cube email.
//   GET /peek/batch-xml?key=<PEEK_KEY>&numbers=1036,1035,1034
app.get('/peek/batch-xml', async (req, res) => {
  if (!PEEK_KEY || req.query.key !== PEEK_KEY) return res.status(401).send('unauthorized');
  const numbers = String(req.query.numbers || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!numbers.length) return res.status(400).send('missing ?numbers=1036,1035');
  try {
    const orders = [];
    const missing = [];
    for (const n of numbers) {
      const raw = await fetchOrderRawByNumber(n);
      if (raw) orders.push(normalizeOrder(raw)); else missing.push(n);
    }
    if (!orders.length) return res.status(404).send('no orders found for: ' + numbers.join(','));
    const { xml, count } = buildBatch(orders);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('X-Order-Count', String(count));
    if (missing.length) res.setHeader('X-Missing', missing.join(','));
    res.send(xml);
  } catch (e) {
    res.status(502).send('batch build failed: ' + e.message);
  }
});

// Operator console at / (api.breadwright.com) — registered last so it only
// claims the root path, never shadowing /health, /peek/*, /packslip/*, etc.
registerDashboard(app);

app.listen(PORT, () => {
  console.log(`Breadwright 3PL service on :${PORT} (DRY_RUN=${DRY_RUN ? 'on' : 'off'})`);
  require('./confirmPoller').start(); // 5-min SFTP return-folder watcher (gated by POLL_CONFIRMATIONS=1)
});
