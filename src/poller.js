/**
 * src/poller.js
 * RETURN FEED (skeleton). Scheduled job: read files the WMS drops back on SFTP
 * (ship confirmations w/ tracking, maybe inventory), and write fulfillment +
 * tracking into Shopify.
 *
 * ⚠️ We do NOT yet have a sample of the return file, so parseReturnFile() is a
 * best-guess placeholder. CONFIRM the return schema with Bill, then finish it.
 * Run as a Railway cron ("*/10 * * * *") or a setInterval in server.js.
 */
const { fetchReturnFiles, archiveReturnFile } = require('./sftp');
const { createFulfillment } = require('./shopify');

/**
 * Best-guess parser. The outbound sample carried the tracking number in
 * <VendorReference> and the Shopify order number in <LookupCode>, so if the
 * WMS echoes the same envelope back with those populated, this will work.
 * Replace the regexes with a real XML parse once the schema is confirmed.
 */
function parseReturnFile(xml) {
  const orderNumber = (xml.match(/<LookupCode>([^<]+)<\/LookupCode>/) || [])[1];
  const tracking = (xml.match(/<VendorReference>([^<]+)<\/VendorReference>/) || [])[1];
  const carrier = (xml.match(/<CarrierLookupCode>([^<]+)<\/CarrierLookupCode>/) || [])[1];
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
      // Needs a Shopify order-number -> fulfillmentOrderId lookup, added once we
      // confirm the return format. Stubbed to make the wiring explicit:
      // const foId = await lookupFulfillmentOrderId(parsed.orderNumber);
      // await createFulfillment({ fulfillmentOrderId: foId, trackingNumber: parsed.tracking, trackingCompany: parsed.carrier });
      console.log(`[poller] ${f.name}: order ${parsed.orderNumber} tracking ${parsed.tracking} (write-back TODO)`);
      await archiveReturnFile(f.name);
    } catch (err) {
      console.error(`[poller] ${f.name} failed:`, err);
    }
  }
}

if (require.main === module) {
  runOnce().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { runOnce, parseReturnFile };
