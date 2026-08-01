/**
 * src/shopify.js
 * Shopify glue: HMAC verification, order normalization, and fulfillment
 * write-back. Network calls use Node's built-in fetch (Node 18+).
 */
const crypto = require('crypto');

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

  const mapAddr = (a, nameFallback) => ({
    accountName: [a.first_name, a.last_name].filter(Boolean).join(' ') || o.name || nameFallback,
    accountLookupCode: o.email || o.name || nameFallback,
    telephone: a.phone || o.phone || '',
    addressLine1: a.address1 || '',
    addressLine2: a.address2 || '',
    city: a.city || '',
    state: a.province_code || a.province || '',
    postalCode: a.zip || '',
    country: a.country_code || a.country || '',
  });

  return {
    number: (o.name || String(o.order_number || o.id)).replace(/^#/, ''),
    orderId: o.id,
    // Default: request delivery ~2 days out. Adjust to your SLA / cutoff logic.
    requestedDelivery: isoDate(now, 2),
    billing: mapAddr(bill, 'Customer'),
    shipping: mapAddr(ship, 'Customer'),
    lineItems: (o.line_items || []).map((li) => ({
      handle: li.handle || li.product_handle || '',
      sku: li.sku || '',
      title: li.title || li.name || '',
      quantity: li.quantity || 1,
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

module.exports = { verifyWebhook, normalizeOrder, createFulfillment, isoDate };
