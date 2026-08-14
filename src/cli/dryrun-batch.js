/**
 * src/cli/dryrun-batch.js
 * DRY RUN — no SFTP, no network. Builds ONE end-of-day batch XML from one or
 * more Shopify order JSONs and writes it to out/. Proves the batch envelope
 * (single <Orders> root wrapping every <Order>) before go-live.
 *
 *   node src/cli/dryrun-batch.js [order1.json order2.json ...]
 * Defaults to both fixtures.
 */
const fs = require('fs');
const path = require('path');
const { normalizeOrder } = require('../shopify');
const { buildBatch } = require('../xml/buildOrder');

const args = process.argv.slice(2);
const inputs = args.length
  ? args
  : ['order-1002.json', 'sample-shopify-order.json'].map((f) => path.join(__dirname, '../../fixtures', f));

// Fixed base date so output is stable/diffable.
const now = new Date('2026-08-05T04:00:00Z');
const orders = inputs.map((f) => normalizeOrder(JSON.parse(fs.readFileSync(f, 'utf8')), now));
const { xml, results, warnings, count } = buildBatch(orders);

const outPath = path.join(__dirname, '../../out', 'BW_BATCH_dryrun.xml');
fs.writeFileSync(outPath, xml, 'utf8');

console.log(`\n[dry-run] Batch of ${count} order(s): ${results.map((r) => '#' + r.number).join(', ')}`);
console.log(`[dry-run] Wrote ${outPath}\n`);
if (warnings.length) {
  console.log('⚠️  WARNINGS (resolve before go-live):');
  warnings.forEach((w) => console.log('   - ' + w));
  console.log('');
}
console.log(xml);
