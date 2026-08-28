/**
 * src/dashboard.js
 * The operator console, served DIRECTLY by the Railway app at
 * https://api.breadwright.com/ — this replaces the retired PHP console that
 * used to live at dynaradigital.com/breadwright (2026-08-14).
 *
 * Password-gated (DASH_PW, default 'Bready'). Same-origin `?action=` calls are
 * proxied server-side to the key-gated /peek routes, injecting PEEK_KEY so it
 * NEVER reaches the browser — exactly what the old PHP proxy did.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const DASH_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'dashboard-login.html'), 'utf8');

const PW = process.env.DASH_PW || 'Bready';          // admin (full console)
const ICE_PW = process.env.ICECUBE_PW || 'icecube';  // Ice Cube (queue-only)
const PEEK_KEY = process.env.PEEK_KEY || '';
const COOKIE = 'bw_dash';
// Role-scoped session tokens (each role hashes its own pw, so an Ice Cube cookie
// can never authenticate as admin and vice-versa).
const tokenFor = (role, pw) => crypto.createHash('sha256').update(`${role}|${pw}|${PEEK_KEY}`).digest('hex');
const ADMIN_TOKEN = () => tokenFor('admin', PW);
const ICE_TOKEN = () => tokenFor('icecube', ICE_PW);

// The actions the Ice Cube (queue-only) role may call. Everything else — test
// drops, XML generate, confirmation tools, folder browser — is admin-only.
const ICE_ACTIONS = new Set(['stats', 'shipqueue', 'demolabel', 'packslip', 'buylabel']);

function eqHex(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
// Returns 'admin' | 'icecube' | null from the session cookie.
function roleOf(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)bw_dash=([a-f0-9]+)/);
  if (!m) return null;
  if (eqHex(m[1], ADMIN_TOKEN())) return 'admin';
  if (eqHex(m[1], ICE_TOKEN())) return 'icecube';
  return null;
}
function isAuthed(req) { return !!roleOf(req); }
function loginPage(err) {
  return LOGIN_HTML.replace('<!--ERR-->', err ? `<div class="err">${err}</div>` : '');
}

// In-process proxy to the app's own key-gated /peek routes. Keeps PEEK_KEY
// server-side, identical to the old PHP curl proxy.
async function proxy(method, peekPath, body) {
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const sep = peekPath.includes('?') ? '&' : '?';
  const url = `${base}${peekPath}${sep}key=${encodeURIComponent(PEEK_KEY)}`;
  const opt = { method };
  if (method === 'POST') {
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  }
  const r = await fetch(url, opt);
  const text = await r.text();
  return { code: r.status, text, ctype: r.headers.get('content-type') || 'application/json' };
}

// Handle the same-origin ?action= calls the console JS makes. Returns true if
// the request was an action (and has been answered), false otherwise.
async function handleAction(req, res) {
  const action = req.query.action;
  if (!action) return false;
  const role = roleOf(req);
  if (!role) { res.status(401).json({ error: 'unauthorized' }); return true; }
  // Ice Cube role is fenced to the queue actions — refuse everything else so a
  // hand-crafted request can't reach the admin tools.
  if (role === 'icecube' && !ICE_ACTIONS.has(action)) { res.status(403).json({ error: 'forbidden' }); return true; }
  try {
    let out;
    if (action === 'list') out = await proxy('GET', '/peek');
    else if (action === 'file') out = await proxy('GET', `/peek/file?path=${encodeURIComponent(req.query.path || '')}`);
    else if (action === 'fixtures') out = await proxy('GET', '/peek/test-fixtures');
    else if (action === 'send') out = await proxy('POST', `/peek/send-test?fixture=${encodeURIComponent(req.query.fixture || 'founders-box')}`);
    else if (action === 'generate') out = await proxy('POST', `/peek/generate${req.query.send === '1' ? '?send=1' : ''}`, req.body || {});
    else if (action === 'confirm') out = await proxy('POST', '/peek/ship-confirm', req.body || {});
    else if (action === 'rate') out = await proxy('POST', '/peek/priority-rate', req.body || {});
    else if (action === 'confirmfile') out = await proxy('POST', '/peek/confirm-file', req.body || {});
    else if (action === 'confirmdoc') out = await proxy('POST', '/peek/confirm-doc', req.body || {});
    else if (action === 'stats') out = await proxy('GET', `/peek/stats?days=${encodeURIComponent(req.query.days || '30')}`);
    else if (action === 'shipqueue') out = await proxy('GET', '/peek/ship-queue');
    else if (action === 'demolabel') out = await proxy('GET', `/peek/demo-label?number=${encodeURIComponent(req.query.number || '')}${req.query.reprint ? '&reprint=1' : ''}`);
    else if (action === 'buylabel') out = await proxy('POST', `/peek/buy-label?number=${encodeURIComponent(req.query.number || '')}`, req.body || {});
    else if (action === 'packslip') out = await proxy('GET', `/peek/packslip?number=${encodeURIComponent(req.query.number || '')}`);
    else { res.status(400).json({ error: 'bad action' }); return true; }
    res.status(out.code).type(out.ctype).send(out.text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
  return true;
}

function registerDashboard(app) {
  // urlencoded parser for the login form; it no-ops on JSON action bodies
  // (those were already parsed by the global express.json middleware).
  const urlenc = express.urlencoded({ extended: false });

  app.post('/', urlenc, async (req, res) => {
    // Same-origin action proxy (JSON body) takes precedence over the login form.
    if (req.query.action) { await handleAction(req, res); return; }
    const pw = req.body && typeof req.body.pw === 'string' ? req.body.pw : '';
    let token = null;
    if (eqHex(pw.padEnd(64).slice(0, 64), PW.padEnd(64).slice(0, 64))) token = ADMIN_TOKEN();
    else if (eqHex(pw.padEnd(64).slice(0, 64), ICE_PW.padEnd(64).slice(0, 64))) token = ICE_TOKEN();
    if (token) {
      res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
      return res.redirect('/');
    }
    res.status(401).type('html').send(loginPage('Incorrect password.'));
  });

  app.get('/', async (req, res) => {
    if (req.query.logout !== undefined) {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
      return res.redirect('/');
    }
    if (await handleAction(req, res)) return;
    const role = roleOf(req);
    if (!role) return res.type('html').send(loginPage(''));
    // Inject the role so CSS can hide admin-only sections and JS can slim the KPIs.
    const html = DASH_HTML.replace('<body>', `<body class="role-${role}"><script>window.BW_ROLE=${JSON.stringify(role)}</script>`);
    res.type('html').send(html);
  });
}

module.exports = { registerDashboard };
