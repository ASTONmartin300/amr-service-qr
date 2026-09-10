// HTTP server. Plain node:http -- no framework, so there is one dependency
// tree to trust and nothing to keep patched on a machine that sits in an
// office running unattended.
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { config, assertReady } = require('./config');
const store = require('./db');
const { sign, verify, randomToken } = require('./tokens');
const { pickLang, label } = require('./i18n');
const { sendDispatch } = require('./mailer');
const views = require('./views');
const signsheet = require('./signsheet');
const { autoSeed } = require('./bootstrap');
const { parseServices, parseSupplies } = require('./services');
const scheduler = require('./scheduler');

// --- small helpers ---------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function readForm(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 8192) req.destroy(); // nothing here needs a large body
    });
    req.on('end', () => resolve(new URLSearchParams(raw)));
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSignedIn(req) {
  return verify(parseCookies(req).ops_session || '') === 'ops';
}

// Ephemeral, in-memory, never written to disk and never associated with a
// request row. This exists purely so the POST endpoint cannot be scripted; it
// is not a record of who scanned what, and it evaporates on restart.
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
}, 60000).unref();

// --- routes ----------------------------------------------------------------

// GET /r/:token -- the confirm screen.
function handleScan(req, res, token, url) {
  const lang = pickLang(req, url.searchParams.get('lang'));
  const location = store.getLocationByToken(token);

  if (!location) return send(res, 404, views.messagePage(lang, 'unknownTitle', 'unknownBody', 'warn'));
  if (!location.active) return send(res, 200, views.messagePage(lang, 'inactiveTitle', 'inactiveBody'));

  return send(res, 200, views.confirmPage(location, lang));
}

// POST /r/:token -- files the request.
//
// Renders the result directly rather than POST-redirect-GET. A redirect costs
// another round trip, and in an elevator with one bar that is the difference
// between a thank-you screen and a spinner.
async function handleRequest(req, res, token, url, ip) {
  const lang = pickLang(req, url.searchParams.get('lang'));
  const location = store.getLocationByToken(token);

  if (!location) return send(res, 404, views.messagePage(lang, 'unknownTitle', 'unknownBody', 'warn'));
  if (!location.active) return send(res, 200, views.messagePage(lang, 'inactiveTitle', 'inactiveBody'));

  if (rateLimited(`post:${ip}`, 12, 60000)) {
    return send(res, 429, views.messagePage(lang, 'errorTitle', 'errorBody', 'warn'));
  }

  try {
    const form = await readForm(req);
    const offered = parseServices(location.services);
    const asked = form.get('type');

    // Only honour a type this location actually offers. A hand-crafted POST
    // must not be able to raise an engineering ticket from a sign that only
    // offers cleaning -- and a location with one service still works when the
    // form sends nothing.
    const type = offered.includes(asked) ? asked : offered[0];

    const blocking = store.suppressingRequest(location.id, type, config.suppressionMinutes);
    if (blocking) {
      store.noteSuppressedScan(blocking.id);
      return send(res, 200, views.alreadyPage(lang));
    }

    // Resupply asks one more question -- what is out -- when the location has
    // a list to offer. Still one tap, still nothing typed, and it turns "bring
    // something" into "bring towels". Anything not on the list falls back to
    // the picker rather than being stored, so the detail column only ever
    // holds values we put there.
    let detail = null;
    const items = parseSupplies(location.supplies);
    if (type === 'supply' && items.length) {
      const picked = form.get('detail');
      if (!picked) return send(res, 200, views.supplyPickerPage(location, items, lang));
      const match = items.find((i) => i.key === picked);
      detail = match ? match.en : (picked === 'other' ? 'Other' : null);
      if (!detail) return send(res, 200, views.supplyPickerPage(location, items, lang));
    }

    const request = store.createRequest(location.id, type, detail);

    // Thank the resident immediately; deliver the email after. SMTP to M365
    // can take seconds, and nobody should hold a phone up in an elevator
    // waiting for Microsoft.
    send(res, 200, views.thanksPage(lang));

    const status = await sendDispatch(request, location);
    store.setEmailStatus(request.id, status);
    console.log(`[request] #${request.id} ${type} ${location.label_en} -> ${status}`);
  } catch (err) {
    console.error('[request] failed:', err);
    if (!res.headersSent) send(res, 500, views.messagePage(lang, 'errorTitle', 'errorBody', 'warn'));
  }
}

