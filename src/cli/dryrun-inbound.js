/**
 * src/cli/dryrun-inbound.js
 * DRY RUN — build an inbound (ASN) XML from a batch JSON. No SFTP/network.
 *
 *   node src/cli/dryrun-inbound.js [path-to-batch.json]
 * With no arg, uses a built-in example batch.
 */
const fs = require('fs');
const path = require('path');
const { buildInbound } = require('../xml/buildInbound');

const example = {
  reference: 'INB-00001',
  requestedDelivery: '2026-08-01',
  expected: '2026-08-01',
  carrier: 'Ice Cube Logistics',
  lines: [
    { code: 'BW_CSD', amount: 1600 },
    { code: 'BW_MGP', amount: 1600 },
    { code: 'BW_CRANPEC', amount: 1600 },
    { code: 'BW_PFRAN', amount: 1600 },
    { code: 'BW_DB2PK', amount: 1600 },
    { code: 'BW_SEEDSD', amount: 1600 },
  ],
};

const inPath = process.argv[2];
const batch = inPath ? JSON.parse(fs.readFileSync(inPath, 'utf8')) : example;

const { xml, warnings } = buildInbound(batch);
const outPath = path.join(__dirname, '../../out', `${batch.reference}_dryrun.xml`);
fs.writeFileSync(outPath, xml, 'utf8');

console.log(`\n[dry-run] Inbound ASN ${batch.reference}`);
console.log(`[dry-run] Wrote ${outPath}\n`);
if (warnings.length) {
  console.log('⚠️  WARNINGS:');
  warnings.forEach((w) => console.log('   - ' + w));
  console.log('');
}
console.log(xml);
