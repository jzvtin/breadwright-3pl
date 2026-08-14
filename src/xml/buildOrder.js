/**
 * src/xml/buildOrder.js
 * OUTBOUND: normalized Shopify order -> Datex "Customer Order Shipment" XML.
 *
 * Root is <Orders> wrapping <Order> (outbound only — inbound uses bare <Order>).
 * Structure/field order mirrors "Sample Customer Order Shipment.xml".
 */
const { el, toXml } = require('./util');
const { addressBlock } = require('./address');
const cfg = require('../../config/materials');
const { computeDryIce } = require('../../config/dryice');

function orderLine(lineNumber, shipmentCode, materialCode, amount) {
  return el('OrderLine', [
    el('LineNumber', lineNumber),
    el('ShipmentLookupCode', shipmentCode),
    el('MaterialSerialControlled', 'false'),
    el('MaterialLookupCode', materialCode),
    el('MaterialAmount', amount),
    el('MaterialPackagingName', 'EACH'),
  ]);
}

/**
 * Build the <Order> node (not serialized) for one normalized order, plus its
 * warnings and human pack-list. Kept separate so a nightly BATCH can wrap many
 * <Order> nodes under a single <Orders> root (see buildBatch).
 *
 * @param {object} order normalized order:
 *   { number, orderId, requestedDelivery, billing, shipping,
 *     lineItems: [{ handle, sku, title, quantity }], tracking? }
 * @returns {{ node: object, warnings: string[], pack: object }}
 */
