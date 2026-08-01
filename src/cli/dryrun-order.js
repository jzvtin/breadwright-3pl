/**
 * src/cli/dryrun-order.js
 * DRY RUN — no SFTP, no network. Reads a Shopify order JSON, builds the Datex
 * customer-order XML, prints warnings, and writes it to out/.
 *
 *   node src/cli/dryrun-order.js [path-to-order.json]
 * Defaults to fixtures/sample-shopify-order.json.
 */
const fs = require('fs');
const path = require('path');
const { normalizeOrder } = require('../shopify');
const { buildCustomerOrder } = require('../xml/buildOrder');

const inPath = process.argv[2] || path.join(__dirname, '../../fixtures/sample-shopify-order.json');
const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));

// Fixed base date so output is stable/diffable.
const order = normalizeOrder(raw, new Date('2026-07-30T12:00:00Z'));
const { xml, warnings } = buildCustomerOrder(order);

const outPath = path.join(__dirname, '../../out', `BW_${order.number}_dryrun.xml`);
fs.writeFileSync(outPath, xml, 'utf8');

console.log(`\n[dry-run] Outbound customer order for #${order.number}`);
console.log(`[dry-run] Wrote ${outPath}\n`);
if (warnings.length) {
  console.log('⚠️  WARNINGS (things to resolve before go-live):');
  warnings.forEach((w) => console.log('   - ' + w));
  console.log('');
}
console.log(xml);
