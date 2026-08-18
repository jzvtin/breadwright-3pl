/**
 * src/shipstation.js
 * ---------------------------------------------------------------------------
 * ShipStation v2 (api.shipstation.com) client + order->shipment mapper.
 *
 * WHY v2 shipments (not "orders"): this account's key is a v2 key. v2 has NO
 * /v2/orders endpoint (404) — order management + the classic pick-list PDF live
 * on the v1 legacy API (needs a Key+Secret pair we don't have). What v2 CAN do:
 * create shipments carrying full line items, buy labels, list warehouses/tags.
 *
 * The account's real customer orders already arrive via the native Shopify
 * connector, but they show the Founder's Box as ONE SKU (BW-BOX-01) — the
 * warehouse can't see the 6 loaves. This module EXPLODES a box into its
 * component loaves so a shipment shows exactly what to pick.
 *
 * Bill's UPDATED test request (2026-08-13, superseding the 2026-08-10 "loaves
 * only" ask): put 2 test orders on the server showing EVERYTHING we inventory —
 * the loaves PLUS the realistic packaging (cardboard box, Green Cell Foam panels
 * GCF1/GCF2, gel packs, info sheet). This all belongs on the ShipStation PACK
 * LIST (the shipment items), NOT in the Datex XML. Dry ice is excluded (not an
 * inventoried material). buildTestShipment() honors that: includePackaging
 * defaults TRUE and appends cfg.PACKAGING as pack-list items.
 *
 * Two ShipStation TAGS per shipment so Bill can filter "how many days shipped":
 *   - the service level (1_DAY / 2_DAY / ...) — Datex <VendorReference>
 *   - the Ice Cube owner code (BWICCS) — Datex <OwnerReference>
 * ---------------------------------------------------------------------------
 */
const https = require('https');
const cfg = require('../config/materials');

const BASE = 'api.shipstation.com';
const API_KEY = process.env.SHIPSTATION_API_KEY || '';
// Default ship-from = the account's default warehouse (Breadwright Fulfillment,
// 451 Currant Rd, Fall River MA). Override via env if it ever changes.
const WAREHOUSE_ID = process.env.SHIPSTATION_WAREHOUSE_ID || 'se-2278457';

// Descriptions + realistic empty weights (oz) for the packaging materials, which
// are NOT in CASE_PACK. Used only for the pack list / package weight estimate.
const PACK_MATERIAL = {
  BW_BOX14: { desc: 'Cardboard shipping box 14x14x14', oz: 12 },
  BW_GCF1: { desc: 'Green Cell Foam set 1 (Top/Long Side/Bottom)', oz: 8 },
  BW_GCF2: { desc: 'Green Cell Foam set 2 (Side/Long Side/Side)', oz: 8 },
  BW_GELPK: { desc: 'Gel pack', oz: 16 },
  BW_Infosheet: { desc: 'Info sheet insert', oz: 1 },
  BW_BFP: { desc: 'Brown freezer paper', oz: 1 },
};

/** Per-unit weight in OUNCES for a WMS code (loaf via CASE_PACK, else packaging). */
function unitOz(code) {
  const c = cfg.CASE_PACK[code] || {};
  if (c.unitWeightOz != null) return c.unitWeightOz;
  if (c.unitWeightLb != null) return c.unitWeightLb * 16;
  if (c.caseWeightLb != null && c.unitsPerCase) return round1((c.caseWeightLb / c.unitsPerCase) * 16);
  if (PACK_MATERIAL[code] && PACK_MATERIAL[code].oz != null) return PACK_MATERIAL[code].oz;
  return 16; // safe fallback: assume 1 lb
}

/** cfg.PACKAGING pick items (box / GCF1 / GCF2 / gel) as ShipStation items.
 *  These are the SAME picked items the Datex XML carries. */
function packagingItems() {
  return (cfg.PACKAGING || []).map((p) => ({
    name: (cfg.CASE_PACK[p.code] || {}).desc || (PACK_MATERIAL[p.code] || {}).desc || p.code,
    sku: p.code,
    quantity: p.qty,
    weight: { value: unitOz(p.code), unit: 'ounce' },
  }));
}
function round1(n) { return Math.round(n * 10) / 10; }

/**
 * Explode a normalized order into LOAF line items only (no packaging).
 * Reuses resolveMaterial so a Founder's Box -> its 6 component loaves.
 * @returns {{ items: object[], warnings: string[] }}
 */
