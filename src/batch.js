/**
 * src/batch.js
 * END-OF-DAY BATCH — the "batch orders at midnight to Ice Cube" flow.
 *
 * Pulls the day's PAID, unshipped, not-yet-sent orders from Shopify, builds one
 * Datex batch XML (all orders under a single <Orders> root), drops it via SFTP
 * (or to out/ when DRY_RUN=1), then tags each order `3pl-sent` so it never goes
 * twice. Run nightly by a scheduler (Railway cron -> `npm run batch`) or on
 * demand via POST /batch/run.
 *
 * BATCH_MODE=per-order drops one file per order instead of one combined file
 * (switch here if Bill's import wants individual files).
 */
const { normalizeOrder, fetchOrdersForBatch, tagOrderSent } = require('./shopify');
const { buildBatchChunks, buildCustomerOrder } = require('./xml/buildOrder');
const { putXml, DRY_RUN } = require('./sftp');

/** YYYYMMDDHHMMSS from a Date (passed in for testable/stable output). */
function stamp(now) {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** YYYYMMDD from a Date — Bill's batch file names are date-based, not timestamped. */
function dateStamp(now) {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Combined batch file name (Bill 2026-08-13): `BW_<date>-cust order.xml`.
 *  When the 200-order cap splits into parts, later files get `-2`, `-3`, ... */
function batchFilename(now, part) {
  const base = `BW_${dateStamp(now)}-cust order`;
  return part > 1 ? `${base}-${part}.xml` : `${base}.xml`;
}

/**
 * @param {object} opts
 *   now         base date (default new Date())
 *   windowHours how far back to look for orders (default 25 — a day + overlap)
 *   rawOrders   inject raw Shopify orders instead of fetching (for tests/dry-run)
 *   tag         tag orders sent after a live drop (default true; never in dry-run)
 * @returns {Promise<object>} summary
 */
async function runBatch({ now = new Date(), windowHours = 25, rawOrders = null, tag = true } = {}) {
  const raws = rawOrders || (await fetchOrdersForBatch({ windowHours, now }));
  const orders = raws.map((o) => normalizeOrder(o, now));
  const mode = process.env.BATCH_MODE === 'per-order' ? 'per-order' : 'combined';
  const summary = { count: orders.length, mode, dryRun: DRY_RUN, files: [], warnings: [], tagged: [], tagErrors: [] };

  if (!orders.length) {
    console.log('[batch] no new paid orders in the window — nothing to send');
    return summary;
  }

  if (mode === 'combined') {
    // Cap at 200 orders per XML (Bill 2026-08-13) — split into date-named parts.
    const chunks = buildBatchChunks(orders);
    chunks.forEach((c) => summary.warnings.push(...c.warnings));
    for (let i = 0; i < chunks.length; i++) {
      const filename = batchFilename(now, i + 1);
      const put = await putXml(filename, chunks[i].xml);
      summary.files.push({ filename, count: chunks[i].count, ...put });
    }
  } else {
    for (const order of orders) {
      const { xml, warnings } = buildCustomerOrder(order);
      warnings.forEach((w) => summary.warnings.push(`#${order.number}: ${w}`));
      const filename = `BW_${order.number}_${stamp(now)}.xml`;
      const put = await putXml(filename, xml);
      summary.files.push({ filename, number: order.number, ...put });
    }
  }

  // Persistent idempotency: tag each order in Shopify so the next batch skips it.
  // Only after a real drop — dry-run leaves orders untagged so you can re-test.
  if (tag && !DRY_RUN) {
    for (const o of raws) {
      try {
        await tagOrderSent(o.id);
        summary.tagged.push(o.id);
      } catch (e) {
        console.error(`[batch] tag failed for order ${o.id}: ${e.message}`);
        summary.tagErrors.push({ id: o.id, error: e.message });
      }
    }
  }

  console.log(
    `[batch] ${mode} — ${summary.count} order(s), ${summary.files.length} file(s), ` +
      `${summary.warnings.length} warning(s)${DRY_RUN ? ' [DRY_RUN]' : ''}`
  );
  return summary;
}

module.exports = { runBatch, stamp };