// GET /done/:signed -- the MARK SERVICED link from the dispatch email.
function handleDone(req, res, signed) {
  const payload = verify(signed);
  if (!payload || !payload.startsWith('req:')) {
    return send(res, 400, views.servicedPage({ invalid: true }));
  }

  // "req:<id>" from older emails, "req:<id>:<dept>" from current ones. The
  // department is inside the signature, so it cannot be edited by the tapper.
  const [, idPart, deptPart] = payload.split(':');
  const closedBy = ['housekeeping', 'engineering'].includes(deptPart) ? deptPart : 'email';

  const request = store.getRequest(Number(idPart));
  if (!request) return send(res, 404, views.servicedPage({ invalid: true }));

  const location = store.getLocationById(request.location_id);
  const closed = store.completeRequest(request.id, closedBy);

  if (!closed) {
    return send(res, 200, views.servicedPage({
      locationName: location.label_en, alreadyClosed: true,
    }));
  }

  const fresh = store.getRequest(request.id);
  const minutes = Math.max(1, Math.round(
    (new Date(fresh.completed_at) - new Date(fresh.created_at)) / 60000));
  console.log(`[complete] #${request.id} ${location.label_en} in ${minutes} min`);

  return send(res, 200, views.servicedPage({ locationName: location.label_en, minutes }));
}

// --- ops -------------------------------------------------------------------

function handleOps(req, res) {
  if (!isSignedIn(req)) return send(res, 200, views.loginPage());
  const days = 30;
  return send(res, 200, views.dashboardPage({
    open: store.openRequests(),
    stats: store.locationStats(days),
    recent: store.recentRequests(days),
    days,
  }));
}

