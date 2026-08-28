/**
 * src/xml/buildOrder.js
 * OUTBOUND: normalized Shopify order -> Datex "Customer Order Shipment" XML.
 *
 * Root is <Orders> wrapping <Order> (outbound only — inbound uses bare <Order>).
 * Structure/field order mirrors "Sample Customer Order Shipment.xml".
 */
const { el, toXml } = require('./util');
const XML_PROLOG = '<?xml version="1.0" encoding="utf-8"?>\n';
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
  const { CONSTANTS: C, resolveMaterial, resolveBuildABox, PACKAGING, INSERT_EVERY_ORDER, COMPUTED, ORDER_UDFS } = cfg;
  const warnings = []; //  informational, send still allowed
  const blocking = []; //  hard blocks — Confirm & Send must be disabled
  const shipCode = String(order.number);
  // materialsOnly: bread ONLY — no cooler box/insulation/gel, no kraft paper,
  // no inserts, no dry ice. For Bill's Datex inventory test (2026-08-10).
  const materialsOnly = !!opts.materialsOnly;

  // 1) Explode every Shopify line item into bread material lines (code -> qty).
  //    Boxes explode into their component loaves; the box code itself is never
  //    emitted. Lines with resolved qty <= 0 (e.g. add-ons removed by an order
  //    edit -> current_quantity 0) are skipped. Track bread UNITS for BW_BFP.
  const breadLines = []; // [{ code, qty }] in encounter order
  let breadUnits = 0;
  const addBread = (code, qty) => {
    if (qty <= 0) return;
    breadLines.push({ code, qty });
    breadUnits += qty;
  };
  for (const li of order.lineItems) {
    const qty = Number(li.quantity) || 0;
    if (qty <= 0) continue; // removed by order edit / zero line
    const r = resolveMaterial(li);
    if (r.code) {
      addBread(r.code, qty);
    } else if (r.box) {
      if (r.box.blocked) {
        blocking.push(`${r.box.name} (${r.box.key}) is blocked: ${r.box.blocked}`);
      } else if (r.box.propertyDriven) {
        const bab = resolveBuildABox(r.box, li);
        if (bab.blocked) blocking.push(bab.blocked);
        else for (const [code, per] of Object.entries(bab.lines)) addBread(code, per * qty);
      } else {
        for (const [code, per] of Object.entries(r.box.lines)) addBread(code, per * qty);
      }
    } else if (r.blocked) {
      blocking.push(`Line "${li.title || li.sku || ''}" is blocked: ${r.blocked}`);
    } else {
      blocking.push(
        `No WMS material code for Shopify item "${r.unknown}" — add it to config/materials.js before sending.`
      );
    }
  }

  // 2) Assemble the Datex order lines in the BW_1003 sequence:
  //    bread -> box/GCF1/GCF2/gel -> BW_BFP(bread units) -> BW_INFOSHEET -> BW_WB(first order).
  const lines = [];
  let n = 1;
  const emit = (code, qty) => lines.push(orderLine(n++, shipCode, code, qty));
  for (const b of breadLines) emit(b.code, b.qty);

  const zip = order.shipping && order.shipping.postalCode;
  let dryIce = null;
  if (!materialsOnly) {
    // 2a) Packaging picks (box / Green Cell Foam / gel packs).
    for (const p of PACKAGING) emit(p.code, p.qty);
    // NOTE (2026-08-19, Justin): BW_BFP (kraft paper), BW_INFOSHEET (info sheet),
    // and BW_WB (welcome booklet) are NO LONGER emitted to Datex. Emitted line set
    // is now: bread + BW_BOX14 / BW_GCF1 / BW_GCF2 / BW_GELPK only.

    // 2b) Dry ice + carrier — SINGLE SOURCE OF TRUTH: serviceForZip (config/dryice.js,
    //     Justin 2026-08-28). "Nothing over 2 days": near ground <=2 days = 2_DAY UPS
    //     Ground, 0 dry ice; else AIR via Priority Shippers, 1 slab (2_AIR normally,
    //     1_AIR for the far West). Dry ice is NEVER a Datex line — pack sheet only.
    const { serviceForZip } = require('../../config/dryice');
    const svc = serviceForZip(zip);
    const air = svc.mode === 'air';
    dryIce = {
      blocks: svc.slabs,
      lbs: svc.slabs * cfg.SLAB_LB,
      zone: svc.zone,
      zoneKnown: svc.zone != null,
      mode: svc.mode,
      carrier: svc.service, // "UPS Next Day Air" / "UPS 2nd Day Air" / "UPS Ground"
      declareDryIce: air,   // air always carries 1 slab -> must be declared
    };
    if (dryIce.declareDryIce) {
      warnings.push(`AIR via Priority Shippers — DECLARE dry ice (check the dry-ice button; max 1 slab / 5 lb).`);
    }
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

  // Human-readable PACK LIST for the warehouse console (what to grab). Built
  // from the same exploded bread lines used for the XML, so the two never drift.
  const CASE = cfg.CASE_PACK || {};
  const contents = breadLines.map((b) => ({ code: b.code, qty: b.qty, desc: (CASE[b.code] || {}).desc || b.code }));
  const gelPacks = materialsOnly ? 0 : (PACKAGING.find((p) => p.code === 'BW_GELPK') || {}).qty || 0;
  // Dry ice = the WEATHER + transit + UN1845-cap model (config/dryice.js), NOT a
  // flat tier table. computeDryIce always returns >=1 block, so a ground/1_DAY
  // order can no longer show 0 slabs (the spoilage-risk bug). Falls back to the
  // tier table only if the model somehow didn't populate blocks.
  const dryIceSlabs = materialsOnly ? 0 : (dryIce && dryIce.blocks != null ? dryIce.blocks : cfg.dryIceSlabsForTier(order.serviceTier));
  const pack = {
    orderNumber: shipCode,
    materialsOnly,
    serviceTier: order.serviceTier || null, //  1_DAY/2_DAY/3_DAY/1_AIR/2_AIR
    serviceLevel: order.serviceLevel || null, // Datex VendorReference
    dryIceSlabs, //             count of 5 lb slabs (weather + transit + UN1845 model)
    dryIceLb: (dryIce && dryIce.lbs != null ? dryIce.lbs : dryIceSlabs * cfg.SLAB_LB), // total dry-ice weight
    gelPackOz: 24, //           each gel pack weight (Manifest §00); qty 2 every order
    loafUnits: breadUnits,
    contents,
    box: materialsOnly ? null : 'BW_BOX14 — cardboard 14" cube',
    insulation: materialsOnly ? null : '2× Green Cell Foam panels (1")',
    gelPacks,
    kraftPaper: materialsOnly ? 0 : breadUnits, // BW_BFP — one sheet per bread unit
    dryIce,
    carrier: (dryIce && dryIce.carrier) || order.carrier || null,
    shipMode: (dryIce && dryIce.mode) || null, //          'ground' | 'air'
    // air => packer checks the dry-ice button. True if the model flagged it OR the
    // service tier is air (near-zone air orders resolve mode=ground in the model).
    declareDryIce: !!(dryIce && dryIce.declareDryIce) || /_AIR$/.test(order.serviceTier || ''),
    welcomeBooklet: !materialsOnly && !!order.isFirstOrder,
    insert: !materialsOnly, //  BW_INFOSHEET ships on every order now
    blocking, //  reasons the order must NOT be sent (empty => clean)
  };

  return { node: orderNode, warnings, blocking, pack };
}

/**
 * OUTBOUND (single order): one normalized Shopify order -> full Datex XML doc.
 * Root <Orders> wrapping a single <Order>. Used by the real-time webhook path.
 * @returns {{ xml: string, warnings: string[], pack: object }}
 */
function buildCustomerOrder(order, opts = {}) {
  const { CONSTANTS: C } = cfg;
  const { node, warnings, blocking, pack } = buildOrderNode(order, opts);
  const root = el('Orders', [node], { xmlns: C.namespace });
  return { xml: XML_PROLOG + toXml(root), warnings, blocking, pack };
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
    const { node, warnings: w, blocking: b, pack } = buildOrderNode(order);
    nodes.push(node);
    results.push({ number: String(order.number), warnings: w, blocking: b, pack });
    w.forEach((msg) => warnings.push(`#${order.number}: ${msg}`));
    b.forEach((msg) => warnings.push(`#${order.number}: BLOCKED — ${msg}`));
  }
  const root = el('Orders', nodes, { xmlns: C.namespace });
  return { xml: XML_PROLOG + toXml(root), results, warnings, count: nodes.length };
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
