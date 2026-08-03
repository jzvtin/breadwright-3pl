/**
 * One-off manual test-order send. Builds the fixture order XML and SFTP-puts it
 * into the 3PL /test folder, listing before + after to prove it landed.
 * Temporary — safe to delete after the test.
 */
const fs = require('fs');
const path = require('path');
const Client = require('ssh2-sftp-client');
const { normalizeOrder } = require('./src/shopify');
const { buildCustomerOrder } = require('./src/xml/buildOrder');

// minimal .env loader (repo has no dotenv dependency)
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

(async () => {
  // node send-test-order.js [fixture.json] [requestedDeliveryYYYY-MM-DD]
  const fixture = process.argv[2] || 'fixtures/sample-shopify-order.json';
  const raw = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const order = normalizeOrder(raw, new Date('2026-08-03T12:00:00Z'));
  if (process.argv[3]) order.requestedDelivery = process.argv[3];
  const { xml, warnings } = buildCustomerOrder(order);
  const filename = `BW_${order.number}_TEST.xml`;
  const dir = process.env.DATEX_SFTP_OUTBOUND_DIR;

  console.log(`Order #${order.number} -> ${filename} (${xml.length} bytes)`);
  if (warnings.length) console.log('warnings:', warnings);

  const sftp = new Client();
  await sftp.connect({
    host: process.env.DATEX_SFTP_HOST,
    port: Number(process.env.DATEX_SFTP_PORT || 22),
    username: process.env.DATEX_SFTP_USER,
    password: process.env.DATEX_SFTP_PASSWORD,
  });
  try {
    console.log(`\nBEFORE — contents of ${dir}:`);
    console.log((await sftp.list(dir)).map((f) => `  ${f.type} ${f.size}\t${f.name}`).join('\n') || '  (empty)');

    const remote = `${dir}/${filename}`;
    await sftp.put(Buffer.from(xml, 'utf8'), remote);
    console.log(`\n✅ PUT ${remote}`);

    console.log(`\nAFTER — contents of ${dir}:`);
    console.log((await sftp.list(dir)).map((f) => `  ${f.type} ${f.size}\t${f.name}`).join('\n'));
  } finally {
    await sftp.end();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
