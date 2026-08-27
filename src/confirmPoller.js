/**
 * src/confirmPoller.js
 * Every N minutes, look in the SFTP return folder (DATEX_SFTP_RETURN_DIR, e.g.
 * /Datex/Export/Test) for confirmation files Ice Cube drops
 * (BWCompletedShipments_*.xml). When a NEW one appears: parse it to a
 * plain-English summary (src/confirmations.js) and email the ops team
 * (src/mailer.js) so we know it landed and can check it.
 *
 * Read-only on SFTP (uses peekList/peekFile, independent of DRY_RUN — listing
 * and reading never writes). No file is moved or deleted.
 *
 * De-dupe: an in-memory `seen` set of filenames. On the FIRST scan after boot we
 * seed `seen` with whatever is already there and DON'T email it — so a restart
 * never re-emails history; we only alert on files that appear AFTER go-live.
 * (Trade-off: a file that arrives during the brief boot window is baselined, not
 * emailed. Acceptable; revisit with a persisted marker if it ever bites.)
 */
const { peekList, peekFile } = require('./sftp');
const conf = require('./confirmations');
const { sendMail } = require('./mailer');

const RETURN_DIR = process.env.DATEX_SFTP_RETURN_DIR || '/Datex/Export/Test';
const INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5 * 60 * 1000);

const seen = new Set();
let seeded = false;
let running = false;

function isConfirmationName(name) {
  return /\.xml$/i.test(name) && /completedshipments|confirm/i.test(name);
}

/** List the return dir; tolerate an empty/missing Azure-blob folder -> []. */
async function listReturnFiles() {
  const res = await peekList([RETURN_DIR]);
  const entry = res[RETURN_DIR];
  if (!Array.isArray(entry)) return []; // {error:...} = empty/missing on Azure blob SFTP
  return entry.filter((f) => f.type === '-' && /\.xml$/i.test(f.name));
}

/**
 * One scan. Emails each NEW confirmation file (unless opts.force, which
 * re-processes everything and IS allowed to email — for manual testing).
 * @returns {{ processed:Array, seededCount?:number, baseline?:boolean }}
 */
async function runOnce(opts = {}) {
  if (running && !opts.force) return { processed: [], skipped: 'already running' };
  running = true;
  try {
    const files = await listReturnFiles();

    // First scan after boot: baseline everything, email nothing.
    if (!seeded && !opts.force) {
      files.forEach((f) => seen.add(f.name));
      seeded = true;
      console.log(`[confirmPoller] baseline: ${files.length} existing file(s) marked seen, none emailed`);
      return { processed: [], baseline: true, seededCount: files.length };
    }

    const processed = [];
    for (const f of files) {
      if (seen.has(f.name) && !opts.force) continue;
      if (!isConfirmationName(f.name)) { seen.add(f.name); continue; }
      try {
        const raw = await peekFile(`${RETURN_DIR}/${f.name}`);
        const xml = typeof raw === 'string' ? raw : (raw && raw.content) || '';
        if (!xml.includes('table1_Details_Group')) { seen.add(f.name); continue; }

        const summary = conf.summarize(conf.parseCompletedShipments(xml));
        const fileDate = (f.name.match(/(\d{2,4}-?\d{2}-?\d{2})/) || [])[1] || null;
        const text = conf.plainText(summary, { fileDate });
        const flagged = summary.orders.filter((o) => o.unknown).map((o) => o.order);
        const subject = `Ice Cube shipped ${summary.count} order(s)${flagged.length ? ` — ${flagged.length} to check` : ''} [${f.name}]`;
        const email = await sendMail({ subject, text });

        // Only mark handled once the alert actually SENT. If SMTP is down/unset,
        // leave it unseen so the next scan retries — never silently drop a drop.
        if (email.sent) seen.add(f.name);
        processed.push({ file: f.name, orders: summary.count, flagged, emailed: email.sent, emailNote: email.skipped || email.error || null });
        console.log(`[confirmPoller] ${f.name}: ${summary.count} orders, email ${email.sent ? 'SENT' : '(' + (email.skipped || email.error) + ')'}`);
      } catch (e) {
        console.error(`[confirmPoller] ${f.name} failed:`, e.message);
      }
    }
    return { processed };
  } finally {
    running = false;
  }
}

function start() {
  if (process.env.POLL_CONFIRMATIONS !== '1') {
    console.log('[confirmPoller] disabled (set POLL_CONFIRMATIONS=1 to enable)');
    return;
  }
  console.log(`[confirmPoller] ON — every ${Math.round(INTERVAL_MS / 60000)} min on ${RETURN_DIR}`);
  runOnce().catch((e) => console.error('[confirmPoller] boot scan failed:', e.message));
  setInterval(() => runOnce().catch((e) => console.error('[confirmPoller] scan failed:', e.message)), INTERVAL_MS);
}

module.exports = { start, runOnce, RETURN_DIR };
