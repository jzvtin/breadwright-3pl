/**
 * src/confirmations.js
 * Parse Ice Cube's Datex "completed shipments" report (BWCompletedShipments_*.xml)
 * and turn it into a plain-English summary — so nobody has to eyeball 16 material
 * rows to see that an order shipped its 6 loaves + packaging correctly.
 *
 * The file is a flat list of <table1_Details_Group .../> rows, one per material
 * line shipped: shipmentLookupCode (order #), materialLookupCode (SKU),
 * QuantityShipped, orderVendorReference (service tier), shippeddate.
 */
const cfg = require('../config/materials');
const CASE = cfg.CASE_PACK || {};

const BREAD = new Set(['BW_CSD', 'BW_MGP', 'BW_CRANPEC', 'BW_PFRAN', 'BW_DB2PK', 'BW_SEEDSD']);
const COLD = new Set(['BW_DRYICE', 'BW_GELPK']);
const PACK = new Set(['BW_BOX14', 'BW_GCF1', 'BW_GCF2', 'BW_BFP']);
const INSERT = new Set(['BW_INFOSHEET', 'BW_WB']);

function desc(code) { return (CASE[code] && CASE[code].desc) || code; }

/** Flat rows from the report XML. */
function parseCompletedShipments(xml) {
  const rows = [];
  const re = /<table1_Details_Group\b([^>]*?)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    const a = /([\w:]+)="([^"]*)"/g;
    let x;
    while ((x = a.exec(m[1]))) attrs[x[1]] = x[2];
    if (attrs.shipmentLookupCode) {
      rows.push({
        order: attrs.shipmentLookupCode,
        service: attrs.orderVendorReference || '',
        shippedDate: attrs.shippeddate || '',
        code: attrs.materialLookupCode || '',
        qty: Math.round(parseFloat(attrs.QuantityShipped || '0')) || 0,
      });
    }
  }
  return rows;
}

/** Group by order, split bread / cold chain / packaging / inserts. */
function summarize(rows) {
  const byOrder = {};
  for (const r of rows) {
    (byOrder[r.order] = byOrder[r.order] || { service: r.service, shippedDate: r.shippedDate, lines: [] }).lines.push(r);
  }
  const orders = Object.keys(byOrder).sort((a, b) => Number(a) - Number(b)).map((o) => {
    const g = byOrder[o];
    const cat = (set) => g.lines.filter((l) => set.has(l.code));
    const bread = cat(BREAD), cold = cat(COLD), pack = cat(PACK), ins = cat(INSERT);
    const other = g.lines.filter((l) => !BREAD.has(l.code) && !COLD.has(l.code) && !PACK.has(l.code) && !INSERT.has(l.code));
    const fmt = (ls) => ls.map((l) => `${l.qty}× ${desc(l.code)}`).join(', ');
    return {
      order: o,
      service: g.service,
      shippedDate: g.shippedDate,
      breadCount: bread.reduce((s, l) => s + l.qty, 0),
      bread: fmt(bread),
      cold: fmt(cold),
      packaging: fmt(pack),
      inserts: fmt(ins),
      unknown: fmt(other),
      totalLines: g.lines.length,
    };
  });
  return { orders, count: orders.length };
}

/** Human "layman's terms" report. */
function plainText(summary, opts = {}) {
  const title = opts.fileDate ? `Ice Cube shipped ${summary.count} order(s) — ${opts.fileDate}` : `Ice Cube confirmed ${summary.count} order(s) shipped`;
  const out = [`${title}:`, ''];
  for (const o of summary.orders) {
    const when = (o.shippedDate || '').replace('T', ' ').slice(0, 16);
    out.push(`Order ${o.order}  —  ${o.service}  —  shipped ${when}`);
    out.push(`   ${o.breadCount} loaves: ${o.bread || '(none)'}`);
    if (o.cold) out.push(`   cold chain: ${o.cold}`);
    if (o.packaging) out.push(`   packaging: ${o.packaging}`);
    if (o.inserts) out.push(`   inserts: ${o.inserts}`);
    if (o.unknown) out.push(`   ⚠ unrecognized: ${o.unknown}`);
    out.push('');
  }
  return out.join('\n');
}

module.exports = { parseCompletedShipments, summarize, plainText };
