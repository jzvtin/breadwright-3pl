/**
 * sftp-check.js — local SFTP folder watcher + file viewer for the Breadwright
 * 3PL test. A browser can't speak SFTP, so this tiny Node app does the SFTP and
 * serves a live HTML dashboard at http://localhost:4599. Reads creds from .env.
 *
 *   node sftp-check.js      (or: npm run check)
 *
 * - Lists /Test, /Test/Archive, /Test/Error live (auto-refresh).
 * - Click any file to VIEW its XML in a panel; download it too.
 *   Confirms whether a dropped order imported (-> Archive as .usedxml) or was
 *   rejected (-> Error), without emailing Bill.
 */
const fs = require('fs');
const http = require('http');
const { URL } = require('url');
const Client = require('ssh2-sftp-client');

for (const line of fs.readFileSync(__dirname + '/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const CREDS = {
  host: process.env.DATEX_SFTP_HOST,
  port: Number(process.env.DATEX_SFTP_PORT || 22),
  username: process.env.DATEX_SFTP_USER,
  password: process.env.DATEX_SFTP_PASSWORD,
};
const FOLDERS = ['/Test', '/Test/Archive', '/Test/Error'];
const ALLOWED_PREFIXES = ['/Test', '/Datex']; // only read within these
const PORT = 4599;

async function withSftp(fn) {
  const sftp = new Client();
  await sftp.connect(CREDS);
  try { return await fn(sftp); } finally { await sftp.end(); }
}

async function listAll() {
  return withSftp(async (sftp) => {
    const out = {};
    for (const p of FOLDERS) {
      try {
        const r = await sftp.list(p);
        out[p] = r.map((f) => ({ name: f.name, type: f.type, size: f.size, mtime: f.modifyTime }));
      } catch (e) {
        out[p] = { error: e.message.split(' - ')[0] };
      }
    }
    return out;
  });
}

function pathAllowed(p) {
  if (!p || p.includes('..')) return false;
  return ALLOWED_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'));
}

async function getFile(p) {
  return withSftp(async (sftp) => (await sftp.get(p)).toString('utf8'));
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Breadwright 3PL — SFTP check</title>
<style>
 *{box-sizing:border-box}
 body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#f7f6f2;color:#2a2a2a}
 header{background:#3a2a1a;color:#f3e9d8;padding:14px 20px;display:flex;justify-content:space-between;align-items:center}
 header b{font-size:16px}
 .wrap{max-width:1000px;margin:20px auto;padding:0 16px}
 .card{background:#fff;border:1px solid #e3ddd0;border-radius:10px;margin:0 0 16px;overflow:hidden}
 .card h2{margin:0;padding:10px 14px;font-size:13px;background:#efe9dc;border-bottom:1px solid #e3ddd0;font-family:ui-monospace,monospace}
 table{width:100%;border-collapse:collapse}
 td,th{text-align:left;padding:7px 14px;border-bottom:1px solid #f0ece3;font-size:13px}
 th{color:#8a7f6a;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
 .file a{font-family:ui-monospace,monospace;color:#6b4a1f;text-decoration:none;cursor:pointer}
 .file a:hover{text-decoration:underline}
 .empty{padding:12px 14px;color:#9a9a9a;font-style:italic}
 .err{padding:12px 14px;color:#b23b3b}
 .badge{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;font-weight:600;margin-left:6px}
 .wait{background:#f5ecc8;color:#8a6d12}
 .muted{color:#9a9a9a}
 button{background:#7a5c34;color:#fff;border:0;padding:7px 14px;border-radius:7px;cursor:pointer;font:inherit}
 button.ghost{background:#efe9dc;color:#3a2a1a}
 #status{font-size:12px}
 /* viewer */
 #overlay{position:fixed;inset:0;background:rgba(30,22,12,.55);display:none;align-items:center;justify-content:center;padding:24px}
 #viewer{background:#fff;border-radius:12px;max-width:900px;width:100%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
 #viewer .vh{padding:12px 16px;background:#efe9dc;border-bottom:1px solid #e3ddd0;display:flex;justify-content:space-between;align-items:center;gap:12px}
 #viewer .vh .fn{font-family:ui-monospace,monospace;font-size:13px;word-break:break-all}
 #viewer pre{margin:0;padding:16px;overflow:auto;font:12px/1.5 ui-monospace,monospace;white-space:pre;background:#fbfaf6;flex:1}
 .vactions{display:flex;gap:8px;flex-shrink:0}
</style></head><body>
<header><b>🍞 Breadwright 3PL — /Test watcher</b><span id="status">loading…</span></header>
<div class="wrap">
 <p><button onclick="load()">Refresh now</button> <span class="muted">auto-refreshes every 15s. Click a file to view it. A dropped order moves to <b>Archive</b> (imported OK, renamed .usedxml) or <b>Error</b> (rejected).</span></p>
 <div id="out"></div>
</div>
<div id="overlay" onclick="if(event.target.id==='overlay')closeV()">
 <div id="viewer">
  <div class="vh">
   <span class="fn" id="vname"></span>
   <span class="vactions">
    <a id="vdl"><button class="ghost">Download</button></a>
    <button class="ghost" onclick="closeV()">Close</button>
   </span>
  </div>
  <pre id="vbody">loading…</pre>
 </div>
</div>
<script>
function fmt(t){if(!t)return '';return new Date(t).toLocaleString();}
function esc(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function row(folder,f){
 const isTest=/BW_.*TEST/i.test(f.name);
 const full=folder.replace(/\\/$/,'')+'/'+f.name;
 const name=f.type==='d'
   ? '<span class="muted">'+f.name+'/</span>'
   : '<a onclick="view(\\''+full.replace(/'/g,"\\\\'")+'\\')">'+f.name+'</a>'+(isTest?'<span class="badge wait">your test file</span>':'');
 return '<tr'+(isTest?' style="background:#fff8e6"':'')+'><td class="file">'+name+'</td><td>'+(f.type==='d'?'dir':(f.size+' B'))+'</td><td class="muted">'+fmt(f.mtime)+'</td></tr>';
}
async function load(){
 document.getElementById('status').textContent='checking…';
 try{
  const data=await (await fetch('/api/list')).json();
  let html='';
  for(const [folder,items] of Object.entries(data)){
   html+='<div class="card"><h2>'+folder+'</h2>';
   if(items&&items.error){html+='<div class="err">'+items.error+'</div>';}
   else if(!items||!items.length){html+='<div class="empty">(empty)</div>';}
   else{html+='<table><tr><th>name</th><th>size</th><th>modified</th></tr>'+items.map(f=>row(folder,f)).join('')+'</table>';}
   html+='</div>';
  }
  document.getElementById('out').innerHTML=html;
  document.getElementById('status').textContent='updated '+new Date().toLocaleTimeString();
 }catch(e){document.getElementById('status').textContent='error: '+e.message;}
}
async function view(path){
 document.getElementById('overlay').style.display='flex';
 document.getElementById('vname').textContent=path;
 document.getElementById('vbody').textContent='loading…';
 document.getElementById('vdl').setAttribute('href','/api/file?download=1&path='+encodeURIComponent(path));
 document.getElementById('vdl').setAttribute('download',path.split('/').pop());
 try{
  const r=await fetch('/api/file?path='+encodeURIComponent(path));
  const t=await r.text();
  document.getElementById('vbody').textContent=r.ok?t:('ERROR: '+t);
 }catch(e){document.getElementById('vbody').textContent='ERROR: '+e.message;}
}
function closeV(){document.getElementById('overlay').style.display='none';}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeV();});
load();setInterval(load,15000);
</script></body></html>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/list') {
    try {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await listAll()));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (u.pathname === '/api/file') {
    const p = u.searchParams.get('path');
    if (!pathAllowed(p)) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('path not allowed'); return; }
    try {
      const content = await getFile(p);
      const headers = { 'content-type': 'text/plain; charset=utf-8' };
      if (u.searchParams.get('download')) headers['content-disposition'] = `attachment; filename="${p.split('/').pop()}"`;
      res.writeHead(200, headers);
      res.end(content);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(e.message.split(' - ')[0]);
    }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
}).listen(PORT, () => {
  console.log(`\n  SFTP checker running →  http://localhost:${PORT}\n  (Ctrl+C to stop)\n`);
});