async function handleOpsLogin(req, res, ip) {
  if (rateLimited(`login:${ip}`, 8, 300000)) {
    return send(res, 429, views.loginPage('Too many attempts. Wait a few minutes.'));
  }

  const form = await readForm(req);
  const given = Buffer.from(form.get('passcode') || '');
  const expected = Buffer.from(config.opsPasscode);

  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) return send(res, 401, views.loginPage('Incorrect passcode.'));

  const cookie = `ops_session=${sign('ops', 12 * 3600000)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
    + (config.publicBaseUrl.startsWith('https') ? '; Secure' : '');
  return send(res, 302, '', { Location: '/ops', 'Set-Cookie': cookie });
}

// GET /ops/locations -- every sign, its URL, and its kill switch. This is the
// browser equivalent of scripts/locations.js, and on a hosted deployment it is
// the only practical way to reach it.
function handleOpsLocations(req, res, url) {
  if (!isSignedIn(req)) return send(res, 200, views.loginPage());
  return send(res, 200, views.locationsPage(store.listLocations(), {
    error: url.searchParams.get('err'),
    added: url.searchParams.get('added'),
  }));
}

async function handleOpsToggle(req, res) {
  if (!isSignedIn(req)) return send(res, 403, views.loginPage('Session expired.'));
  const form = await readForm(req);
  const token = form.get('token');
  const location = store.getLocationByToken(token || '');
  if (location) {
    store.setLocationActive(token, !location.active);
    console.log(`[locations] ${location.label_en} -> ${location.active ? 'INACTIVE' : 'ACTIVE'}`);
  }
  return send(res, 302, '', { Location: '/ops/locations' });
}

// POST /ops/locations/add -- create a new sign without a redeploy.
//
// Adding a location is an operational act, not a code change: a restroom gets a
// sign, an amenity opens, a cab comes back from modernization. Requiring an
// upload and reinstall for that would mean it either does not happen, or
// happens badly. Existing tokens are never touched, so every sign already on a
// wall keeps working.
async function handleOpsAdd(req, res) {
  if (!isSignedIn(req)) return send(res, 403, views.loginPage('Session expired.'));

  const form = await readForm(req);
  const labelEn = (form.get('label_en') || '').trim().slice(0, 80);
  const labelEs = (form.get('label_es') || '').trim().slice(0, 80);
  const kind = form.get('kind') === 'elevator' ? 'elevator' : 'amenity';
  const notifyEmail = (form.get('notify_email') || '').trim().slice(0, 120);

  const back = (err, token) => send(res, 302, '', {
    Location: '/ops/locations'
      + (err ? `?err=${encodeURIComponent(err)}` : '')
      + (token ? `?added=${encodeURIComponent(token)}` : ''),
  });

  if (!labelEn) return back('Enter a name for the location.');

  const existing = store.listLocations();
  if (existing.some((l) => l.label_en.toLowerCase() === labelEn.toLowerCase())) {
    return back(`"${labelEn}" already exists.`);
  }
  if (notifyEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(notifyEmail)) {
    return back('That does not look like an email address.');
  }

  // New locations sort after everything present, so the print order stays
  // stable and an addition never reshuffles a sheet you already printed.
  const maxOrder = existing.reduce((m, l) => Math.max(m, l.sort_order || 0), 0);

  const location = store.createLocation({
    token: randomToken(),
    labelEn,
    labelEs: labelEs || labelEn,
    kind,
    department: 'housekeeping',
    notifyEmail: notifyEmail || null,
    sortOrder: maxOrder + 10,
  });

  console.log(`[locations] added ${location.label_en} -> /r/${location.token}`);
  return back(null, location.token);
}

// GET /ops/signs -- the print-ready sheet, generated from the live database.
// Removes the need to run a script on the server and retrieve a file from it.
// ?token= prints exactly one, so adding a single location does not mean
// printing 35 pages to find the new one.
async function handleOpsSigns(req, res, url) {
  if (!isSignedIn(req)) return send(res, 200, views.loginPage());

  const kind = url.searchParams.get('kind');
  const only = url.searchParams.get('token');
  let locations = store.listLocations().filter((l) => l.active);
  if (only) locations = locations.filter((l) => l.token === only);
  if (kind) locations = locations.filter((l) => l.kind === kind);

  if (!locations.length) return send(res, 404, views.messagePage('en', 'unknownTitle', 'unknownBody'));

  const hint = config.publicBaseUrl.includes('localhost')
    ? 'WARNING: these codes point at localhost and will not work on a printed sign. '
      + 'Set PUBLIC_BASE_URL to the live address first.'
    : 'Print at 100% scale, or use Save as PDF. Each sign is 5x7in. '
      + 'The grey label at the bottom names the location it belongs in.';

  const html = await signsheet.buildSignSheet(locations, config.publicBaseUrl, { hint });
  return send(res, 200, html);
}

// GET /ops/locations.csv -- the code-to-location map as a spreadsheet.
//
// Two uses: a durable off-server record of which code is in which room (useful
// on its own if a sign is ever damaged and unreadable), and a way to feed the
// real tokens into anything that generates artwork, without hand-copying 44
// strings out of a terminal.
function handleOpsLocationsCsv(req, res) {
  if (!isSignedIn(req)) return send(res, 200, views.loginPage());

  // Excel decides a field is a formula if it starts with = + - @, so anything
  // beginning with one gets a leading apostrophe. None of our labels do today,
  // but a location added later could.
  const cell = (v) => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = [['Location', 'Spanish', 'Type', 'Options', 'Active', 'Code', 'Scan URL']];
  for (const l of store.listLocations()) {
    rows.push([
      l.label_en, l.label_es, l.kind,
      parseServices(l.services).join(' + '),
      l.active ? 'yes' : 'no',
      l.token,
      `${config.publicBaseUrl}/r/${l.token}`,
    ].map(cell));
  }

  // BOM so Excel opens the accented Spanish labels correctly.
  const csv = '﻿' + rows.map((r) => r.join(',')).join('\r\n') + '\r\n';
  const stamp = new Date().toISOString().slice(0, 10);

  console.log(`[export] locations.csv (${rows.length - 1} rows)`);
  return send(res, 200, csv, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="amr-locations-${stamp}.csv"`,
  });
}

