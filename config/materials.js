/**
 * config/materials.js
 * ---------------------------------------------------------------------------
 * THE CRUX OF THE WHOLE INTEGRATION.
 *
 * Every value in this file that says `CONFIRM` must be verified with the 3PL
 * (Bill Turgeon / RSI / Datex) before going live. Nothing else in the codebase
 * needs to change when Bill answers — just edit this one file.
 *
 * Source of truth so far: "New Sample Inbound Shipment.xml" (real BW_* codes)
 * and "Sample Customer Order Shipment.xml" (packaging codes). Note the two
 * samples DISAGREE on packaging codes — see PACKAGING below.
 * ---------------------------------------------------------------------------
 */

// Constants that appear on every file (confirmed from all three samples).
const CONSTANTS = {
  projectLookupCode: 'BREADWRIGHT',
  warehouseLookupCode: 'Ice Cube Cold Storage',
  namespace: 'http://www.datexcorp.com/OrderSchema.xsd',
  // TransactionInfo/UserCode differed by direction in the samples.
  // CONFIRM with Bill which user code WE should stamp on files we generate.
  userCodeOutbound: 'ALLEY', // customer order sample used this
  userCodeInbound: 'JP+', //    inbound sample used this
  orderClassOutbound: 'BW', //  customer order
  orderClassInbound: 'PO', //   inbound stock / ASN
};

// Breadwright's own billing/return address (from the inbound samples).
const BREADWRIGHT_ACCOUNT = {
  accountName: 'Breadwright Baking Company',
  accountLookupCode: 'BREADWRIGHT',
  telephone: '7813213400',
  addressLine1: '240 Commercial St',
  addressLine2: ' ',
  city: 'Malden',
  state: 'MA',
  postalCode: '02148',
  country: 'USA',
};

/**
 * Shopify product  ->  WMS MaterialLookupCode.
 * Keyed by Shopify product HANDLE. We also try to match on SKU (see resolver).
 * `null` = we do not yet know the Shopify handle for that WMS code — CONFIRM.
 */
const LOAVES = {
  'country-sourdough': 'BW_CSD', //     confirmed
  'seeded-sourdough': 'BW_SeedSD', //   confirmed (Seeded Sourdough Half Loaf)
  'cranberry-pecan': 'BW_CranPec', //   confirmed
  'multigrain-pullman': 'BW_MGP', //    confirmed
  'french-baguette': 'BW_DB2PK', //     Demi Baguette 2-Pack, confirmed
  'pane-francese': 'BW_PFran', //       confirmed
  // RESOLVED 2026-08-03 (Muhammad "Breadwright SKU & Weight" email): the two
  // remaining codes BW_BFP and BW_WB are NOT sellable products — BW_BFP = Brown
  // Freezer Paper and BW_WB = First-order Welcome Booklet. Both are packaging /
  // inserts, moved to PACKAGING / FIRST_ORDER_INSERTS below.
  // TODO: verify these six Shopify HANDLES match the live storefront exactly.
};

/**
 * Case pack + unit weights, from Muhammad's "Breadwright SKU & Weight" email
 * (2026-08-03). Drives inbound ASN quantities and any weight field. `unitsPerCase`
 * is how many sellable units are in one case (used to convert cases <-> eaches).
 */
const CASE_PACK = {
  BW_CSD: { desc: 'Country Sourdough', caseWeightLb: 12, unitWeightLb: 1, unitsPerCase: 12 },
  BW_MGP: { desc: 'Multigrain Pullman', caseWeightLb: 30, unitWeightLb: 1.5, unitsPerCase: 20 },
  BW_CranPec: { desc: 'Cranberry Pecan', caseWeightLb: 18, unitWeightLb: 1, unitsPerCase: 18 },
  BW_PFran: { desc: 'Pane Francese', caseWeightLb: 10, unitWeightLb: 1, unitsPerCase: 10 },
  BW_DB2PK: { desc: 'Demi Baguette (2-Pack)', caseWeightLb: 12.5, unitWeightOz: 10, unitsPerCase: 20 },
  BW_SeedSD: { desc: 'Seeded Sourdough Half Loaf', caseWeightLb: 16.5, unitsPerCase: 12 },
};

/**
 * "Kit" products (Founder's Box, Build-a-Box, bundles).
 * CONFIRM with Bill: does a box product ship as a single kit code, OR does it
 * explode into its component loaves? Fill this in once decided.
 *   - Ship as kit:  'founders-box': { kit: 'BW_FOUNDERS' }
 *   - Explode:      'founders-box': { explode: [['BW_CSD',1],['BW_MGP',1], ...] }
 */
