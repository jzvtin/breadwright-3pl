/**
 * src/packslip.js
 * ---------------------------------------------------------------------------
 * Printable per-order PACKING LIST (HTML) with the ORDER NUMBER rendered as a
 * small Code 128 barcode (Bill 2026-08-13: "order number packing list — 128,
 * barcode it small"). Pickers scan the barcode to pull the order in Datex.
 *
 * Self-contained: the barcode is emitted as inline SVG via a from-scratch
 * Code 128B encoder — NO external font, library, or network dependency, so the
 * slip prints identically on the warehouse console and anywhere else.
 * ---------------------------------------------------------------------------
 */

const cfg = require('../config/materials');

// Code 128 bar/space width patterns for symbol values 0..106. Each string is a
// run-length sequence starting with a BAR, alternating bar/space. Value 106 is
// STOP (includes the trailing termination bar). Standard, immutable table.
const CODE128 = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112'
).trim().split(/\s+/);

const START_B = 104;
const STOP = 106;

/**
 * Encode an ASCII string in Code 128B to an array of module widths (bars/spaces
 * alternating, first is a bar). Only printable ASCII 32..126 is supported.
 */
function encode128B(text) {
  const values = [START_B];
  let checksum = START_B;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 126) throw new Error(`Code128B: unsupported char "${text[i]}" (0x${code.toString(16)})`);
    const v = code - 32;
    values.push(v);
    checksum += v * (i + 1);
  }
  values.push(checksum % 103); // check symbol
  values.push(STOP);
  const modules = [];
  for (const v of values) for (const ch of CODE128[v]) modules.push(parseInt(ch, 10));
  return modules;
}

/**
 * Inline SVG of the Code 128B barcode for `text`.
 * @param {object} o { moduleWidth?, height?, quiet? } — moduleWidth small by default.
 */
function barcodeSvg(text, o = {}) {
  const mw = o.moduleWidth || 1.4; // "small" per Bill
  const h = o.height || 34;
  const quiet = o.quiet != null ? o.quiet : 10; // quiet-zone modules each side
  const modules = encode128B(text);
  const totalModules = modules.reduce((s, m) => s + m, 0) + quiet * 2;
  const width = totalModules * mw;
  let x = quiet * mw;
  const rects = [];
  let bar = true; // first module is a bar
  for (const m of modules) {
    const w = m * mw;
    if (bar) rects.push(`<rect x="${round(x)}" y="0" width="${round(w)}" height="${h}"/>`);
    x += w;
    bar = !bar;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${h}" ` +
    `viewBox="0 0 ${round(width)} ${h}" role="img" aria-label="barcode ${esc(text)}">` +
    `<rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`
  );
}

