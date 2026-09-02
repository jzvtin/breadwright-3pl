/**
 * src/cli/cron-hit.js
 * Lightweight cron trigger for the nightly-prepare / nightly-send Railway
 * services. They hold NO state and NO secrets — they just POST to the
 * always-on main service, which owns the real out/.nightly/<date>/ files,
 * SFTP creds, and mailer. Set TARGET_URL to the full endpoint incl. ?key=.
 *   TARGET_URL=https://api.breadwright.com/nightly/prepare?key=<PEEK_KEY>
 *   TARGET_URL=https://api.breadwright.com/nightly/send?key=<PEEK_KEY>
 */
const url = process.env.TARGET_URL;
if (!url) {
  console.error('[cron-hit] missing TARGET_URL env var');
  process.exit(1);
}

fetch(url, { method: 'POST' })
  .then(async (r) => {
    const body = await r.text();
    console.log(`[cron-hit] ${r.status} ${url.split('?')[0]}\n${body}`);
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error('[cron-hit] FAILED:', e.message);
    process.exit(1);
  });