function buildOrderNode(order, opts = {}) {
  const { CONSTANTS: C, resolveMaterial, PACKAGING, FIRST_ORDER_INSERTS, ORDER_UDFS } = cfg;
  const warnings = [];
  const shipCode = String(order.number);
  // materialsOnly: loaves ONLY — no cooler box/insulation/gel, no kraft paper,
  // no dry ice, no first-order insert. For Bill's Datex inventory test (2026-08-10).
  const materialsOnly = !!opts.materialsOnly;

  // 1) Real product lines from Shopify, mapped to WMS codes. Track loaf UNITS
  //    (used to scale the kraft/freezer paper layers below).
  const lines = [];
  let n = 1;
  let loafUnits = 0; //  total loaf pieces (for reference)
  let loafLines = 0; //  distinct loaf picks — one kraft layer sheet per loaf type
  for (const li of order.lineItems) {
    const r = resolveMaterial(li);
    if (r.code) {
      lines.push(orderLine(n++, shipCode, r.code, li.quantity));
      loafUnits += li.quantity;
      loafLines += 1;
    } else if (r.kit) {
      if (r.kit.explode) {
        for (const [code, qty] of r.kit.explode) {
          lines.push(orderLine(n++, shipCode, code, qty * li.quantity));
          loafUnits += qty * li.quantity;
          loafLines += 1;
        }
      } else if (r.kit.kit) {
        // Legacy path: ship as a single kit code and assume Datex explodes it.
        lines.push(orderLine(n++, shipCode, r.kit.kit, li.quantity));
        warnings.push(
          `Kit "${r.handle}" sent as single code "${r.kit.kit}" (qty ${li.quantity}) — assumes Datex has a matching kit/BOM. CONFIRM code + that it explodes warehouse-side (else switch KITS to explode).`
        );
      } else {
        warnings.push(
          `Kit product "${r.handle}" has no resolution rule yet (kit vs explode) — see config/materials.js KITS.`
        );
      }
    } else {
      warnings.push(
        `No WMS material code for Shopify item "${r.unknown}" — add it to config/materials.js LOAVES/KITS.`
      );
    }
  }

  // 2) Auto-injected packaging (box / insulation / gel packs / insert) — not Shopify line items.
  //    Skipped entirely in materialsOnly mode.
  const zip = order.shipping && order.shipping.postalCode;
  let dryIce = null;
  if (!materialsOnly) {
    for (const p of PACKAGING) {
      lines.push(orderLine(n++, shipCode, p.code, p.qty));
    }

    // 2a) Freezer paper REMOVED 2026-08-13 (Bill: "no freezer paper"). BW_BFP is
    //     no longer injected into the order XML.

    // 2b) Dry ice — computed for the human pack sheet ONLY. Datex does NOT
    //     inventory dry ice (not in their material list; Bill 08-11: "everything
    //     but dry ice"), so it is NOT emitted as an order line. When the caller
    //     has already resolved live conditions (weather + calendar-aware transit
    //     via resolveDryIceConditions), it passes them on order.dryIceConditions;
    //     otherwise we fall back to the sync zone/season estimate.
    dryIce = order.dryIceConditions || computeDryIce({ zip });
    if (!dryIce.zoneKnown) {
      warnings.push(
        `Dry ice: destination ZIP ${zip || '(none)'} not in the zone table — assumed Zone ${dryIce.zone} (${dryIce.blocks} block${dryIce.blocks > 1 ? 's' : ''}). CONFIRM.`
      );
    }
    // Air shipments (Priority Shippers) must declare dry ice + are capped at 1
    // slab (5 lb). Surface this to the packer so the platform's dry-ice button
    // gets checked.
    if (dryIce.declareDryIce) {
      warnings.push(
        `AIR shipment via ${dryIce.carrier} — DECLARE dry ice on Priority Shippers (check the dry-ice button); max 1 slab (5 lb).`
      );
    }

    // 2b) First-order welcome note (BW_WB) is NOT emitted here — it is a
    //     ShipStation-only ride-along (Justin 2026-08-13), never a Datex pick.
  }

  // 3) Header. VendorReference carries the shipping SERVICE LEVEL per Bill
  //    ("1 Day" / "2 Day" / ...), derived from the customer's chosen shipping
  //    method. (Tracking is NOT here — it comes from ShipStation post-label.)
  const headerChildren = [
    el('ProjectLookupCode', C.projectLookupCode),
    el('OrderClass', C.orderClassOutbound),
    el('LookupCode', shipCode),
  ];
  const serviceLevel = order.serviceLevel || cfg.DEFAULT_SERVICE_LEVEL;
  if (serviceLevel) headerChildren.push(el('VendorReference', serviceLevel));
  // OwnerReference = fixed 6-char to/from-Ice-Cube tag (Bill: NOT the order number).
  headerChildren.push(el('OwnerReference', C.ownerReference));
  headerChildren.push(
    el('Dates', [el('Date', [el('Type', 'RequestedDelivery'), el('Value', order.requestedDelivery)])]),
    el('Addresses', [addressBlock(order.billing, { role: 'billing', orderAddress: 'true' })]),
    el('OrderLines', lines),
    el('UserDefinedFields', ORDER_UDFS.map((u) => el('UserDefinedField', [el('Name', u.name), el('Value', u.value)]))),
  );

  const shipmentChildren = [
    el('WarehouseLookupCode', C.warehouseLookupCode),
    el('LookupCode', shipCode),
    // Carrier by destination: UPS Ground when reachable ≤2 ground days, else the
    // cheapest air via Priority Shippers (from the dry-ice mode resolution).
    // An explicit order.carrier still wins if the caller pinned one.
    el('CarrierLookupCode', order.carrier || (dryIce && dryIce.carrier) || C.defaultCarrier),
    el('Notes', null),
    el('Dates', [el('Date', [el('Type', 'Expected'), el('Value', order.requestedDelivery)])]),
    el('Addresses', [addressBlock(order.shipping, { role: 'shipping', placeIn: 'ShipTo' })]),
  ];

  const orderNode = el('Order', [
    el('TransactionInfo', [el('UserCode', C.userCodeOutbound), el('Type', 'Order'), el('Operation', 'New')]),
    el('OrderHeaders', [el('OrderHeader', headerChildren)]),
    el('ShipmentHeaders', [el('ShipmentHeader', shipmentChildren)]),
  ]);

  // Human-readable PACK LIST for the warehouse console (what to grab).
  const CASE = cfg.CASE_PACK || {};
  const contents = [];
  for (const li of order.lineItems) {
    const r = resolveMaterial(li);
    if (r.code) contents.push({ code: r.code, qty: li.quantity, desc: (CASE[r.code] || {}).desc || r.code });
    else if (r.kit && r.kit.explode)
      for (const [code, qty] of r.kit.explode)
        contents.push({ code, qty: qty * li.quantity, desc: (CASE[code] || {}).desc || code });
  }
  const gelPacks = materialsOnly ? 0 : (PACKAGING.find((p) => p.code === 'BW_GELPK') || {}).qty || 0;
  const pack = {
    orderNumber: shipCode,
    materialsOnly,
    loafUnits,
    contents,
    box: materialsOnly ? null : 'BW_BOX14 — cardboard 14" cube',
    insulation: materialsOnly ? null : '2× Green Cell Foam panels (1")',
    gelPacks,
    kraftPaper: 0, // freezer paper removed from XML (Bill 2026-08-13) — pack list only
    dryIce,
    carrier: (dryIce && dryIce.carrier) || order.carrier || null,
    shipMode: (dryIce && dryIce.mode) || null, //          'ground' | 'air'
    declareDryIce: !!(dryIce && dryIce.declareDryIce), //  air => packer checks the dry-ice button
    welcomeBooklet: !materialsOnly && !!order.isFirstOrder,
    insert: !materialsOnly && !!PACKAGING.find((p) => p.code === 'BW_Infosheet'),
  };

  return { node: orderNode, warnings, pack };
}

