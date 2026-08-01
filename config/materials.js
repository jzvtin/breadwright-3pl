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
  'seeded-sourdough': 'BW_SeedSD', //   confirmed
  'cranberry-pecan': 'BW_CranPec', //   confirmed
  'multigrain-pullman': 'BW_MGP', //    confirmed
  'french-baguette': 'BW_DB2PK', //     Demi Baguette 2-Pack, confirmed
  'pane-francese': 'BW_PFran', //       confirmed
  // --- CONFIRM: which Shopify products are these two WMS codes? ---
  // 'brioche-feed-pull?': 'BW_BFP',
  // 'white-bread?':       'BW_WB',
};

/**
 * "Kit" products (Founder's Box, Build-a-Box, bundles).
 * CONFIRM with Bill: does a box product ship as a single kit code, OR does it
 * explode into its component loaves? Fill this in once decided.
 *   - Ship as kit:  'founders-box': { kit: 'BW_FOUNDERS' }
 *   - Explode:      'founders-box': { explode: [['BW_CSD',1],['BW_MGP',1], ...] }
 */
const KITS = {
  // 'founders-box': { kit: null },   // CONFIRM
  // 'build-a-box':  { explode: [] }, // resolved from box contents at runtime
};

/**
 * PACKAGING AUTO-INJECTION — items added to every OUTBOUND customer order
 * that are NOT Shopify line items (ice, box, inserts).
 *
 * ⚠️ The two samples use DIFFERENT codes for the same things:
 *      customer-order sample:  ICE5_AC, BOX1_RC, GCF1,   GCF2
 *      inbound sample:         (n/a),   BW_BOX14, BW_GCF1, BW_GCF2, BW_Infosheet
 * Below follows the CUSTOMER-ORDER sample (that's the real outbound example).
 * CONFIRM the definitive codes + quantities with Bill, including:
 *   - how many ice packs per box, and whether it changes by season/box size
 *   - whether the info sheet ships on every order (it was NOT in the outbound sample)
 */
const PACKAGING = [
  { code: 'ICE5_AC', qty: 2 }, //  ice packs — CONFIRM qty / seasonal rule
  { code: 'BOX1_RC', qty: 1 }, //  shipping box — CONFIRM box-size logic
  { code: 'GCF1', qty: 1 }, //     gift card / flyer insert
  { code: 'GCF2', qty: 1 }, //     gift card / flyer insert
  // { code: 'BW_Infosheet', qty: 1 }, // CONFIRM: every order? not in outbound sample
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
  if (handle && KITS[handle]) return { kit: KITS[handle], handle };
  return { unknown: handle || sku || lineItem.title || '(no id)' };
}

module.exports = {
  CONSTANTS,
  BREADWRIGHT_ACCOUNT,
  LOAVES,
  KITS,
  PACKAGING,
  ORDER_UDFS,
  INBOUND_UDFS,
  resolveMaterial,
};
