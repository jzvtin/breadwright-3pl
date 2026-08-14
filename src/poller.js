/**
 * src/poller.js
 * RETURN FEED (skeleton). Scheduled job: read files the WMS drops back on SFTP
 * (ship confirmations w/ tracking, maybe inventory), and write fulfillment +
 * tracking into Shopify.
 *
 * Schema confirmed with Bill (2026-08-11): OrderReference == our order number,
 * tracking in TrackingNumber/VendorReference, carrier in CarrierLookupCode.
 * Run as a Railway cron (every 10 min) or a setInterval in server.js.
 */
const { fetchReturnFiles, archiveReturnFile } = require('./sftp');
const { confirmShipment } = require('./shopify');

/**
 * Best-guess parser. The outbound sample carried the tracking number in
 * <VendorReference> and the Shopify order number in <LookupCode>, so if the
 * WMS echoes the same envelope back with those populated, this will work.
 * Replace the regexes with a real XML parse once the schema is confirmed.
 */
function parseReturnFile(xml) {
  const orderNumber = (xml.match(/<OrderReference>([^<]+)<\/OrderReference>/) || [])[1]
    || (xml.match(/<LookupCode>([^<]+)<\/LookupCode>/) || [])[1];
  const tracking = (xml.match(/<TrackingNumber>([^<]+)<\/TrackingNumber>/) || [])[1]
    || (xml.match(/<VendorReference>([^<]+)<\/VendorReference>/) || [])[1];
  const carrier = (xml.match(/<CarrierLookupCode>([^<]+)<\/CarrierLookupCode>/) || [])[1] || 'UPS';
  return { orderNumber, tracking, carrier };
}

async function runOnce() {
  const files = await fetchReturnFiles();
  console.log(`[poller] ${files.length} return file(s)`);
  for (const f of files) {
    try {
      const parsed = parseReturnFile(f.content);
      if (!parsed.tracking || !parsed.orderNumber) {
        console.warn(`[poller] ${f.name}: no tracking/order — skipping (schema differs?)`);
        continue;
      }
      const dryRun = process.env.DRY_RUN === '1' || !process.env.SHOPIFY_ADMIN_TOKEN;
      const r = await confirmShipment({ number: parsed.orderNumber, tracking: parsed.tracking, carrier: parsed.carrier, dryRun });
      if (r.ok) {
        console.log('[poller] ' + f.name + ': order ' + parsed.orderNumber + ' -> ' + (r.dryRun ? 'DRY-RUN (would email)' : 'fulfilled + emailed'));
      } else {
        console.warn('[poller] ' + f.name + ': ' + r.error);
      }
      if (r.ok && !r.dryRun) await archiveReturnFile(f.name);
    } catch (err) {
      console.error(`[poller] ${f.name} failed:`, err);
    }
  }
}

if (require.main === module) {
  runOnce().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { runOnce, parseReturnFile };
