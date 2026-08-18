/**
 * src/shopify.js
 * Shopify glue: HMAC verification, order normalization, and fulfillment
 * write-back. Network calls use Node's built-in fetch (Node 18+).
 */
const crypto = require('crypto');
const { resolveServiceLevel } = require('../config/materials');

/** Verify a Shopify webhook HMAC. rawBody must be the exact bytes received. */
function verifyWebhook(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

/** ISO date (YYYY-MM-DD) N days from a base date. Base passed in for testability. */
function isoDate(base, addDays = 0) {
  const d = new Date(base.getTime() + addDays * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * Normalize a raw Shopify order (REST/webhook payload) into the builder shape.
 * @param {object} o raw Shopify order
 * @param {Date}  now base date for RequestedDelivery (defaults injected by caller)
 */
function normalizeOrder(o, now = new Date()) {
  const ship = o.shipping_address || o.billing_address || {};
  const bill = o.billing_address || o.shipping_address || {};

  const mapAddr = (a, nameFallback) => {
    const fullName = [a.first_name, a.last_name].filter(Boolean).join(' ');
    return {
    accountName: fullName || o.name || nameFallback,
    // Consignee shows this in Datex — use the person's name, not the email.
    accountLookupCode: fullName || o.name || o.email || nameFallback,
    telephone: a.phone || o.phone || '',
    addressLine1: a.address1 || '',
    addressLine2: a.address2 || '',
    city: a.city || '',
    state: a.province_code || a.province || '',
    postalCode: a.zip || '',
    country: a.country_code || a.country || '',
  };
  };

  return {
    number: (o.name || String(o.order_number || o.id)).replace(/^#/, ''),
    orderId: o.id,
    // Default: request delivery ~2 days out. Adjust to your SLA / cutoff logic.
    requestedDelivery: isoDate(now, 2),
    // Shipping speed the customer picked -> goes in <VendorReference> ("1 Day"/"2 Day"/...).
    serviceLevel: resolveServiceLevel(o.shipping_lines),
    // First order for this customer -> triggers first-order inserts (welcome booklet).
    isFirstOrder: !!(o.customer && Number(o.customer.orders_count) === 1),
    billing: mapAddr(bill, 'Customer'),
    shipping: mapAddr(ship, 'Customer'),
    lineItems: (o.line_items || []).map((li) => ({
      handle: li.handle || li.product_handle || '',
      sku: li.sku || '',
      title: li.title || li.name || '',
      // current_quantity reflects order EDITS (a removed add-on reads 0). Prefer
      // it; fall back to quantity only when it's absent. 0 is a real value — an
      // edited-out line must stay 0 so the builder drops it, not resurrect it.
      quantity: Number.isFinite(li.current_quantity) ? li.current_quantity : li.quantity || 1,
      // Build-a-Box loaf choices ride here as Shopify name/value pairs.
      properties: Array.isArray(li.properties) ? li.properties : [],
    })),
  };
}

/**
 * Write a fulfillment with tracking back to Shopify via Admin GraphQL.
 * Only used by the return-feed poller once we confirm Bill sends tracking back.
 * Requires env: SHOPIFY_STORE (xxx.myshopify.com), SHOPIFY_ADMIN_TOKEN.
 */
async function createFulfillment({ fulfillmentOrderId, trackingNumber, trackingCompany = 'UPS' }) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) throw new Error('SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN not set');

  const query = `
    mutation($fo: ID!, $tn: String!, $tc: String!) {
      fulfillmentCreate(fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: $fo }],
        trackingInfo: { number: $tn, company: $tc },
        notifyCustomer: true
      }) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`;

  const res = await fetch(`https://${store}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: { fo: fulfillmentOrderId, tn: trackingNumber, tc: trackingCompany } }),
  });
  return res.json();
}

function adminCreds() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) throw new Error('SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN not set — needed to pull orders for the batch');
  return { store, token };
}

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

/**
 * Pull the orders that belong in the end-of-day batch: PAID, not yet shipped,
 * created within the window, and NOT already tagged as sent to the 3PL.
 * Follows REST cursor pagination. Returns raw Shopify order objects
 * (feed each through normalizeOrder before building XML).
 *
 * @param {object} opts { windowHours=25, now=Date, sentTag='3pl-sent' }
 * @returns {Promise<object[]>}
 */
async function fetchOrdersForBatch({ windowHours = 25, now = new Date(), sentTag = '3pl-sent' } = {}) {
  const { store, token } = adminCreds();
  const since = new Date(now.getTime() - windowHours * 3600 * 1000).toISOString();
  const params = new URLSearchParams({
    status: 'any',
    financial_status: 'paid',
    fulfillment_status: 'unshipped',
    created_at_min: since,
    limit: '250',
  });
  let url = `https://${store}/admin/api/${API_VERSION}/orders.json?${params.toString()}`;
  const all = [];
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) throw new Error(`Shopify orders fetch failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    all.push(...(body.orders || []));
    // REST cursor pagination via the Link header.
    const link = res.headers.get('link') || res.headers.get('Link') || '';
    const next = link.split(',').find((p) => p.includes('rel="next"'));
    url = next ? (next.match(/<([^>]+)>/) || [])[1] : null;
  }
  // Skip anything we've already handed off (persistent, survives Railway restarts).
  return all.filter((o) => {
    const tags = String(o.tags || '').toLowerCase();
    return !tags.split(',').map((t) => t.trim()).includes(sentTag.toLowerCase());
  });
}

/**
 * Fetch ONE raw Shopify order (full: line_items + addresses) by order number.
 * For the pack-slip preview — feed the result through normalizeOrder. Returns
 * null if not found. @param {string|number} number  order name/number, '#' optional
 */
async function fetchOrderRawByNumber(number) {
  const { store, token } = adminCreds();
  const bare = String(number).replace(/^#/, '');
  const params = new URLSearchParams({ status: 'any', name: `#${bare}`, limit: '1' });
  const url = `https://${store}/admin/api/${API_VERSION}/orders.json?${params.toString()}`;
  const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
  if (!res.ok) throw new Error(`Shopify order fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.orders && body.orders[0]) || null;
}

/** Tag an order as sent to the 3PL (persistent idempotency marker in Shopify). */
async function tagOrderSent(orderId, tag = '3pl-sent') {
  const { store, token } = adminCreds();
  const query = `mutation($id: ID!, $tags: [String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ message } } }`;
  const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: { id: `gid://shopify/Order/${orderId}`, tags: [tag] } }),
  });
  const json = await res.json();
  const errs = json && json.data && json.data.tagsAdd && json.data.tagsAdd.userErrors;
  if (errs && errs.length) throw new Error('tagsAdd: ' + errs.map((e) => e.message).join('; '));
  return true;
}

/**
 * Look up a Shopify order by its NUMBER/name (Datex sends this back as
 * <OrderReference>, which == our order number). Returns the order's id, name,
 * and the OPEN fulfillmentOrder id needed to create a fulfillment.
 * @returns {Promise<{orderId:string, name:string, fulfillmentOrderId:string|null}|null>}
 */
async function findOrderByNumber(number) {
  const { store, token } = adminCreds();
  // Shopify order names carry a leading '#'; query both forms.
  const bare = String(number).replace(/^#/, '');
  const query = `
    query($q: String!) {
      orders(first: 1, query: $q) {
        edges { node {
          id name
          fulfillmentOrders(first: 10) { edges { node { id status } } }
        } }
      }
    }`;
  const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: { q: `name:#${bare}` } }),
  });
  const json = await res.json();
  const node = json && json.data && json.data.orders && json.data.orders.edges[0] && json.data.orders.edges[0].node;
  if (!node) return null;
  const fos = (node.fulfillmentOrders.edges || []).map((e) => e.node);
  // Prefer an OPEN/IN_PROGRESS fulfillment order (one we can still fulfill).
  const open = fos.find((f) => f.status === 'OPEN' || f.status === 'IN_PROGRESS') || fos[0];
  return { orderId: node.id, name: node.name, fulfillmentOrderId: open ? open.id : null };
}

