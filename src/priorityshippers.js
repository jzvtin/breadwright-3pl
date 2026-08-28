/**
 * src/priorityshippers.js
 * ---------------------------------------------------------------------------
 * Client for Yahuda's "Shipping-Intelligent" / Priority Shippers API
 * (https://ship.priorityshippers.com/api/public/v1). This is the platform
 * Breadwright uses for the CHEAPEST-AIR lane when UPS Ground can't reach the
 * customer in time (see config/dryice.js). Auth = a Sanctum bearer token.
 *
 * Read-only here: we only call get-rates (a quote). Nothing bought, no label,
 * no pickup. Buying a label is a separate, deliberate action (create-label) we
 * do NOT wire into the console.
 *
 * Response envelope (per their docs):
 *   success -> { status:'success', data:{ errors:[], rates:[...] } }
 *   fail    -> { status:'fail',  message, data:{ field:[msgs] } }   (validation)
 *   error   -> { status:'error', message }
 * ---------------------------------------------------------------------------
 */
const https = require('https');

const HOST = 'ship.priorityshippers.com';
const BASE_PATH = '/api/public/v1';
const TOKEN = process.env.PRIORITYSHIPPERS_TOKEN || '';

// The label origin = the Ice Cube Cold Storage warehouse (Fall River, MA). Every
// Breadwright order ships from here. Matches the ShipStation ship_from + dryice
// ORIGIN. Phone/name are required-ish by some carriers for rating.
const SHIP_FROM = {
  name: 'Breadwright',
  address_1: '451 Currant Rd',
  city: 'Fall River',
  state: 'MA',
  zip: '02720',
  country: 'US',
  phone: '5086857346',
};

/** Low-level POST to a Priority Shippers method. Returns the parsed JSON body. */
function post(method, body) {
  const payload = JSON.stringify(body);
  const opts = {
    host: HOST,
    path: `${BASE_PATH}/${method}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_e) {
          return reject(new Error(`Priority Shippers ${method}: non-JSON HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('Priority Shippers request timed out')));
    req.write(payload);
    req.end();
  });
}

/**
 * Get parcel rates for a shipment.
 * @param {object} o
 * @param {object} o.to            recipient address {address_1,city,state,zip,country,residential,name}
 * @param {object} [o.from]        override ship-from (defaults to the warehouse)
 * @param {Array}  o.packages      [{weight,length,width,height,quantity,options}]
 * @param {string} [o.ship_date]   yyyy-mm-dd (must be >= tomorrow per the API)
 * @param {string} [o.package_type] default CUSTOMER_PACKAGING
 * @param {number} [o.dryIceLb]    dry-ice weight (lb) applied to package #1 options
 * @returns {{ ok, rates, errors, fail, raw }}
 */
async function getRates(o) {
  if (!TOKEN) return { ok: false, rates: [], errors: ['PRIORITYSHIPPERS_TOKEN not set'], fail: null, raw: null };
  const packages = (o.packages && o.packages.length ? o.packages : [{ weight: 8 }]).map((p, i) => {
    const pkg = { ...p };
    if (i === 0 && o.dryIceLb > 0) {
      pkg.options = { ...(pkg.options || {}), dry_ice: { weight: o.dryIceLb } };
    }
    return pkg;
  });
  const req = {
    addresses: { from: o.from || SHIP_FROM, to: o.to },
    package_type: o.package_type || 'CUSTOMER_PACKAGING',
    packages,
  };
  if (o.ship_date) req.ship_date = o.ship_date;

  const { status, body } = await post('get-rates', req);
  if (body && body.status === 'success') {
    const d = body.data || {};
    return { ok: true, rates: normalizeRates(d.rates || []), errors: d.errors || [], fail: null, raw: body };
  }
  // validation fail or hard error
  return {
    ok: false,
    rates: [],
    errors: [],
    fail: { message: body && body.message, fields: (body && body.data) || null, http: status },
    raw: body,
  };
}

/** Flatten each rate to the fields the console cares about, sorted cheapest-first. */
function normalizeRates(rates) {
  return rates
    .map((r) => ({
      carrier: r.carrier_name,
      service: r.service_name,
      service_code: r.service_code,
      total: num(r.shipment_total),
      eta: r.estimated_delivery_date || null,
      zone: r.zone != null ? String(r.zone) : null,
      residential: !!r.residential,
    }))
    .filter((r) => r.total != null)
    .sort((a, b) => a.total - b.total);
}

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

/**
 * Pick the cheapest service that still arrives by `deadline` (a yyyy-mm-dd or
 * Date). If deadline is omitted, just return the cheapest overall. ETA strings
 * come as "yyyy-mm-dd hh:mm:ss"; we compare on the date part.
 */
function cheapestByDeadline(rates, deadline) {
  if (!rates.length) return null;
  if (!deadline) return rates[0]; // already sorted cheapest-first
  const dl = toYmd(deadline);
  const meets = rates.filter((r) => r.eta && toYmd(r.eta) <= dl);
  return meets.length ? meets[0] : null; // rates already cheapest-first
}

function toYmd(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * BUY a label (create-label). SPENDS MONEY. Only called from the guarded
 * /peek/buy-label path. Mirrors the get-rates body + a chosen service_code.
 * @param {object} o  same shape as getRates + { service_code }
 * @returns {{ ok, tracking, labelUrl, price, service, raw, error }}
 */
async function createLabel(o) {
  if (!TOKEN) return { ok: false, error: 'PRIORITYSHIPPERS_TOKEN not set' };
  if (!o.service_code) return { ok: false, error: 'service_code required to buy' };
  const packages = (o.packages && o.packages.length ? o.packages : [{ weight: 8 }]).map((p, i) => {
    const pkg = { ...p };
    if (i === 0 && o.dryIceLb > 0) pkg.options = { ...(pkg.options || {}), dry_ice: { weight: o.dryIceLb } };
    return pkg;
  });
  const req = {
    addresses: { from: o.from || SHIP_FROM, to: o.to },
    package_type: o.package_type || 'CUSTOMER_PACKAGING',
    packages,
    service_code: o.service_code,
  };
  if (o.ship_date) req.ship_date = o.ship_date;
  const { status, body } = await post('create-label', req);
  if (body && body.status === 'success') {
    const d = body.data || {};
    // Field names per the PS docs; kept permissive since this account's exact
    // response shape is UNVERIFIED until the first real buy.
    const label = (d.labels && d.labels[0]) || d.label || d;
    return {
      ok: true,
      tracking: label.tracking_number || d.tracking_number || null,
      labelUrl: label.label_url || label.url || d.label_url || null,
      price: num(label.shipment_total || d.shipment_total || d.total),
      service: label.service_name || o.service_code,
      raw: body,
    };
  }
  return { ok: false, error: (body && body.message) || `HTTP ${status}`, raw: body };
}

module.exports = { getRates, createLabel, cheapestByDeadline, normalizeRates, SHIP_FROM };
