/**
 * src/cli/nightly-send.js
 * ~5am cron: send tonight's batch ONLY IF Sam approved it. Otherwise holds
 * and alerts. Run by Railway cron -> `npm run nightly:send`.
 */
const { sendNightly } = require('../nightlyApproval');

sendNightly()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[nightly-send] FAILED:', err);
    process.exit(1);
  });