/**
 * Confirm a shipment from the warehouse: look up the order, then create a
 * fulfillment with tracking (which fires Shopify's shipping email). In dryRun,
 * resolves the order but does NOT write — returns the plan so a UI can preview.
 * @param {{number:string|number, tracking:string, carrier?:string, dryRun?:boolean}} p
 */
async function confirmShipment({ number, tracking, carrier = 'UPS', dryRun = false }) {
  if (!number || !tracking) throw new Error('number and tracking are required');
  // No Shopify admin token yet (return feed not plugged into the backend) — run a
  // pure SIMULATION so the /breadwright test still works end-to-end. Shows what
  // WOULD happen without touching Shopify. Remove once the token is configured.
  if (!process.env.SHOPIFY_ADMIN_TOKEN) {
    return { ok: true, dryRun: true, simulated: true, plan: { number, name: `#${String(number).replace(/^#/, '')}`, tracking, carrier, willEmail: true } };
  }
  const found = await findOrderByNumber(number);
  if (!found) return { ok: false, number, error: `order #${number} not found in Shopify` };
  if (!found.fulfillmentOrderId) return { ok: false, number, name: found.name, error: 'no open fulfillment order (already fulfilled?)' };

  const plan = { number, name: found.name, tracking, carrier, willEmail: true };
  if (dryRun) return { ok: true, dryRun: true, plan };

  const result = await createFulfillment({
    fulfillmentOrderId: found.fulfillmentOrderId,
    trackingNumber: tracking,
    trackingCompany: carrier,
  });
  const errs = result && result.data && result.data.fulfillmentCreate && result.data.fulfillmentCreate.userErrors;
  if (errs && errs.length) return { ok: false, number, name: found.name, error: errs.map((e) => e.message).join('; ') };
  return { ok: true, dryRun: false, plan, fulfillment: result && result.data && result.data.fulfillmentCreate && result.data.fulfillmentCreate.fulfillment };
}

module.exports = { verifyWebhook, normalizeOrder, createFulfillment, isoDate, fetchOrdersForBatch, tagOrderSent, findOrderByNumber, fetchOrderRawByNumber, confirmShipment };
