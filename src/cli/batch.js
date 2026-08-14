/**
 * src/cli/batch.js
 * LIVE end-of-day batch. Run by the nightly scheduler (Railway cron -> `npm run
 * batch`). Pulls today's paid orders from Shopify, drops the Datex batch XML via
 * SFTP (or out/ when DRY_RUN=1), and tags each order sent. Exits non-zero on
 * failure so the scheduler surfaces it.
 */
const { runBatch } = require('../batch');

runBatch()
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[batch] FAILED:', err);
    process.exit(1);
  });