// GET /ops/digest -- preview of the weekly digest as it would be emailed, with
// buttons to send it (or the backup) right now. Useful the first week, and
// any time someone wants the numbers before Monday.
function handleOpsDigest(req, res, url) {
  if (!isSignedIn(req)) return send(res, 200, views.loginPage());
  const built = scheduler.buildDigest();
  const sent = url.searchParams.get('sent');
  const notice = sent
    ? `<p style="background:#e8f0e9;color:#245536;padding:10px 14px;border-radius:3px;font-size:13px;margin:0 0 16px">
         ${sent === 'digest' ? 'Digest sent' : 'Backup sent'} to ${escapeHtmlLocal(sent === 'digest' ? config.digest.to : config.backup.to)}${config.dryRun ? ' (DRY_RUN — logged, not delivered)' : ''}.</p>`
    : '';
  const bar = `
    <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px 20px 0">
      <p style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#8a8f98;margin:0 0 10px">
        <a href="/ops" style="color:#14161a;text-decoration:none">&larr; Dashboard</a> &nbsp;&middot;&nbsp; Preview
      </p>
      ${notice}
      <form method="POST" action="/ops/digest/send" style="display:inline;margin:0 8px 0 0">
        <button type="submit" style="background:#14161a;color:#fff;border:0;padding:9px 16px;border-radius:2px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;cursor:pointer">Email digest now</button>
      </form>
      <form method="POST" action="/ops/backup/send" style="display:inline;margin:0">
        <button type="submit" style="background:transparent;color:#14161a;border:1px solid #c9ccd2;padding:9px 16px;border-radius:2px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;cursor:pointer">Email backup now</button>
      </form>
      <p style="font-size:12px;color:#8a8f98;margin:12px 0 24px">
        Scheduled: digest every ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][config.digest.day] || 'Monday'} at ${config.digest.hour}:00 to ${escapeHtmlLocal(config.digest.to || '(unset)')} &middot;
        backup on the ${config.backup.dayOfMonth}${['st','nd','rd'][config.backup.dayOfMonth - 1] || 'th'} to ${escapeHtmlLocal(config.backup.to || '(unset)')}
      </p>
      <hr style="border:0;border-top:1px solid #e8e9ec;margin:0 0 24px">
    </div>
    <div style="max-width:600px;margin:0 auto;padding:0 20px 60px">`;
  return send(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Weekly digest - Aston Martin Residences</title></head><body style="margin:0;background:#faf9f7">
${bar}${built.html}</div></body></html>`);
}

function escapeHtmlLocal(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function handleOpsSendNow(req, res, which) {
  if (!isSignedIn(req)) return send(res, 403, views.loginPage('Session expired.'));
  const status = which === 'digest'
    ? await scheduler.runDigest({ force: true })
    : await scheduler.runBackup({ force: true });
  console.log(`[ops] ${which} sent now -> ${status}`);
  return send(res, 302, '', { Location: `/ops/digest?sent=${which}` });
}

// GET /ops/backup -- downloads a consistent copy of the database.
//
// This is the single most important button in the application. The QR tokens
// exist nowhere else; without a copy of this file, losing the server means
// reprinting and reinstalling all 35 signs. On a hosted platform with no shell,
// this is the only practical way to get one.
//
// VACUUM INTO produces a consistent snapshot without stopping the service --
// copying the .db file directly while WAL is active can yield a torn database.
function handleOpsBackup(req, res) {
  if (!isSignedIn(req)) return send(res, 200, views.loginPage());

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const tmp = path.join(os.tmpdir(), `amr-service-qr-${stamp}-${process.pid}.db`);

  try {
    store.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const body = fs.readFileSync(tmp);
    console.log(`[backup] ${body.length} bytes downloaded`);
    return send(res, 200, body, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="amr-service-qr-${stamp}.db"`,
    });
  } catch (err) {
    console.error('[backup] failed:', err);
    return send(res, 500, views.messagePage('en', 'errorTitle', 'errorBody', 'warn'));
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

async function handleOpsComplete(req, res) {
  if (!isSignedIn(req)) return send(res, 403, views.loginPage('Session expired.'));
  const form = await readForm(req);
  const id = Number(form.get('id'));
  if (Number.isFinite(id)) {
    if (store.completeRequest(id, 'dashboard')) console.log(`[complete] #${id} closed from dashboard`);
  }
  return send(res, 302, '', { Location: '/ops' });
}

// --- router ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  // Behind Cloudflare Tunnel the socket address is always the tunnel. Rate
  // limiting only needs a stable-ish key, and this value is never stored.
  const ip = req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';

  try {
    if (path === '/health') {
      return send(res, 200, JSON.stringify({
        ok: true,
        dryRun: config.dryRun,
        open: store.openRequests().length,
        locations: store.listLocations().length,
      }), { 'Content-Type': 'application/json' });
    }

    const scan = path.match(/^\/r\/([a-z0-9]{4,32})$/i);
    if (scan && method === 'GET') return handleScan(req, res, scan[1], url);
    if (scan && method === 'POST') return handleRequest(req, res, scan[1], url, ip);

    const done = path.match(/^\/done\/(.+)$/);
    if (done && method === 'GET') return handleDone(req, res, done[1]);

    if (path === '/ops' && method === 'GET') return handleOps(req, res);
    if (path === '/ops/locations' && method === 'GET') return handleOpsLocations(req, res, url);
    if (path === '/ops/locations/toggle' && method === 'POST') return handleOpsToggle(req, res);
    if (path === '/ops/locations/add' && method === 'POST') return handleOpsAdd(req, res);
    if (path === '/ops/signs' && method === 'GET') return handleOpsSigns(req, res, url);
    if (path === '/ops/backup' && method === 'GET') return handleOpsBackup(req, res);
    if (path === '/ops/locations.csv' && method === 'GET') return handleOpsLocationsCsv(req, res);
    if (path === '/ops/digest' && method === 'GET') return handleOpsDigest(req, res, url);
    if (path === '/ops/digest/send' && method === 'POST') return handleOpsSendNow(req, res, 'digest');
    if (path === '/ops/backup/send' && method === 'POST') return handleOpsSendNow(req, res, 'backup');
    if (path === '/ops/login' && method === 'POST') return handleOpsLogin(req, res, ip);
    if (path === '/ops/complete' && method === 'POST') return handleOpsComplete(req, res);
    if (path === '/ops/logout') {
      return send(res, 302, '', {
        Location: '/ops',
        'Set-Cookie': 'ops_session=; HttpOnly; Path=/; Max-Age=0',
      });
    }

    // Nothing lives at the root. A bare domain should not advertise what this
    // is or hint that other codes exist.
    return send(res, 404, views.messagePage(pickLang(req), 'unknownTitle', 'unknownBody', 'warn'));
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) {
      send(res, 500, views.messagePage(pickLang(req), 'errorTitle', 'errorBody', 'warn'));
    }
  }
});

