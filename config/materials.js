/**
 * config/materials.js
 * ---------------------------------------------------------------------------
 * THE CRUX OF THE WHOLE INTEGRATION.
 *
 * Canonical source of truth (2026-08-18): fixtures/breadwright_sku_map.json plus
 * the reference order fixtures/BW_1003_datex_order.xml. Where older ad-hoc notes
 * disagreed with these (the 08-13 "freezer paper removed / infosheet
 * ShipStation-only" decisions), the 08-18 canonical wins (owner decision).
 *
 * Rules the map mandates:
 *   - All material codes are canonical UPPER_SNAKE. Datex still holds three in
 *     mixed case (BW_SeedSD, BW_CranPec, BW_PFran) — normalize before importing.
 *   - Box SKUs are internal. No box code is ever emitted to Datex; every box
 *     explodes into bread material codes.
 *   - BW_BFP qty = bread units on the order (add-on lines do not count).
 *   - Add-ons whose datex_code is null (BW-EVOO, BW_PGBUTTER) have NO Datex code
 *     and NO stock at Ice Cube — the bridge REJECTS the order rather than ship
 *     short. The Entertainer box is blocked for the same reason (it carries the
 *     butter).
 * ---------------------------------------------------------------------------
 */

// Constants that appear on every file.
const CONSTANTS = {
  projectLookupCode: 'BREADWRIGHT',
  warehouseLookupCode: 'Ice Cube Cold Storage',
  namespace: 'http://www.datexcorp.com/OrderSchema.xsd',
  // TransactionInfo/UserCode differed by direction in the samples.
  userCodeOutbound: 'ALLEY', //  customer order sample (BW_1003) used this
  userCodeInbound: 'JP+', //     inbound sample used this
  orderClassOutbound: 'BW', //   customer order
  orderClassInbound: 'PO', //    inbound stock / ASN
  defaultCarrier: 'UPS Air',
  // OwnerReference = a fixed 6-char to/from-Ice-Cube tag (Bill: NOT the order
  // number). Order number rides in LookupCode. KEEP as BWICCS for now — the
  // 08-18 sample used the numeric Shopify order id instead; flagged, may revisit.
  ownerReference: 'BWICCS',
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
 * The six sellable bread materials. Canonical UPPER_SNAKE codes.
 * weightOz is informational (drives no XML field yet); null = not confirmed.
 */
const BREAD = {
  BW_CSD: { name: 'Country Sourdough', weightOz: 16 },
  BW_SEEDSD: { name: 'Seeded Sourdough Half Loaf', weightOz: null },
  BW_CRANPEC: { name: 'Cranberry Pecan', weightOz: 16 },
  BW_MGP: { name: 'Multigrain Pullman', weightOz: 24 },
  BW_DB2PK: { name: 'Demi Baguette 2-Pack', weightOz: 20 },
  BW_PFRAN: { name: 'Pane Francese', weightOz: 16 },
};

/**
 * Shopify product HANDLE -> WMS MaterialLookupCode (for standalone loaf line
 * items sold outside a box). The resolver also tries SKU and title.
 */
const LOAVES = {
  'country-sourdough': 'BW_CSD',
  'seeded-sourdough': 'BW_SEEDSD',
  'cranberry-pecan': 'BW_CRANPEC',
  'multigrain-pullman': 'BW_MGP',
  'french-baguette': 'BW_DB2PK', //  Demi Baguette 2-Pack
  'demi-baguette': 'BW_DB2PK', //    alt handle
  'pane-francese': 'BW_PFRAN',
};

/**
 * Loaf NAME (lowercased) -> code. Used to resolve Build-a-Box line-item
 * property values (the customer's chosen loaves arrive as human names) and to
 * match a line item by title when handle/sku are missing.
 */
const LOAF_BY_NAME = {
  'country sourdough': 'BW_CSD',
  'seeded sourdough': 'BW_SEEDSD',
  'seeded sourdough half loaf': 'BW_SEEDSD',
  'cranberry pecan': 'BW_CRANPEC',
  'multigrain pullman': 'BW_MGP',
  'demi baguette': 'BW_DB2PK',
  'demi baguette 2-pack': 'BW_DB2PK',
  'demi baguette — 2 pack': 'BW_DB2PK',
  'demi baguette - 2 pack': 'BW_DB2PK',
  'pane francese': 'BW_PFRAN',
};

/** Look up a loaf code from an arbitrary human name (case/space tolerant). */
function loafCodeFromName(name) {
  const k = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (LOAF_BY_NAME[k]) return LOAF_BY_NAME[k];
  // tolerate trailing size/weight noise: match on the longest known name prefix
  for (const [n, code] of Object.entries(LOAF_BY_NAME)) if (k.startsWith(n)) return code;
  return null;
}

/**
 * Box explode recipes (from the map's box_explode). Keyed by Shopify SKU; the
 * resolver also matches known handles. Each box explodes into bread codes — the
 * box code itself is NEVER emitted to Datex.
 *   - lines:        fixed recipe { code: qty } (source 'fixed')
 *   - propertyDriven: loaves come from line-item properties (Build-a-Box)
 *   - blocked:      a reason string => order is held, never shipped short
 *   - breadUnits:   expected loaf count (drives BW_BFP + Build-a-Box validation)
 */
const BOX_EXPLODE = {
  'BW-BOX-01': {
    name: "Founder's Box",
    lines: { BW_CSD: 1, BW_PFRAN: 1, BW_MGP: 1, BW_CRANPEC: 1, BW_DB2PK: 1, BW_SEEDSD: 2 },
    breadUnits: 7,
  },
  BW_CLASSICS: {
    name: 'The Classics Box',
    lines: { BW_CSD: 2, BW_DB2PK: 1, BW_PFRAN: 1, BW_MGP: 1, BW_SEEDSD: 1 },
    breadUnits: 6,
  },
  BW_SDLOVER: {
    name: "Sourdough Lover's",
    lines: { BW_CSD: 2, BW_SEEDSD: 2, BW_CRANPEC: 1, BW_PFRAN: 1 },
    breadUnits: 6,
  },
  BW_SANDWICH: {
    name: 'The Sandwich Box',
    lines: { BW_MGP: 2, BW_CSD: 1, BW_SEEDSD: 1, BW_PFRAN: 1, BW_DB2PK: 1 },
    breadUnits: 6,
  },
  BW_INFLBOX: {
    name: 'Influencer Box',
    lines: { BW_CSD: 1, BW_SEEDSD: 1, BW_CRANPEC: 1, BW_MGP: 1, BW_PFRAN: 1, BW_DB2PK: 1 },
    breadUnits: 6,
  },
  BW_ENTERTAINER: {
    name: 'The Entertainer Box',
    lines: { BW_PFRAN: 1, BW_DB2PK: 1, BW_CSD: 1, BW_SEEDSD: 1, BW_CRANPEC: 1, BW_MGP: 1 },
    breadUnits: 6,
    blocked:
      'Contains BW_PGBUTTER, which has no Datex code and no stock at Ice Cube. Do not enable until the butter is coded + received.',
  },
  BW_BAB6: { name: 'Build A Box — 6', propertyDriven: true, breadUnits: 6 },
  BW_BAB8: { name: 'Build A Box — 8', propertyDriven: true, breadUnits: 8 },
};

// Known Shopify HANDLES that map to a box SKU (resolver convenience).
const BOX_HANDLES = {
  'the-breadwright-founders-box': 'BW-BOX-01',
  'founders-box': 'BW-BOX-01',
  'the-classics-box': 'BW_CLASSICS',
  'sourdough-lovers': 'BW_SDLOVER',
  'the-sandwich-box': 'BW_SANDWICH',
  'influencer-box': 'BW_INFLBOX',
  'the-entertainer-box': 'BW_ENTERTAINER',
  'build-a-box': 'BW_BAB6', // size disambiguated by qty/variant at resolve time
};

/**
 * Add-ons that exist on Shopify but have NO Datex code and NO stock at Ice Cube.
 * Any order line resolving to one of these is a BLOCKING condition (reject, do
 * not ship short). Keyed by SKU; title match is a fallback.
 */
const ADDON_NO_CODE = {
  'BW-EVOO': 'Extra Virgin Olive Oil (no Datex code, no stock at Ice Cube)',
  'BW-ADDON-01': 'Extra Virgin Olive Oil (no Datex code, no stock at Ice Cube)',
  BW_PGBUTTER: 'Ploughgate Butter 8 oz (no Datex code, no stock at Ice Cube)',
  'BW-ADDON-02': 'Cultured Butter (no Datex code, no stock at Ice Cube)',
};
const ADDON_TITLE_RE = /(olive oil|cultured butter|ploughgate|caviar butter)/i;

/**
 * PACKAGING AUTO-INJECTED on every outbound order (not Shopify line items).
 * These four are Datex inventory picks, in the order the BW_1003 sample emits
 * them: box -> GCF1 -> GCF2 -> gel packs. Kept as PACKAGING because packslip.js
 * and shipstation.js consume this exact list.
 */
const PACKAGING = [
  { code: 'BW_BOX14', qty: 1 }, //  Cardboard shipping box 14x14x14
  { code: 'BW_GCF1', qty: 1 }, //   Green Cell Foam set 1 (Top/Long Side/Bottom)
  { code: 'BW_GCF2', qty: 1 }, //   Green Cell Foam set 2 (Side/Long Side/Side)
  { code: 'BW_GELPK', qty: 2 }, //  Gel packs — 2 per box, every order
];

/**
 * Inserts emitted to Datex on every order, AFTER the computed BW_BFP line
 * (matches BW_1003 line order: ...BFP, BW_INFOSHEET, [BW_WB]).
 */
const INSERT_EVERY_ORDER = [
  { code: 'BW_INFOSHEET', qty: 1 }, //  info sheet, every order
];

/**
 * Computed lines:
 *   - BW_BFP: one kraft sheet per bread unit on the order.
 *   - BW_WB:  one welcome note, first order only (order.isFirstOrder).
 * BW_WB is appended last, after the inserts (BW_1003 line 13).
 */
const COMPUTED = {
  kraftPaperCode: 'BW_BFP', //          qty = bread units
  welcomeNoteCode: 'BW_WB', //          qty 1 iff first order
};

// Dry ice is computed for the pack sheet ONLY and NEVER emitted to Datex.
const DRYICE_CODE = 'BW_DRYICE';

/**
 * Case pack + unit weights (informational; drives inbound ASN quantities and
 * pack-list descriptions). Canonical UPPER_SNAKE keys.
 */
const CASE_PACK = {
  BW_CSD: { desc: 'Country Sourdough', caseWeightLb: 12, unitWeightLb: 1, unitsPerCase: 12 },
  BW_MGP: { desc: 'Multigrain Pullman', caseWeightLb: 30, unitWeightLb: 1.5, unitsPerCase: 20 },
  BW_CRANPEC: { desc: 'Cranberry Pecan', caseWeightLb: 18, unitWeightLb: 1, unitsPerCase: 18 },
  BW_PFRAN: { desc: 'Pane Francese', caseWeightLb: 10, unitWeightLb: 1, unitsPerCase: 10 },
  BW_DB2PK: { desc: 'Demi Baguette (2-Pack)', caseWeightLb: 12.5, unitWeightOz: 10, unitsPerCase: 20 },
  BW_SEEDSD: { desc: 'Seeded Sourdough Half Loaf', caseWeightLb: 16.5, unitsPerCase: 12 },
  // Packaging / insert descriptions for the pack list.
  BW_BOX14: { desc: 'Cardboard shipping box 14" cube' },
  BW_GCF1: { desc: 'Green Cell Foam set 1' },
  BW_GCF2: { desc: 'Green Cell Foam set 2' },
  BW_GELPK: { desc: 'Gel pack (24 oz)' },
  BW_BFP: { desc: 'Kraft / freezer paper sheet' },
  BW_INFOSHEET: { desc: 'Info sheet' },
  BW_WB: { desc: 'Welcome note' },
};

/**
 * The 7 UserDefinedFields the customer-order sample carried. All false except
 * the verified flag.
 */
const ORDER_UDFS = [
  // Manifest §02/§09-q02: defaults FALSE — the packer flips it TRUE after
  // physically verifying the box. (Bill's early sample had 'true'; confirm Datex
  // still imports an unverified order before go-live.)
  { name: 'Order Completely entered and Verified?', value: 'false' },
  { name: 'Pallet Exchange', value: 'false' },
  { name: 'TempTailRequired', value: 'false' },
  { name: 'PlacardsRequired', value: 'false' },
  { name: 'MustBeOnCHEPPallets', value: 'false' },
  { name: 'SpinPallets', value: 'false' },
  { name: 'SealRequired', value: 'false' },
];

const INBOUND_UDFS = [{ name: 'Order Completely entered and Verified?', value: 'True' }];

/**
 * Resolve a Shopify line item to a WMS result. Returns exactly one of:
 *   { code }                 -> a standalone loaf material line
 *   { box }                  -> a box entry from BOX_EXPLODE (caller explodes it)
 *   { blocked: reason }      -> a hard block (null-Datex-code add-on)
 *   { unknown: id }          -> unrecognized item (blocking; add to the map)
 */
// Real-world SKU spelling variants seen in Shopify exports -> canonical box key.
const BOX_ALIASES = {
  'BW-INFL-BOX-6': 'BW_INFLBOX',
  'BW-INFL-BOX-8': 'BW_INFLBOX',
  'BW-INFLBOX': 'BW_INFLBOX',
  'BW-BOX-01': 'BW-BOX-01',
  'BW_BOX_01': 'BW-BOX-01',
};
// Box product TITLE (lowercased substring) -> canonical box key. Used when a
// line item has a missing/odd SKU (e.g. a manually added box line).
const BOX_BY_TITLE = [
  { m: "founder", key: 'BW-BOX-01' },
  { m: 'influencer', key: 'BW_INFLBOX' },
  { m: 'classics', key: 'BW_CLASSICS' },
  { m: "sourdough lover", key: 'BW_SDLOVER' },
  { m: 'sandwich box', key: 'BW_SANDWICH' },
  { m: 'entertainer', key: 'BW_ENTERTAINER' },
  { m: 'build a box', key: 'BW_BAB6' },
];
function boxByTitle(title) {
  const t = (title || '').toLowerCase();
  const hit = BOX_BY_TITLE.find((b) => t.includes(b.m));
  return hit ? hit.key : null;
}

function resolveMaterial(lineItem) {
  const handle = (lineItem.handle || '').toLowerCase().trim();
  const sku = (lineItem.sku || '').trim();
  const skuU = sku.toUpperCase();
  const title = (lineItem.title || '').trim();

  // 1) Boxes (by SKU, alias, handle, then title). Never emit the box code itself.
  if (BOX_EXPLODE[sku]) return { box: { key: sku, ...BOX_EXPLODE[sku] } };
  if (BOX_EXPLODE[skuU]) return { box: { key: skuU, ...BOX_EXPLODE[skuU] } };
  if (BOX_ALIASES[skuU]) { const key = BOX_ALIASES[skuU]; return { box: { key, ...BOX_EXPLODE[key] } }; }
  if (handle && BOX_HANDLES[handle]) {
    const key = BOX_HANDLES[handle];
    return { box: { key, ...BOX_EXPLODE[key] } };
  }
  // Title match only when there's no SKU (avoid overriding a real loaf SKU).
  if (!sku && !handle) {
    const bt = boxByTitle(title);
    if (bt) return { box: { key: bt, ...BOX_EXPLODE[bt] } };
  }

  // 2) Null-Datex-code add-ons -> hard block.
  if (ADDON_NO_CODE[sku] || ADDON_NO_CODE[skuU]) return { blocked: ADDON_NO_CODE[sku] || ADDON_NO_CODE[skuU] };
  if (title && ADDON_TITLE_RE.test(title)) return { blocked: `${title} — no Datex code / no stock at Ice Cube` };

  // 3) Standalone loaves (handle -> sku-as-code -> title).
  if (handle && LOAVES[handle]) return { code: LOAVES[handle] };
  if (skuU && BREAD[skuU]) return { code: skuU };
  const byName = loafCodeFromName(title);
  if (byName) return { code: byName };

  return { unknown: handle || sku || title || '(no id)' };
}

/**
 * Parse Build-a-Box chosen loaves from a line item's `properties` array.
 * Properties are Shopify name/value pairs; we collect every value (and, if a
 * value is a comma/newline list, every element) that maps to a known loaf.
 * @returns {{ lines: object } | { blocked: string }}
 */
function resolveBuildABox(box, lineItem) {
  const props = Array.isArray(lineItem.properties) ? lineItem.properties : [];
  const chosen = [];
  for (const p of props) {
    if (!p || p.name == null) continue;
    if (String(p.name).startsWith('_')) continue; // hidden/app props
    for (const piece of String(p.value == null ? '' : p.value).split(/[,;\n]/)) {
      const code = loafCodeFromName(piece);
      if (code) chosen.push(code);
    }
  }
  if (chosen.length !== box.breadUnits) {
    return {
      blocked: `Build-a-Box (${box.name}) expected ${box.breadUnits} loaves but parsed ${chosen.length} from line-item properties — resolve in Shopify before sending.`,
    };
  }
  const lines = {};
  for (const code of chosen) lines[code] = (lines[code] || 0) + 1;
  return { lines };
}

/**
 * TWO service concepts (Ship Day Manifest §00):
 *   - Display TIER (on the pack list, drives dry-ice guidance): five granular
 *     values 1_DAY / 2_DAY / 3_DAY / 1_AIR / 2_AIR.
 *   - Datex <VendorReference>: the WMS-safe set 1_DAY / 2_DAY / 3_DAY / AIR
 *     (both air tiers collapse to AIR for Datex, per Bill).
 */
const SERVICE_TIERS = [
  { match: ['next day air', 'nextday air', 'overnight air', '1_air', 'priority overnight'], tier: '1_AIR', vref: 'AIR' },
  { match: ['2nd day air', 'second day air', 'two day air', '2 day air', '2day air', '2_air'], tier: '2_AIR', vref: 'AIR' },
  { match: ['air'], tier: '1_AIR', vref: 'AIR' }, // bare "air" -> assume overnight
  { match: ['3 day', '3day', 'three day', '3_day'], tier: '3_DAY', vref: '3_DAY' },
  { match: ['2 day', '2day', 'second day', 'two day', '2_day'], tier: '2_DAY', vref: '2_DAY' },
  { match: ['next day', 'overnight', '1 day', 'nextday', 'next_day', '1_day', 'ground'], tier: '1_DAY', vref: '1_DAY' },
];
const DEFAULT_SERVICE_TIER = '2_DAY';
const DEFAULT_SERVICE_LEVEL = '2_DAY';

// DEFINITIVE dry-ice-by-tier rule (Justin, 2026-08-18). Slabs are 5 lb each.
//   1_DAY ground = none · 2_DAY ground = 2 · 1_AIR / 2_AIR = 1 each.
//   3_DAY ground was not specified -> assumed 2 (CONFIRM).
const TIER_SLABS = { '1_DAY': 0, '2_DAY': 2, '3_DAY': 2, '1_AIR': 1, '2_AIR': 1 };
const SLAB_LB = 5;
function dryIceSlabsForTier(tier) {
  return TIER_SLABS[tier] != null ? TIER_SLABS[tier] : 2; // unknown tier -> safe 2
}

// Back-compat: some code still reads SERVICE_LEVELS.
const SERVICE_LEVELS = SERVICE_TIERS.map((t) => ({ match: t.match, value: t.vref }));

function matchTier(shippingLines) {
  const first = Array.isArray(shippingLines) ? shippingLines[0] : null;
  const hay = `${(first && first.title) || ''} ${(first && first.code) || ''}`.toLowerCase();
  return SERVICE_TIERS.find((t) => t.match.some((m) => hay.includes(m))) || null;
}
/** Granular display tier for the pack list (1_DAY/2_DAY/3_DAY/1_AIR/2_AIR). */
function resolveServiceTier(shippingLines) {
  const t = matchTier(shippingLines);
  return t ? t.tier : DEFAULT_SERVICE_TIER;
}
/** Datex <VendorReference> value (1_DAY/2_DAY/3_DAY/AIR). */
function resolveServiceLevel(shippingLines) {
  const t = matchTier(shippingLines);
  return t ? t.vref : DEFAULT_SERVICE_LEVEL;
}

module.exports = {
  CONSTANTS,
  BREADWRIGHT_ACCOUNT,
  BREAD,
  LOAVES,
  LOAF_BY_NAME,
  loafCodeFromName,
  BOX_EXPLODE,
  BOX_HANDLES,
  ADDON_NO_CODE,
  PACKAGING,
  INSERT_EVERY_ORDER,
  COMPUTED,
  DRYICE_CODE,
  CASE_PACK,
  ORDER_UDFS,
  INBOUND_UDFS,
  SERVICE_LEVELS,
  SERVICE_TIERS,
  TIER_SLABS,
  SLAB_LB,
  dryIceSlabsForTier,
  DEFAULT_SERVICE_LEVEL,
  DEFAULT_SERVICE_TIER,
  resolveServiceLevel,
  resolveServiceTier,
  resolveMaterial,
  resolveBuildABox,
};
