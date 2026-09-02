/**
 * src/cli/nightly-prepare.js
 * ~9pm cron: build tonight's batch XML, stage it, email Sam an approve/reject
 * link. Never touches SFTP. Run by Railway cron -> `npm run nightly:prepare`.
 */
const { prepareNightly } = require('../nightlyApproval');

prepareNightly()
  .then((meta) => {
    console.log(JSON.stringify(meta, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[nightly-prepare] FAILED:', err);
    process.exit(1);
  });
