/**
 * src/sftp.js
 * Thin wrapper over ssh2-sftp-client. All paths/creds come from env — nothing
 * hardcoded. When DRY_RUN=1, uploads are written to out/ instead of the server
 * so you can exercise the full flow without touching the 3PL.
 *
 * Requires: npm i ssh2-sftp-client
 */
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.DRY_RUN === '1';

function cfg() {
  return {
    host: process.env.DATEX_SFTP_HOST || 'datexsftp.footprintwms.com',
    port: Number(process.env.DATEX_SFTP_PORT || 22),
    username: process.env.DATEX_SFTP_USER || 'datexsftp.icssftpadmin',
    password: process.env.DATEX_SFTP_PASSWORD, // set in env — NEVER commit
    // CONFIRM these directory names with Bill:
    outboundDir: process.env.DATEX_SFTP_OUTBOUND_DIR || '/inbound', // where WE drop orders/ASNs
    returnDir: process.env.DATEX_SFTP_RETURN_DIR || '/outbound', //    where WMS drops acks/tracking
    archiveDir: process.env.DATEX_SFTP_ARCHIVE_DIR || '/outbound/processed',
  };
}

/** Upload an XML string as `filename` into the outbound dir (or out/ in dry-run). */
async function putXml(filename, xml) {
  const c = cfg();
  if (DRY_RUN) {
    const p = path.join(__dirname, '../out', filename);
    fs.writeFileSync(p, xml, 'utf8');
    console.log(`[DRY_RUN] would SFTP-put ${filename} -> ${c.outboundDir}. Wrote ${p}`);
    return { dryRun: true, path: p };
  }
  const Client = require('ssh2-sftp-client');
  const sftp = new Client();
  await sftp.connect({ host: c.host, port: c.port, username: c.username, password: c.password });
  try {
    const remote = `${c.outboundDir}/${filename}`;
    await sftp.put(Buffer.from(xml, 'utf8'), remote);
    console.log(`[sftp] put ${remote}`);
    return { remote };
  } finally {
    await sftp.end();
  }
}

/** List + fetch return files from the WMS return dir. Returns [{ name, content }]. */
async function fetchReturnFiles() {
  const c = cfg();
  if (DRY_RUN) {
    console.log('[DRY_RUN] skipping return-file fetch');
    return [];
  }
  const Client = require('ssh2-sftp-client');
  const sftp = new Client();
  await sftp.connect({ host: c.host, port: c.port, username: c.username, password: c.password });
  try {
    const list = await sftp.list(c.returnDir);
    const xmls = list.filter((f) => f.type === '-' && /\.xml$/i.test(f.name));
    const out = [];
    for (const f of xmls) {
      const buf = await sftp.get(`${c.returnDir}/${f.name}`);
      out.push({ name: f.name, content: buf.toString('utf8') });
    }
    return out;
  } finally {
    await sftp.end();
  }
}

/** Move a processed return file into the archive dir. */
async function archiveReturnFile(name) {
  const c = cfg();
  if (DRY_RUN) return;
  const Client = require('ssh2-sftp-client');
  const sftp = new Client();
  await sftp.connect({ host: c.host, port: c.port, username: c.username, password: c.password });
  try {
    await sftp.rename(`${c.returnDir}/${name}`, `${c.archiveDir}/${name}`);
  } finally {
    await sftp.end();
  }
}

/**
 * READ-ONLY peek helpers for the status dashboard. These ALWAYS connect to the
 * real SFTP (independent of DRY_RUN) since they only list/read — never write.
 */
async function peekList(dirs) {
  const c = cfg();
  const Client = require('ssh2-sftp-client');
  const sftp = new Client();
  await sftp.connect({ host: c.host, port: c.port, username: c.username, password: c.password });
  try {
    const out = {};
    for (const d of dirs) {
      try {
        const r = await sftp.list(d);
        out[d] = r.map((f) => ({ name: f.name, type: f.type, size: f.size, mtime: f.modifyTime }));
      } catch (e) {
        out[d] = { error: e.message.split(' - ')[0] };
      }
    }
    return out;
  } finally {
    await sftp.end();
  }
}

/**
 * LIVE test-drop. ALWAYS writes to the real SFTP outbound dir (/Test),
 * independent of DRY_RUN — this is the "send Bill a real order" button. Lists
 * the folder before + after so the caller can prove the file landed.
 * Returns { remote, dir, before, after }.
 */
async function sendToTest(filename, xml) {
  const c = cfg();
  const Client = require('ssh2-sftp-client');
  const sftp = new Client();
  await sftp.connect({ host: c.host, port: c.port, username: c.username, password: c.password });
  try {
    const dir = c.outboundDir;
    const snap = async () =>
      (await sftp.list(dir)).map((f) => ({ name: f.name, type: f.type, size: f.size, mtime: f.modifyTime }));
    const before = await snap();
    const remote = `${dir}/${filename}`;
    await sftp.put(Buffer.from(xml, 'utf8'), remote);
    const after = await snap();
    return { remote, dir, before, after };
  } finally {
    await sftp.end();
  }
}

async function peekFile(remotePath) {
  const c = cfg();
  const Client = require('ssh2-sftp-client');
  const sftp = new Client();
  await sftp.connect({ host: c.host, port: c.port, username: c.username, password: c.password });
  try {
    return (await sftp.get(remotePath)).toString('utf8');
  } finally {
    await sftp.end();
  }
}

module.exports = { putXml, fetchReturnFiles, archiveReturnFile, peekList, peekFile, sendToTest, DRY_RUN };
