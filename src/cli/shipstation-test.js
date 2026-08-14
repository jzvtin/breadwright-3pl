/**
 * src/cli/shipstation-test.js
 * Push 2 TEST orders to ShipStation v2 — loaves only (no dry ice / paper / cooler).
 * Requested by Bill (2026-08-10): he can't pull orders in himself; wants a couple
 * of test orders on the server to inventory/play with.
 *
 *   SHIPSTATION_API_KEY=... node src/cli/shipstation-test.js         # dry preview (no POST)
 *   SHIPSTATION_API_KEY=... node src/cli/shipstation-test.js --send  # actually create them
 */
const { buildTestShipment, createShipments, tagShipment } = require('../shipstation');

// Two representative test orders. serviceLevel -> ShipStation tag (ship-days filter).
const FIXTURES = [
  {
    number: 'BILL01',
    serviceLevel: '1_DAY',
    shipping: { name: 'Bill Turgeon (TEST)', phone: '5085550100', address1: '451 Currant Rd', city: 'Fall River', state: 'MA', postalCode: '02720' },
    // Founder's Box -> explodes to its 6 component loaves.
    lineItems: [{ sku: 'BW-BOX-01', title: "The Breadwright Founder's Box", quantity: 1 }],
  },
  {
    number: 'BILL02',
    serviceLevel: '2_DAY',
    shipping: { name: 'Bill Turgeon (TEST)', phone: '5085550100', address1: '451 Currant Rd', city: 'Fall River', state: 'MA', postalCode: '02720' },
    // 1 of each bread (Seeded Sourdough = 2 half loaves) — individual line items.
    lineItems: [
      { handle: 'country-sourdough', title: 'Country Sourdough', quantity: 1 },
      { handle: 'pane-francese', title: 'Pane Francese', quantity: 1 },
      { handle: 'multigrain-pullman', title: 'Multigrain Pullman', quantity: 1 },
      { handle: 'cranberry-pecan', title: 'Cranberry Pecan', quantity: 1 },
      { handle: 'french-baguette', title: 'Demi Baguette (2-Pack)', quantity: 1 },
      { handle: 'seeded-sourdough', title: 'Seeded Sourdough Half Loaf', quantity: 2 },
    ],
  },
];

(async () => {
  const send = process.argv.includes('--send');
  const built = FIXTURES.map((o) => buildTestShipment(o, { test: true }));

  for (const { shipment, warnings, tags } of built) {
    console.log(`\n=== ${shipment.shipment_number} -> ${shipment.ship_to.name} ===`);
    console.log(`  tags: ${tags.join(', ')}`);
    shipment.items.forEach((it) => console.log(`  ${String(it.quantity).padStart(2)} x ${it.sku.padEnd(12)} ${it.name}  (${it.weight.value} oz ea)`));
    console.log(`  package weight: ${shipment.packages[0].weight.value} oz`);
    warnings.forEach((w) => console.log(`  ! ${w}`));
  }

  if (!send) { console.log('\nDRY PREVIEW — re-run with --send to create in ShipStation.'); return; }

  const res = await createShipments(built.map((b) => b.shipment));
  console.log('\nPOST /v2/shipments ->', res.status);
  if (res.status >= 300 || (res.body && res.body.errors)) { console.log(JSON.stringify(res.body, null, 2)); return; }

  const created = (res.body && res.body.shipments) || [];
  for (let i = 0; i < created.length; i++) {
    const sh = created[i];
    const tags = ['BW-TEST', ...((built[i] && built[i].tags) || [])];
    const results = [];
    for (const tag of tags) { const t = await tagShipment(sh.shipment_id, tag); results.push(`${tag}:${t.status}`); }
    console.log(`  ${sh.shipment_number}  id=${sh.shipment_id}  status=${sh.shipment_status}  tags-> ${results.join(' ')}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
