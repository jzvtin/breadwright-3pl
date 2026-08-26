/**
 * src/ordersCsv.js
 * Pull all Shopify orders and render a CSV string.
 * Reuses the service's existing SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN env.
 * No new dependency, no disk writes — the caller streams the result.
 */
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const { normalizeOrder } = require('./shopify');
const { buildCustomerOrder } = require('./xml/buildOrder');

const COLUMNS = [
  'order', 'created_at', 'financial_status', 'fulfillment_status',
  'email', 'phone', 'customer_name',
  'ship_name', 'ship_address1', 'ship_city', 'ship_province', 'ship_zip', 'ship_country',
  'subtotal', 'shipping', 'taxes', 'total', 'currency',
  'discount_codes', 'items', 'exploded_items', 'blocked', 'note', 'tags',
];

// Run the same explode the XML builder uses, so the sheet shows the real loaves
// (Build-a-Box etc.) not just the storefront title. Pure/sync — no network.
// Never throws: any build error just leaves the columns blank for that row.
function explodeOrder(raw) {
  try {
    const order = normalizeOrder(raw);
    const { pack, blocking } = buildCustomerOrder(order);
    const exploded = (pack && pack.contents || [])
      .map((c) => `${c.qty}× ${c.desc || c.code}`).join('; ');
    const blocked = (blocking && blocking.length) ? blocking.join(' | ') : '';
    return { exploded, blocked };
  } catch (e) {
    return { exploded: '', blocked: '' };
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function rowFrom(o) {
  const ship = o.shipping_address || {};
  const cust = o.customer || {};
  const shipMoney = o.total_shipping_price_set && o.total_shipping_price_set.shop_money;
  const { exploded, blocked } = explodeOrder(o);
  return {
    order: o.name,
    created_at: o.created_at,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status || 'unfulfilled',
    email: o.email,
    phone: o.phone || ship.phone || '',
    customer_name: [cust.first_name, cust.last_name].filter(Boolean).join(' '),
    ship_name: [ship.first_name, ship.last_name].filter(Boolean).join(' '),
    ship_address1: ship.address1 || '',
    ship_city: ship.city || '',
    ship_province: ship.province_code || ship.province || '',
    ship_zip: ship.zip || '',
    ship_country: ship.country_code || ship.country || '',
    subtotal: o.subtotal_price,
    shipping: (shipMoney && shipMoney.amount) || '0.00',
    taxes: o.total_tax,
    total: o.total_price,
    currency: o.currency,
    discount_codes: (o.discount_codes || []).map((d) => d.code).join('|'),
    items: (o.line_items || []).map((l) => `${l.quantity}x ${l.title}`).join('; '),
    exploded_items: exploded,
    blocked,
    note: o.note || '',
    tags: o.tags || '',
  };
}

function nextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const part = linkHeader.split(',').find((s) => s.includes('rel="next"'));
  if (!part) return null;
  const m = part.match(/<([^>]+)>/);
  if (!m) return null;
  return new URL(m[1]).searchParams.get('page_info');
}

/**
 * @param {object} opts
 * @param {string} [opts.since] ISO date string; only orders created on/after.
 * @returns {Promise<{csv:string, count:number}>}
 */
async function buildOrdersCsv({ since } = {}) {
  // Dedicated read-only export credentials, independent of the batch's
  // SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN (which needs write_orders and is a
  // separate concern). Falls back to the shared admin creds if the dedicated
  // ones are not set.
  const store = process.env.SHOPIFY_EXPORT_STORE || process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_EXPORT_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) throw new Error('SHOPIFY_EXPORT_STORE / SHOPIFY_EXPORT_TOKEN not set');

  const base = `https://${store}/admin/api/${API_VERSION}/orders.json`;
  let pageInfo = null;
  const rows = [];

  do {
    const params = new URLSearchParams({ status: 'any', limit: '250' });
    if (pageInfo) {
      params.set('page_info', pageInfo);
    } else if (since) {
      params.set('created_at_min', new Date(since).toISOString());
    }
    const res = await fetch(`${base}?${params.toString()}`, {
      headers: { 'X-Shopify-Access-Token': token },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const { orders } = await res.json();
    orders.forEach((o) => rows.push(rowFrom(o)));
    pageInfo = nextPageInfo(res.headers.get('link'));
    if (pageInfo) await new Promise((r) => setTimeout(r, 300)); // rate-limit courtesy
  } while (pageInfo);

  const header = COLUMNS.join(',');
  const lines = rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','));
  const csv = '﻿' + [header, ...lines].join('\r\n'); // BOM for Excel UTF-8
  return { csv, count: rows.length };
}

module.exports = { buildOrdersCsv, COLUMNS };
