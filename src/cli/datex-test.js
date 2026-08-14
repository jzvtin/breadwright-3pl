/**
 * src/cli/datex-test.js
 * Drop 2 TEST orders into the OLD DATEX system (SFTP /Test) — loaves ONLY:
 * no dry ice, no freezer paper, no cooler packaging. Bill will inventory them.
 * Requested 2026-08-10.
 *
 *   node src/cli/datex-test.js         # dry preview -> out/*.xml (no SFTP)
 *   node src/cli/datex-test.js --send  # SFTP-put both files into /Test
 */
const fs = require('fs');
const path = require('path');
const { normalizeOrder } = require('../shopify');
const { buildCustomerOrder } = require('../xml/buildOrder');
const { sendToTest } = require('../sftp');

// minimal .env loader (repo has no dotenv dependency)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '../../.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch (_) {}

const TEST_ADDR = {
  first_name: 'Bill', last_name: 'Turgeon (TEST)', phone: '5085550100',
  address1: '451 Currant Rd', city: 'Fall River', province_code: 'MA', zip: '02720', country_code: 'US',
};

// Two representative TEST orders, Shopify-shaped (fed through normalizeOrder).
const RAW = [
  {
    name: '#BILL01', email: 'bill.test@breadwrightbox.com',
    shipping_address: TEST_ADDR, billing_address: TEST_ADDR,
    line_items: [{ sku: 'BW-BOX-01', title: "The Breadwright Founder's Box", quantity: 1 }], // -> 6 loaves
  },
  {
    name: '#BILL02', email: 'bill.test@breadwrightbox.com',
    shipping_address: TEST_ADDR, billing_address: TEST_ADDR,
    line_items: [
      { handle: 'country-sourdough', title: 'Country Sourdough', quantity: 2 },
      { handle: 'multigrain-pullman', title: 'Multigrain Pullman', quantity: 1 },
      { handle: 'seeded-sourdough', title: 'Seeded Sourdough Half Loaf', quantity: 1 },
    ],
  },
];

(async () => {
  const send = process.argv.includes('--send');
  const built = RAW.map((raw) => {
    const order = normalizeOrder(raw);
    // Bill 08-11: send the packaging materials too (they inventory them) —
    // everything EXCEPT dry ice. So full packaging now, not materialsOnly.
    const { xml, warnings, pack } = buildCustomerOrder(order, { materialsOnly: false });
    return { order, xml, warnings, pack, filename: `BW_${order.number}_TEST.xml` };
  });

  for (const b of built) {
    console.log(`\n=== ${b.filename}  (order ${b.order.number}) ===`);
    b.pack.contents.forEach((c) => console.log(`  ${c.qty} x ${c.code.padEnd(10)} ${c.desc}`));
    console.log(`  materialsOnly=${b.pack.materialsOnly}  (no dry ice / paper / cooler)`);
    b.warnings.forEach((w) => console.log(`  ! ${w}`));
  }

  if (!send) {
    for (const b of built) fs.writeFileSync(path.join(__dirname, '../../out', b.filename), b.xml, 'utf8');
    console.log('\nDRY PREVIEW — wrote XML to out/. Re-run with --send to SFTP into /Test.');
    return;
  }

  for (const b of built) {
    const r = await sendToTest(b.filename, b.xml);
    const landed = r.after.some((f) => f.name === b.filename);
    console.log(`\nPUT ${r.remote}  -> ${landed ? 'LANDED' : 'NOT FOUND after'}  (dir ${r.dir}, ${r.after.length} files)`);
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
