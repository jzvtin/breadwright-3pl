/**
 * src/confirmDoc.js
 * Render a branded "Shipment Confirmation" reconciliation document (HTML, ready
 * to print / html2pdf) from a parsed Ice Cube confirmation + per-order Shopify
 * enrichment. Mirrors the Breadwright BW-SC document: summary tiles, a
 * line-by-line shipment table (destination · service · tracking · contents ·
 * Match/Variance), and an acknowledgement footer.
 *
 * Pure rendering — all data (shipped contents, expected contents, destination,
 * tracking, box name) is prepared by the caller (server.js /peek/confirm-doc).
 */

const LOAF_NAMES = {
  BW_CSD: 'Country Sourdough', BW_MGP: 'Multigrain Pullman', BW_CRANPEC: 'Cranberry Pecan',
  BW_PFRAN: 'Pane Francese', BW_DB2PK: 'Demi Baguette 2-pk', BW_SEEDSD: 'Seeded Sourdough',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** "1 Country Sourdough · 2 Pane Francese" from a {code:qty} map. */
function contentsLine(breadMap) {
  return Object.keys(breadMap)
    .sort()
    .map((c) => `${breadMap[c]} ${LOAF_NAMES[c] || c}`)
    .join(' · ');
}

/**
 * @param {object} doc
 * @param {string} doc.ref            e.g. BW-SC-2026-08-26
 * @param {string} doc.fileName       source XML name
 * @param {string} doc.issued         human date, e.g. "26 August 2026"
 * @param {string} doc.orderRange     e.g. "#1034–#1038"
 * @param {string} doc.standardPack   e.g. "1 × BW_BOX14, 2 × BW_GELPK, 1 × BW_GCF1, 1 × BW_GCF2"
 * @param {Array}  doc.rows           [{order, service, dest, tracking, contents, boxName, status, variances}]
 * @returns {string} full HTML document
 */
function renderConfirmDoc(doc) {
  const rows = doc.rows || [];
  const totalUnits = rows.reduce((s, r) => s + (r.unitsShipped || 0), 0);
  const matchedUnits = rows.reduce((s, r) => s + (r.unitsMatched != null ? r.unitsMatched : (r.status === 'Match' ? r.unitsShipped || 0 : 0)), 0);
  const variances = rows.filter((r) => r.status !== 'Match').length;

  const detailRows = rows.map((r) => {
    const contents = r.boxName ? `${esc(r.boxName)} — ${esc(r.contents)}` : esc(r.contents);
    const statusColor = r.status === 'Match' ? '#1f7a3d' : '#a15a1a';
    const varNote = r.variances && r.variances.length ? `<div class="var">${esc(r.variances.join('; '))}</div>` : '';
    return `<tr>
      <td class="mono">${esc(r.order)}</td>
      <td>${esc(r.dest || '—')}</td>
      <td>${esc(r.service || '—')}</td>
      <td class="mono">${esc(r.tracking || '—')}</td>
      <td>${contents}${varNote}</td>
      <td style="color:${statusColor};font-weight:700">${esc(r.status)}</td>
    </tr>`;
  }).join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Shipment Confirmation ${esc(doc.ref)}</title>
<style>
  :root{--ink:#2c2418;--muted:#6b5f47;--line:#e6d8bf;--accent:#7a5c34;--paper:#fffdf8}
  *{box-sizing:border-box}
  body{margin:0;background:#efe7d6;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink)}
  .page{max-width:900px;margin:24px auto;background:var(--paper);padding:40px 44px;box-shadow:0 2px 14px rgba(60,45,20,.12);border-radius:6px}
  h1{font:700 26px/1.1 Georgia,serif;margin:0 0 2px;color:var(--accent)}
  .sub{color:var(--muted);font-size:13px;margin-bottom:22px}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:2px 30px;font-size:12.5px;border-top:2px solid var(--accent);border-bottom:1px solid var(--line);padding:12px 0;margin-bottom:20px}
  .meta div span{color:var(--muted);display:inline-block;min-width:118px;text-transform:uppercase;font-size:11px;letter-spacing:.03em}
  .tiles{display:flex;gap:14px;margin:18px 0 8px;flex-wrap:wrap}
  .tile{flex:1;min-width:120px;border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:#fbf6ec}
  .tile b{display:block;font:700 22px/1 Georgia,serif;color:var(--accent)}
  .tile span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
  .note{font-size:12.5px;color:var(--muted);margin:6px 0 18px}
  h2{font:700 12px/1 sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:6px;margin:24px 0 10px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.03em;padding:6px 8px;border-bottom:1px solid var(--line)}
  td{padding:8px;border-bottom:1px solid #f0e7d4;vertical-align:top}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
  .var{color:#a15a1a;font-size:11.5px;margin-top:3px}
  .ack{font-size:12.5px;color:var(--muted);margin-top:22px;border-top:1px solid var(--line);padding-top:12px}
  .foot{text-align:center;color:var(--muted);font-size:11px;margin-top:26px}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none}}
</style></head><body><div class="page">
  <h1>Shipment Confirmation</h1>
  <div class="sub">Fulfillment batch of ${esc(doc.issued)} · Breadwright · breadwrightbox.com</div>
  <div class="meta">
    <div><span>Prepared for</span> Ice Cube Cold Storage</div>
    <div><span>Document ref</span> ${esc(doc.ref)}</div>
    <div><span>Prepared by</span> Breadwright</div>
    <div><span>Source file</span> ${esc(doc.fileName || '—')}</div>
    <div><span>Issued</span> ${esc(doc.issued)}</div>
    <div><span>Reconciled against</span> Orders ${esc(doc.orderRange)}</div>
  </div>
  <h2>Summary</h2>
  <div class="tiles">
    <div class="tile"><b>${rows.length}</b><span>Shipments completed</span></div>
    <div class="tile"><b>${matchedUnits} / ${totalUnits}</b><span>Loaf units matched to order</span></div>
    <div class="tile"><b>${variances}</b><span>Variances or substitutions</span></div>
  </div>
  <div class="note">Each shipment below has been reconciled line by line against its originating order. Contents,
    quantities and service level are confirmed as shipped.${doc.standardPack ? ` Every box carried the standard pack: ${esc(doc.standardPack)}.` : ''}</div>
  <h2>Shipment detail</h2>
  <table>
    <tr><th>Order</th><th>Destination</th><th>Svc</th><th>Tracking</th><th>Contents shipped</th><th>Status</th></tr>
    ${detailRows}
  </table>
  <div class="ack"><b>Acknowledgement.</b> Please review and confirm the above matches your records. Any correction
    should be returned in writing referencing document ${esc(doc.ref)}.</div>
  <div class="foot">Breadwright · breadwrightbox.com · Document ${esc(doc.ref)} · Page 1 of 1</div>
</div></body></html>`;
}

module.exports = { renderConfirmDoc, contentsLine, LOAF_NAMES };
