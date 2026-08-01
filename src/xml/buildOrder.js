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
 * @param {object} order normalized order:
 *   { number, orderId, requestedDelivery, billing, shipping,
 *     lineItems: [{ handle, sku, title, quantity }], tracking? }
 * @returns {{ xml: string, warnings: string[] }}
 */
function buildCustomerOrder(order) {
  const { CONSTANTS: C, resolveMaterial, PACKAGING, ORDER_UDFS } = cfg;
  const warnings = [];
  const shipCode = String(order.number);

  // 1) Real product lines from Shopify, mapped to WMS codes.
  const lines = [];
  let n = 1;
  for (const li of order.lineItems) {
    const r = resolveMaterial(li);
    if (r.code) {
      lines.push(orderLine(n++, shipCode, r.code, li.quantity));
    } else if (r.kit) {
      // Kit handling is unresolved until Bill confirms — surface loudly.
      warnings.push(
        `Kit product "${r.handle}" has no resolution rule yet (kit vs explode) — see config/materials.js KITS.`
      );
    } else {
      warnings.push(
        `No WMS material code for Shopify item "${r.unknown}" — add it to config/materials.js LOAVES.`
      );
    }
  }

  // 2) Auto-injected packaging (ice / box / inserts) — not Shopify line items.
  for (const p of PACKAGING) {
    lines.push(orderLine(n++, shipCode, p.code, p.qty));
  }

  // 3) Header. VendorReference held a tracking number in the sample, but we
  //    generate this BEFORE shipping, so we omit it unless one is supplied.
  const headerChildren = [
    el('ProjectLookupCode', C.projectLookupCode),
    el('OrderClass', C.orderClassOutbound),
    el('LookupCode', shipCode),
  ];
  if (order.tracking) headerChildren.push(el('VendorReference', order.tracking));
  if (order.orderId != null) headerChildren.push(el('OwnerReference', String(order.orderId)));
  headerChildren.push(
    el('Dates', [el('Date', [el('Type', 'RequestedDelivery'), el('Value', order.requestedDelivery)])]),
    el('Addresses', [addressBlock(order.billing, { role: 'billing', orderAddress: 'true' })]),
    el('OrderLines', lines),
    el('UserDefinedFields', ORDER_UDFS.map((u) => el('UserDefinedField', [el('Name', u.name), el('Value', u.value)]))),
  );

  const shipmentChildren = [
    el('WarehouseLookupCode', C.warehouseLookupCode),
    el('LookupCode', shipCode),
    el('Notes', null),
    el('Dates', [el('Date', [el('Type', 'Expected'), el('Value', order.requestedDelivery)])]),
    el('Addresses', [addressBlock(order.shipping, { role: 'shipping', placeIn: 'ShipTo' })]),
  ];

  const orderNode = el('Order', [
    el('TransactionInfo', [el('UserCode', C.userCodeOutbound), el('Type', 'Order'), el('Operation', 'New')]),
    el('OrderHeaders', [el('OrderHeader', headerChildren)]),
    el('ShipmentHeaders', [el('ShipmentHeader', shipmentChildren)]),
  ]);

  const root = el('Orders', [orderNode], { xmlns: C.namespace });
  return { xml: toXml(root), warnings };
}

module.exports = { buildCustomerOrder };
