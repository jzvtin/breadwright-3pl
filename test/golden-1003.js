/**
 * Golden-file test: regenerate order #1003 and prove the emitted Datex order
 * lines match fixtures/BW_1003_datex_order.xml (the 2026-08-18 canonical sample).
 * Line ORDER is not significant to the WMS, so we compare the multiset of
 * (MaterialLookupCode -> total MaterialAmount), plus envelope + blocking rules.
 *
 * Run: node test/golden-1003.js   (exit 0 = pass, 1 = fail; no framework)
 */
const fs = require('fs');
const path = require('path');
const { buildCustomerOrder } = require('../src/xml/buildOrder');
const { normalizeOrder } = require('../src/shopify');

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  FAIL:', msg); } else console.log('  ok:', msg); };

/** Parse {MaterialLookupCode -> summed MaterialAmount} from a Datex XML string. */
function lineTotals(xml) {
  const totals = {};
  const re = /<MaterialLookupCode>([^<]+)<\/MaterialLookupCode>\s*<MaterialAmount>([^<]+)<\/MaterialAmount>/g;
  let m;
  while ((m = re.exec(xml))) totals[m[1]] = (totals[m[1]] || 0) + Number(m[2]);
  return totals;
}
function sameTotals(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs = [];
  for (const k of keys) if ((a[k] || 0) !== (b[k] || 0)) diffs.push(`${k}: got ${a[k] || 0}, want ${b[k] || 0}`);
  return diffs;
}

// The #1003 order, in raw Shopify shape. Both add-ons were removed by an order
// edit -> current_quantity 0, so they must NOT appear (and must NOT block).
const addr = {
  first_name: 'Holly', last_name: 'Hoyt', address1: '305 Basilwood Way',
  city: 'Highlands Ranch', province_code: 'CO', zip: '80126', country_code: 'US', phone: '+15087763302',
};
const raw1003 = {
  name: '#1003', id: 6989285326947,
  customer: { orders_count: 1 }, // first order -> BW_WB
  shipping_address: addr, billing_address: addr,
  shipping_lines: [{ title: '2 Day' }],
  line_items: [
    { sku: 'BW-BOX-01', title: "Founder's Box", quantity: 1, current_quantity: 1 },
    { sku: 'BW-EVOO', title: 'Extra Virgin Olive Oil', quantity: 1, current_quantity: 0 },
    { sku: 'BW-ADDON-02', title: 'Cultured Butter', quantity: 1, current_quantity: 0 },
  ],
};

console.log('[golden #1003]');
const { xml, blocking } = buildCustomerOrder(normalizeOrder(raw1003));
const got = lineTotals(xml);
const want = lineTotals(fs.readFileSync(path.join(__dirname, '../fixtures/BW_1003_datex_order.xml'), 'utf8'));

// 2026-08-19 (Justin): BW_BFP, BW_INFOSHEET, BW_WB are no longer emitted to Datex.
// Strip them from the canonical fixture totals before comparing.
const REMOVED_CODES = ['BW_BFP', 'BW_INFOSHEET', 'BW_WB'];
for (const c of REMOVED_CODES) delete want[c];

const diffs = sameTotals(got, want);
ok(diffs.length === 0, 'line multiset matches BW_1003 fixture (BFP/INFOSHEET/WB excluded)' + (diffs.length ? ` -> ${diffs.join(' | ')}` : ''));
ok((blocking || []).length === 0, 'clean order (removed add-ons do not block)');
ok(REMOVED_CODES.every((c) => !(c in got)), 'BW_BFP / BW_INFOSHEET / BW_WB no longer emitted');
ok(!('BW-BOX-01' in got) && !('BW_BOX01' in got), 'no box code emitted');
ok(!('BW_DRYICE' in got), 'no dry-ice line');
ok(!('BW-EVOO' in got) && !('BW-ADDON-02' in got), 'removed add-ons absent');
ok(Object.keys(got).every((c) => /^BW_[A-Z0-9]+$/.test(c)), 'all emitted codes UPPER_SNAKE');
ok(xml.includes('<OwnerReference>BWICCS</OwnerReference>'), 'OwnerReference = BWICCS');

console.log('\n[casing] mixed-case input still resolves + emits UPPER');
{
  const r = buildCustomerOrder(normalizeOrder({
    name: '#T1', shipping_address: addr, billing_address: addr,
    line_items: [{ title: 'Seeded Sourdough', quantity: 2, current_quantity: 2 }],
  }));
  const t = lineTotals(r.xml);
  ok(t.BW_SEEDSD === 2, 'title "Seeded Sourdough" -> BW_SEEDSD x2');
}

console.log('\n[blocking] butter still on order (current_quantity 1) hard-blocks');
{
  const r = buildCustomerOrder(normalizeOrder({
    name: '#T2', customer: { orders_count: 2 }, shipping_address: addr, billing_address: addr,
    line_items: [{ sku: 'BW-BOX-01', title: "Founder's Box", quantity: 1, current_quantity: 1 },
                 { sku: 'BW-ADDON-02', title: 'Cultured Butter', quantity: 1, current_quantity: 1 }],
  }));
  ok(r.blocking.length > 0, 'butter with qty 1 produces a blocking reason');
}

console.log('\n[blocking] Entertainer box hard-blocks');
{
  const r = buildCustomerOrder(normalizeOrder({
    name: '#T3', shipping_address: addr, billing_address: addr,
    line_items: [{ sku: 'BW_ENTERTAINER', title: 'The Entertainer Box', quantity: 1, current_quantity: 1 }],
  }));
  ok(r.blocking.length > 0, 'Entertainer box produces a blocking reason');
}

console.log('\n[build-a-box] property-driven parse + validation');
{
  const props = [
    { name: 'Loaf 1', value: 'Country Sourdough' }, { name: 'Loaf 2', value: 'Country Sourdough' },
    { name: 'Loaf 3', value: 'Seeded Sourdough' }, { name: 'Loaf 4', value: 'Cranberry Pecan' },
    { name: 'Loaf 5', value: 'Multigrain Pullman' }, { name: 'Loaf 6', value: 'Pane Francese' },
  ];
  const good = buildCustomerOrder(normalizeOrder({
    name: '#T4', shipping_address: addr, billing_address: addr,
    line_items: [{ sku: 'BW_BAB6', title: 'Build a Box', quantity: 1, current_quantity: 1, properties: props }],
  }));
  const t = lineTotals(good.xml);
  ok(good.blocking.length === 0 && t.BW_CSD === 2 && !('BW_BFP' in t), 'BAB6 parses 6 loaves, no BW_BFP emitted');

  const bad = buildCustomerOrder(normalizeOrder({
    name: '#T5', shipping_address: addr, billing_address: addr,
    line_items: [{ sku: 'BW_BAB6', title: 'Build a Box', quantity: 1, current_quantity: 1, properties: props.slice(0, 4) }],
  }));
  ok(bad.blocking.length > 0, 'BAB6 with only 4 loaves parsed hard-blocks');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