function loafItems(order) {
  const { resolveMaterial, CASE_PACK } = cfg;
  const items = [];
  const warnings = [];
  const push = (code, qty) => {
    const desc = (CASE_PACK[code] || {}).desc || code;
    items.push({
      name: desc,
      sku: code, // the WMS material code Bill inventories against
      quantity: qty,
      weight: { value: unitOz(code), unit: 'ounce' },
    });
  };
  for (const li of order.lineItems) {
    const r = resolveMaterial(li);
    if (r.code) push(r.code, li.quantity);
    else if (r.kit && r.kit.explode) for (const [code, qty] of r.kit.explode) push(code, qty * li.quantity);
    else if (r.kit && r.kit.kit) { push(r.kit.kit, li.quantity); warnings.push(`Kit "${r.handle}" sent as single code ${r.kit.kit} (no explode rule).`); }
    else warnings.push(`No WMS code for "${r.unknown}" — add to materials.js.`);
  }
  return { items, warnings };
}

/**
 * Build a v2 shipment object from a normalized order.
 * By default the pack list carries EVERYTHING we inventory: the loaves PLUS the
 * realistic packaging (box / Green Cell Foam / gel packs / info sheet). Dry ice
 * is NOT included — it is not an inventoried material.
 * @param {object} order { number, serviceLevel?, shipping:{name,phone,email,address1,address2,city,state,postalCode}, lineItems }
 * @param {object} opts { test?, includePackaging? }
 *   test=true prefixes the shipment number so it's obviously not a real order.
 *   includePackaging defaults TRUE (Bill 2026-08-13 "everything we inventory").
 * @returns {{ shipment: object, warnings: string[], tags: string[] }}
 */
function buildTestShipment(order, opts = {}) {
  const includePackaging = opts.includePackaging !== false;
  const { items: loaves, warnings } = loafItems(order);
  const loafUnits = loaves.reduce((s, it) => s + it.quantity, 0);
  // ORDER ITEMS (picked / inventoried): loaves + box + GCF1 + GCF2 + 2 gel packs.
  const items = includePackaging ? loaves.concat(packagingItems()) : loaves;
  // "Everything else" — ShipStation-only ride-alongs (cfg.SHIPSTATION_EXTRAS):
  // info sheet, freezer paper (1/loaf), first-order welcome note. NOT picked
  // from Datex inventory — surfaced in the shipment NOTES, not the pick list.
  const extras = includePackaging
    ? cfg.SHIPSTATION_EXTRAS.map((e) => {
        const qty = e.perLoaf ? loafUnits : e.qty;
        return `${e.label} x${qty}${e.firstOrder ? ' (first order only)' : ''}`;
      })
    : [];
  const totalOz = items.reduce((s, it) => s + it.weight.value * it.quantity, 0);
  const num = opts.test ? `TEST-${order.number}` : String(order.number);
  const s = order.shipping || {};
  // Service level (Datex VendorReference) + Ice Cube owner code (OwnerReference)
  // become ShipStation TAGS so Bill can filter by "how many days shipped".
  const serviceLevel = order.serviceLevel || cfg.DEFAULT_SERVICE_LEVEL;
  const ownerRef = cfg.CONSTANTS.ownerReference; // BWICCS
  const tags = [serviceLevel, ownerRef];
  const shipment = {
    shipment_number: num,
    external_shipment_id: `BW-TEST-${order.number}`,
    warehouse_id: WAREHOUSE_ID,
    confirmation: 'none',
    ship_to: {
      name: s.name,
      phone: s.phone || '5085550100',
      address_line1: s.address1,
      address_line2: s.address2 || '',
      city_locality: s.city,
      state_province: s.state,
      postal_code: s.postalCode,
      country_code: 'US',
      address_residential_indicator: 'yes',
    },
    items,
    // 14x14x14 ship box (materials.js BW_BOX14). Dimensions MUST ride on every
    // shipment or ShipStation rate-shops against a weight UPS won't honor and you
    // get billed the dimensional-weight difference later (Ship Day Manifest, Q11).
    packages: [{ weight: { value: round1(totalOz), unit: 'ounce' }, dimensions: { unit: 'inch', length: 14, width: 14, height: 14 } }],
    internal_notes:
      `TEST order. Ship days: ${serviceLevel}. OwnerRef ${ownerRef}. ` +
      `Pick items = loaves + box + GCF1 + GCF2 + 2 gel packs. ` +
      (extras.length ? `Also add (not picked): ${extras.join('; ')}. ` : '') +
      `No dry ice (not inventoried). Datex WMS on hold.`,
  };
  return { shipment, warnings, tags, extras };
}

/** Low-level v2 request. */
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      { host: BASE, path, method, headers: { 'API-Key': API_KEY, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** POST one or many shipments to v2. Returns the API response. */
async function createShipments(shipments) {
  if (!API_KEY) throw new Error('SHIPSTATION_API_KEY not set');
  return req('POST', '/v2/shipments', { shipments });
}

/** Tag a shipment after creation (v2 tags are a separate endpoint, not inline). */
async function tagShipment(shipmentId, tag) {
  return req('POST', `/v2/shipments/${shipmentId}/tags/${encodeURIComponent(tag)}`);
}

module.exports = { loafItems, packagingItems, buildTestShipment, createShipments, tagShipment, req, unitOz, WAREHOUSE_ID };
