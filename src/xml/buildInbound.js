/**
 * src/xml/buildInbound.js
 * INBOUND (stock/ASN): a production batch -> Datex "Inbound Shipment" XML.
 *
 * Root is a bare <Order> (NOT wrapped in <Orders>). Mirrors
 * "New Sample Inbound Shipment.xml" (OrderClass PO, UserCode JP+).
 */
const { el, toXml } = require('./util');
const { addressBlock } = require('./address');
const cfg = require('../../config/materials');

function inboundLine(lineNumber, shipmentCode, materialCode, amount, lot) {
  const children = [
    el('LineNumber', lineNumber),
    el('ShipmentLookupCode', shipmentCode),
    el('MaterialSerialControlled', 'false'),
    el('MaterialLookupCode', materialCode),
    el('MaterialAmount', amount),
    el('MaterialPackagingName', 'EACH'),
    el('QualityControlRequired', 'False'),
  ];
  // Lot block appeared in the first sample, absent in the "New" one.
  // Include only when a lot code is supplied. CONFIRM if lots are required.
  if (lot) {
    children.push(el('Lot', [el('LookupCode', lot), el('VendorLotLookupCode', lot)]));
  }
  return el('OrderLine', children);
}

/**
 * @param {object} batch
 *   { reference, requestedDelivery, expected,
 *     lines: [{ code, amount, lot? }],
 *     carrier?, billOfLading?, sealNumber?, trailerNumber?, trackingNumber?,
 *     shipTo? (defaults to the warehouse) }
 * @returns {{ xml: string, warnings: string[] }}
 */
function buildInbound(batch) {
  const { CONSTANTS: C, BREADWRIGHT_ACCOUNT, INBOUND_UDFS } = cfg;
  const warnings = [];
  const ref = String(batch.reference);

  if (!batch.lines || batch.lines.length === 0) {
    warnings.push('Inbound batch has no lines.');
  }

  const lines = batch.lines.map((l, i) =>
    inboundLine(i + 1, ref, l.code, l.amount, l.lot)
  );

  // For an ASN, stock is received INTO the warehouse. The samples put a person
  // in ShipTo (looks like test data); default ShipTo to the warehouse/Breadwright
  // account unless the caller overrides. CONFIRM correct inbound ShipTo with Bill.
  const shipTo = batch.shipTo || {
    accountName: C.warehouseLookupCode,
    accountLookupCode: '000000000200',
    telephone: BREADWRIGHT_ACCOUNT.telephone,
    addressLine1: BREADWRIGHT_ACCOUNT.addressLine1,
    city: BREADWRIGHT_ACCOUNT.city,
    state: BREADWRIGHT_ACCOUNT.state,
    postalCode: BREADWRIGHT_ACCOUNT.postalCode,
    country: BREADWRIGHT_ACCOUNT.country,
  };

  const orderHeader = el('OrderHeader', [
    el('ProjectLookupCode', C.projectLookupCode),
    el('OrderClass', C.orderClassInbound),
    el('LookupCode', ref),
    el('OwnerReference', ref),
    el('VendorReference', ref),
    el('Dates', [el('Date', [el('Type', 'RequestedDelivery'), el('Value', batch.requestedDelivery)])]),
    el('Addresses', [addressBlock(BREADWRIGHT_ACCOUNT, { role: 'billing', orderAddress: 'True' })]),
    el('OrderLines', lines),
    el('UserDefinedFields', INBOUND_UDFS.map((u) => el('UserDefinedField', [el('Name', u.name), el('Value', u.value)]))),
  ]);

  const shipmentChildren = [
    el('WarehouseLookupCode', C.warehouseLookupCode),
    el('LookupCode', ref),
    el('ReferenceNumber', ref),
    el('CarrierLookupCode', batch.carrier || 'Ice Cube Logistics'),
    el('BillOfLading', batch.billOfLading || ref),
  ];
  if (batch.sealNumber) shipmentChildren.push(el('SealNumber', batch.sealNumber));
  if (batch.trailerNumber) shipmentChildren.push(el('TrailerNumber', batch.trailerNumber));
  if (batch.trackingNumber) shipmentChildren.push(el('TrackingNumber', batch.trackingNumber));
  shipmentChildren.push(
    el('Dates', [el('Date', [el('Type', 'Expected'), el('Value', batch.expected || batch.requestedDelivery)])]),
    el('Addresses', [addressBlock(shipTo, { role: 'shipping', placeIn: 'ShipTo' })]),
  );

  const root = el('Order', [
    el('TransactionInfo', [el('UserCode', C.userCodeInbound), el('Type', 'Inbound'), el('Operation', 'New')]),
    el('OrderHeaders', [orderHeader]),
    el('ShipmentHeaders', [el('ShipmentHeader', shipmentChildren)]),
  ], { xmlns: C.namespace });

  return { xml: toXml(root), warnings };
}

module.exports = { buildInbound };