const KITS = {
  // Keyed by Shopify HANDLE or SKU (resolver checks both).
  // The Breadwright Founder's Box (Shopify SKU BW-BOX-01) = "six artisan loaves".
  // Muhammad's SKU sheet has NO box material code, so this is UNCONFIRMED — we
  // currently ship it as a single kit code and assume Datex has a matching
  // kit/BOM that explodes it warehouse-side. If Datex rejects it, switch to
  // `explode` with the real recipe.
  //   ship as kit:  { kit: 'BW-BOX-01' }
  //   explode:      { explode: [['BW_CSD',1],['BW_MGP',1], ...] }
  'BW-BOX-01': { kit: 'BW-BOX-01' }, //             CONFIRM: real WMS code + kit-vs-explode
  'the-breadwright-founders-box': { kit: 'BW-BOX-01' },
};

/**
 * PACKAGING AUTO-INJECTION — items added to every OUTBOUND customer order
 * that are NOT Shopify line items (box, insulation, ice, inserts).
 *
 * CODES RESOLVED 2026-08-03 from Muhammad's "Breadwright SKU & Weight" email —
 * the definitive codes are the BW_* set (the earlier ICE5_AC/BOX1_RC/GCF1/GCF2
 * sample codes were placeholders). Note the correction: GCF1/GCF2 are the two
 * INSULATION panel sides of the cooler box, NOT gift-card flyers.
 *
 * QUANTITIES are still CONFIRM — Bill/Muhammad have not given the per-box counts:
 *   - BW_DRYICE: driven by transit time -> shipping ZONE (see config/zone-zips.csv);
 *     the warehouse SOP adds dry ice "according to the shipping label requirements."
 *     Default 1x 5lb block until the zone->lbs table is confirmed.
 *   - BW_GELPK: qty per box unknown (may be used instead of / alongside dry ice).
 *   - BW_GCF1 / BW_GCF2: panels per box unknown (likely 1 each = one cooler).
 *   - BW_BFP: freezer paper sheets — likely 1 per loaf; CONFIRM.
 *   - BW_Infosheet: does it ship in EVERY order? (was NOT in the outbound sample).
 */
const PACKAGING = [
  { code: 'BW_BOX14', qty: 1 }, //   Shipping Box 14x14x14 (one per order)
  { code: 'BW_GCF1', qty: 1 }, //    Insulation Side A (T/LS/B) — CONFIRM count
  { code: 'BW_GCF2', qty: 1 }, //    Insulation Side B (S/LS/S) — CONFIRM count
  { code: 'BW_BFP', qty: 1 }, //     Brown Freezer Paper — CONFIRM (per loaf?)
  { code: 'BW_DRYICE', qty: 1 }, //  Dry Ice Block 5lb — CONFIRM zone-based qty
  { code: 'BW_GELPK', qty: 1 }, //   Gel Packs 1.5lb — CONFIRM qty
  // { code: 'BW_Infosheet', qty: 1 }, // CONFIRM: every order? not in outbound sample
];

/**
 * FIRST-ORDER-ONLY inserts. BW_WB (Welcome Booklet) ships only on a customer's
 * very first order per Muhammad's SKU email. NOT YET WIRED into buildOrder.js —
 * needs a "first order for this customer" signal (e.g. Shopify customer
 * orders_count === 1, or an internal ledger). Left here so it isn't lost.
 */
const FIRST_ORDER_INSERTS = [
  { code: 'BW_WB', qty: 1 }, //      First-order Welcome Booklet
];

/**
 * The 7 UserDefinedFields the customer-order sample carried. All false except
 * the verified flag. CONFIRM which are actually required vs optional.
 */
const ORDER_UDFS = [
  { name: 'Order Completely entered and Verified?', value: 'true' },
  { name: 'Pallet Exchange', value: 'false' },
  { name: 'TempTailRequired', value: 'false' },
  { name: 'PlacardsRequired', value: 'false' },
  { name: 'MustBeOnCHEPPallets', value: 'false' },
  { name: 'SpinPallets', value: 'false' },
  { name: 'SealRequired', value: 'false' },
];

const INBOUND_UDFS = [
  { name: 'Order Completely entered and Verified?', value: 'True' },
];

/**
 * Resolve a Shopify line item to a WMS material code.
 * Tries handle first, then SKU (if you set SKUs = codes in Shopify).
 * Returns { code } or { unknown: <identifier> } so callers can flag gaps.
 */
function resolveMaterial(lineItem) {
  const handle = (lineItem.handle || '').toLowerCase();
  const sku = (lineItem.sku || '').trim();
  if (handle && LOAVES[handle]) return { code: LOAVES[handle] };
  if (sku && Object.values(LOAVES).includes(sku)) return { code: sku };
  // Kits match by handle OR sku (Shopify sends SKU like BW-BOX-01).
  const kit = (handle && KITS[handle]) || (sku && KITS[sku]);
  if (kit) return { kit, handle: handle || sku };
  return { unknown: handle || sku || lineItem.title || '(no id)' };
}

module.exports = {
  CONSTANTS,
  BREADWRIGHT_ACCOUNT,
  LOAVES,
  CASE_PACK,
  KITS,
  PACKAGING,
  FIRST_ORDER_INSERTS,
  ORDER_UDFS,
  INBOUND_UDFS,
  resolveMaterial,
};