const problems = assertReady();
if (problems.length) {
  console.error('\nCannot start -- fix these in .env:\n');
  for (const p of problems) console.error(`  * ${p}\n`);
  process.exit(1);
}

autoSeed({ enabled: config.autoSeed });
scheduler.start();

server.listen(config.port, config.bindHost, () => {
  const locations = store.listLocations();
  const elevators = locations.filter((l) => l.kind === 'elevator').length;
  console.log(`\nAMR Service Requests`);
  console.log(`  listening   ${config.bindHost}:${config.port}`);
  console.log(`  public      ${config.publicBaseUrl}`);
  console.log(`  dashboard   ${config.publicBaseUrl}/ops`);
  console.log(`  database    ${config.dbPath}`);
  console.log(`  locations   ${locations.length}` +
    (locations.length
      ? `  (${elevators} elevators, ${locations.length - elevators} amenities)`
      : '  (run "npm run seed -- --building")'));
  console.log(`  suppression ${config.suppressionMinutes} min`);
  console.log(`  mode        ${config.dryRun ? 'DRY_RUN - no email will be sent' : 'LIVE - housekeeping will be emailed'}\n`);
});

// Service managers (systemd, Docker, IIS via a wrapper) stop a process by
// sending SIGTERM and killing it a few seconds later. Draining in-flight
// requests first means a resident mid-tap during a restart still gets their
// thank-you screen instead of a connection reset.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] draining connections...`);
    server.close(() => {
      try { store.db.close(); } catch { /* already closed */ }
      console.log('[shutdown] clean');
      process.exit(0);
    });
    // Backstop: never hang a service restart waiting on a stuck socket.
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

// An unhandled rejection must never take the service down silently. Log it and
// keep serving -- a failed dispatch email is not a reason to stop accepting
// requests from residents.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

module.exports = server;