/**
 * OUTBOUND (single order): one normalized Shopify order -> full Datex XML doc.
 * Root <Orders> wrapping a single <Order>. Used by the real-time webhook path.
 * @returns {{ xml: string, warnings: string[], pack: object }}
 */
function buildCustomerOrder(order, opts = {}) {
  const { CONSTANTS: C } = cfg;
  const { node, warnings, pack } = buildOrderNode(order, opts);
  const root = el('Orders', [node], { xmlns: C.namespace });
  return { xml: toXml(root), warnings, pack };
}

/**
 * OUTBOUND (batch): many normalized orders -> ONE Datex XML doc whose <Orders>
 * root wraps every day's <Order>. This is the end-of-day batch to Ice Cube.
 *
 * NOTE: this assumes the 3PL import accepts multiple <Order> in one <Orders>
 * file (the envelope is already plural). CONFIRM with Bill — if they want one
 * file per order instead, the batch runner drops individually (BATCH_MODE=per-order).
 *
 * @param {object[]} orders normalized orders
 * @returns {{ xml: string, results: {number:string,warnings:string[],pack:object}[], warnings: string[], count: number }}
 */
function buildBatch(orders) {
  const { CONSTANTS: C } = cfg;
  const nodes = [];
  const results = [];
  const warnings = [];
  for (const order of orders) {
    const { node, warnings: w, pack } = buildOrderNode(order);
    nodes.push(node);
    results.push({ number: String(order.number), warnings: w, pack });
    w.forEach((msg) => warnings.push(`#${order.number}: ${msg}`));
  }
  const root = el('Orders', nodes, { xmlns: C.namespace });
  return { xml: toXml(root), results, warnings, count: nodes.length };
}

/** Max <Order> per XML file (Bill 2026-08-13: "only 200 orders per xml"). */
const MAX_ORDERS_PER_FILE = 200;

/**
 * OUTBOUND (chunked batch): split orders into files of at most MAX_ORDERS_PER_FILE
 * (Bill's 200-order cap), each its own complete <Orders> document. One <Order>
 * over the cap starts a new file. Returns one buildBatch result per chunk.
 * @returns {{ xml, results, warnings, count }[]} one entry per file
 */
function buildBatchChunks(orders, max = MAX_ORDERS_PER_FILE) {
  const chunks = [];
  for (let i = 0; i < orders.length; i += max) chunks.push(orders.slice(i, i + max));
  return chunks.map((c) => buildBatch(c));
}

module.exports = { buildCustomerOrder, buildOrderNode, buildBatch, buildBatchChunks, MAX_ORDERS_PER_FILE };