function round(n) { return Math.round(n * 100) / 100; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Descriptions for the auto-injected PACKAGING codes (not in CASE_PACK).
const PACK_DESC = {
  BW_BOX14: 'Cardboard shipping box 14x14x14',
  BW_GCF1: 'Green Cell Foam set 1 (Top/Long Side/Bottom)',
  BW_GCF2: 'Green Cell Foam set 2 (Side/Long Side/Side)',
  BW_GELPK: 'Gel pack',
  BW_INFOSHEET: 'Info sheet insert',
};

/** MMDDYY — the header date (e.g. 081326). */
function fmtStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getFullYear() % 100)}`;
}

/**
 * Full pick rows for one order = product loaves (pack.contents) PLUS the
 * auto-injected packaging materials (box / Green Cell Foam / gel packs). Dry
 * ice and ride-along inserts are NOT inventoried rows. Sorted QTY-desc so the
 * heaviest picks lead. @returns {{code,desc,qty}[]}
 */
function packRows(pack) {
  const rows = (pack.contents || []).map((c) => ({ code: c.code, desc: c.desc, qty: c.qty }));
  if (!pack.materialsOnly) {
    for (const p of (cfg.PACKAGING || [])) {
      rows.push({ code: p.code, desc: (cfg.CASE_PACK[p.code] || {}).desc || PACK_DESC[p.code] || p.code, qty: p.qty });
    }
  }
  return rows.map((r, i) => ({ ...r, i })).sort((a, b) => b.qty - a.qty || a.i - b.i);
}

/**
 * Printable PACK LIST for ONE order, sized to a 4×6 shipping label (Bill
 * 2026-08-13: "pack list on a 4x6 to stick on the inner flap of the box").
 * Header: brand + date/time, ORDER # + a small Code 128 barcode of the same.
 * Body: a checkbox pick table (Item# / Description / Loc / Qty) covering every
 * inventoried item, a TOTAL, and a QC sign-off block at the bottom.
 *
 * @param {object} pack   the pack object from buildOrderNode
 * @param {object} order  normalized order (for order number); optional
 * @param {object} opts   { now?: Date }  header timestamp (default new Date())
 */
function packSlipHtml(pack, order = {}, opts = {}) {
  const num = String(pack.orderNumber);
  const now = opts.now || new Date();
  const rows = packRows(pack);
  const total = rows.reduce((s, r) => s + r.qty, 0);
  const body = rows
    .map(
      (r) =>
        `<tr><td class="ck"><span class="box"></span></td>` +
        `<td class="item">${esc(r.code)}</td>` +
        `<td class="desc">${esc(r.desc)}</td>` +
        `<td class="loc">NA</td>` +
        `<td class="qty">${r.qty}</td></tr>`
    )
    .join('');
  // 4×6 label: portrait, 4in × 6in. Compact so a full box of items fits.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pack List ${esc(num)}</title>
<style>
  @page{size:4in 6in;margin:0}
  *{box-sizing:border-box} html,body{margin:0;padding:0} body{background:#eee}
  .label{width:4in;height:6in;background:#fff;margin:0 auto;padding:.16in .18in;
    font:10px/1.25 -apple-system,Segoe UI,Arial,sans-serif;color:#000;display:flex;flex-direction:column;overflow:hidden}
  .top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
  .brand{font-weight:800;font-size:12px;letter-spacing:2px}
  .stamp{font-size:8px;color:#333;text-align:right;padding-top:2px}
  .ord{display:flex;justify-content:space-between;align-items:flex-end;gap:8px;margin-top:6px}
  .ord .lbl{font-size:8px;letter-spacing:1px;color:#555} .ord .num{font-size:22px;font-weight:800;letter-spacing:.5px;line-height:1}
  .bc{text-align:right} .bc svg{display:block;margin-left:auto;height:30px} .bc .n{font:8px ui-monospace,Menlo,monospace;letter-spacing:1px;text-align:center;margin-top:1px}
  .bar{background:#000;color:#fff;display:flex;justify-content:space-between;align-items:center;
    padding:4px 7px;margin:8px 0 0;font-weight:800;letter-spacing:1px;font-size:11px}
  .bar small{font-weight:700;font-size:7.5px;letter-spacing:.5px;color:#fff}
  table{width:100%;border-collapse:collapse}
  thead th{text-align:left;font-size:7px;text-transform:uppercase;color:#777;letter-spacing:.5px;padding:4px 3px 2px;border-bottom:1px solid #000}
  th.qty,td.qty{text-align:right} th.loc,td.loc{text-align:center}
  tbody td{padding:4px 3px;border-bottom:.5px solid #e2e2e2;vertical-align:middle}
  td.ck{width:16px} .box{display:inline-block;width:9px;height:9px;border:1px solid #333}
  td.item{font-weight:800;font-size:9.5px;white-space:nowrap}
  td.desc{font-size:8.5px;color:#222;line-height:1.15}
  td.loc{font-size:8px;color:#999;font-style:italic;width:26px}
  td.qty{font-weight:800;font-size:13px;width:26px}
  .total{text-align:right;font-weight:800;font-size:11px;letter-spacing:.5px;padding:6px 3px 0}
  .qc{margin-top:auto;border:1px solid #000;border-radius:3px;padding:7px 8px}
  .qc h4{margin:0;font-size:9px;letter-spacing:1px} .qc p{margin:2px 0 12px;font-size:7.5px;color:#666}
  .qc .lines{display:flex;gap:10px} .qc .f{flex:1} .qc .f .ln{border-bottom:1px solid #000;height:1px}
  .qc .f span{font-size:7px;color:#666;letter-spacing:.5px;display:block;margin-top:2px}
  @media screen{body{padding:20px}.label{box-shadow:0 2px 10px rgba(0,0,0,.15)}}
</style></head><body>
<div class="label">
  <div class="top">
    <div class="brand">BREADWRIGHT</div>
    <div class="stamp">${esc(fmtStamp(now))}</div>
  </div>
  <div class="ord">
    <div><div class="lbl">ORDER #</div><div class="num">${esc(num)}</div></div>
    <div class="bc">${barcodeSvg(num, { moduleWidth: 1.2, height: 30, quiet: 6 })}<div class="n">${esc(num)}</div></div>
  </div>
  <div class="bar">PACK LIST<small>VERIFY EVERY LINE BEFORE SEALING</small></div>
  <table>
    <thead><tr><th class="ck"></th><th>Item #</th><th>Description</th><th class="loc">Loc</th><th class="qty">Qty</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  <div class="total">TOTAL ITEMS REQUIRED:&nbsp; ${total}</div>
  <div class="qc">
    <h4>QC SIGN-OFF</h4>
    <p>I verified all items and quantities above.</p>
    <div class="lines">
      <div class="f"><div class="ln"></div><span>QC INITIALS</span></div>
      <div class="f"><div class="ln"></div><span>DATE</span></div>
    </div>
  </div>
</div></body></html>`;
}

module.exports = { encode128B, barcodeSvg, packSlipHtml };
