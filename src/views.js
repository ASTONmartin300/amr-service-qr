// Every page a resident or staff member sees. Plain server-rendered HTML with
// inline CSS -- no build step, no framework, no external requests. That last
// part matters: elevator cell signal is marginal, so the page must be one
// round trip with nothing else to fetch.
'use strict';

const { t, label } = require('./i18n');
const { parseServices, get: getService } = require('./services');
const { escapeHtml, formatTime } = require('./mailer');
const { config } = require('./config');

const BASE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
       background:#faf9f7;color:#14161a;-webkit-font-smoothing:antialiased;
       min-height:100vh;display:flex;flex-direction:column}
  .wrap{flex:1;display:flex;flex-direction:column;justify-content:center;
        align-items:center;text-align:center;padding:40px 26px;max-width:520px;
        margin:0 auto;width:100%}
  .brand{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:#8a8f98;
         margin-bottom:46px}
  h1{font-size:27px;font-weight:500;line-height:1.28;letter-spacing:-.01em;margin-bottom:14px}
  .location{font-size:20px;font-weight:400;color:#14161a;margin-bottom:38px}
  p{font-size:16px;line-height:1.6;color:#4a4f57}
  .note{font-size:13px;color:#8a8f98;margin-top:30px;line-height:1.6}
  .mark{width:54px;height:54px;border-radius:50%;display:flex;align-items:center;
        justify-content:center;margin:0 auto 26px;font-size:26px}
  .mark.ok{background:#e8f0e9;color:#2f6b3c}
  .mark.info{background:#eceef1;color:#5a6068}
  .mark.warn{background:#f6ece6;color:#8a5230}
  footer{padding:22px;text-align:center}
  footer a{font-size:13px;color:#8a8f98;text-decoration:none;border-bottom:1px solid #d8dade;
           padding-bottom:2px}
`;

function page({ lang, title, body, footer }) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#faf9f7">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main class="wrap">${body}</main>
${footer || ''}
</body>
</html>`;
}

function langFooter(strings, path) {
  const sep = path.includes('?') ? '&' : '?';
  return `<footer><a href="${escapeHtml(path)}${sep}lang=${strings.switchTo}">${strings.switchLang}</a></footer>`;
}

// The one screen with a decision on it. Everything else is a dead end by
// design -- once a request is filed the resident has nothing left to do.
//
// A location offering a single service still shows a single button, so the
// elevator experience is unchanged from one tap. Where more than one applies,
// the resident picks, and that choice is what routes the request -- which is
// the whole reason it is worth asking.
function confirmPage(location, lang) {
  const s = t(lang);
  const name = label(location, lang);
  const offered = parseServices(location.services);
  const multi = offered.length > 1;

  const buttons = offered.map((key, i) => {
    const svc = getService(key);
    const text = multi ? svc[lang === 'es' ? 'es' : 'en'].button : s.confirmButton;
    // The first option is the most likely one and gets the solid treatment;
    // the rest are outlined so the screen reads as a choice, not a wall.
    const primary = i === 0;
    return `
      <form method="POST" action="/r/${location.token}?lang=${s.htmlLang}" style="width:100%">
        <input type="hidden" name="type" value="${escapeHtml(key)}">
        <button type="submit" style="
          appearance:none;cursor:pointer;font-family:inherit;width:100%;
          font-size:${multi ? '15px' : '16px'};letter-spacing:.09em;text-transform:uppercase;
          padding:${multi ? '18px 20px' : '21px 46px'};border-radius:2px;
          -webkit-tap-highlight-color:transparent;
          background:${primary ? '#14161a' : 'transparent'};
          color:${primary ? '#fff' : '#14161a'};
          border:${primary ? '0' : '1px solid #c9ccd2'}">
          ${escapeHtml(text)}
        </button>
      </form>`;
  }).join('');

  return page({
    lang: s.htmlLang,
    title: `${s.confirmTitle} - ${s.brand}`,
    footer: langFooter(s, `/r/${location.token}`),
    body: `
      <div class="brand">${escapeHtml(s.brand)}</div>
      <h1>${escapeHtml(s.confirmTitle)}</h1>
      <div class="location">${escapeHtml(name)}</div>
      ${multi ? `<p class="note" style="margin:-24px 0 22px">${escapeHtml(s.confirmPrompt)}</p>` : ''}
      <div style="display:flex;flex-direction:column;gap:11px;width:100%;max-width:300px">
        ${buttons}
      </div>
      <p class="note">${escapeHtml(s.confirmNote)}</p>`,
  });
}

function thanksPage(lang) {
  const s = t(lang);
  return page({
    lang: s.htmlLang,
    title: `${s.thanksTitle} - ${s.brand}`,
    body: `
      <div class="brand">${escapeHtml(s.brand)}</div>
      <div class="mark ok">&#10003;</div>
      <h1>${escapeHtml(s.thanksTitle)}</h1>
      <p>${escapeHtml(s.thanksBody)}</p>
      <p class="note">${escapeHtml(s.thanksNote)}</p>`,
  });
}

// Shown when the location already has an open request, or was reported inside
// the suppression window. Reads as gratitude, not rejection -- the resident did
// nothing wrong and should not feel dismissed.
function alreadyPage(lang) {
  const s = t(lang);
  return page({
    lang: s.htmlLang,
    title: `${s.alreadyTitle} - ${s.brand}`,
    body: `
      <div class="brand">${escapeHtml(s.brand)}</div>
      <div class="mark ok">&#10003;</div>
      <h1>${escapeHtml(s.alreadyTitle)}</h1>
      <p>${escapeHtml(s.alreadyBody)}</p>
      <p class="note">${escapeHtml(s.alreadyNote)}</p>`,
  });
}

function messagePage(lang, titleKey, bodyKey, tone) {
  const s = t(lang);
  return page({
    lang: s.htmlLang,
    title: `${s[titleKey]} - ${s.brand}`,
    body: `
      <div class="brand">${escapeHtml(s.brand)}</div>
      <div class="mark ${tone || 'info'}">${tone === 'warn' ? '&#33;' : '&#8212;'}</div>
      <h1>${escapeHtml(s[titleKey])}</h1>
      <p>${escapeHtml(s[bodyKey])}</p>`,
  });
}

// --- staff-facing ----------------------------------------------------------

function servicedPage({ locationName, minutes, alreadyClosed, invalid }) {
  let mark = '<div class="mark ok">&#10003;</div>';
  let title = 'Marked serviced';
  let body = `${escapeHtml(locationName)} closed in ${minutes} minutes.`;

  if (alreadyClosed) {
    mark = '<div class="mark info">&#8212;</div>';
    title = 'Already closed';
    body = 'This request was already marked serviced. No change was made.';
  }
  if (invalid) {
    mark = '<div class="mark warn">&#33;</div>';
    title = 'Link not valid';
    body = 'This link has expired or is not recognized. Open the dashboard to close the request.';
  }

  return page({
    lang: 'en',
    title: `${title} - Service Requests`,
    body: `
      <div class="brand">Aston Martin Residences</div>
      ${mark}
      <h1>${escapeHtml(title)}</h1>
      <p>${body}</p>`,
  });
}

function loginPage(error) {
  return page({
    lang: 'en',
    title: 'Service Requests',
    body: `
      <div class="brand">Aston Martin Residences</div>
      <h1>Service Requests</h1>
      <form method="POST" action="/ops/login" style="margin-top:30px;width:100%;max-width:320px">
        <input type="password" name="passcode" placeholder="Passcode" autofocus
          autocomplete="current-password" style="
          width:100%;padding:15px 17px;font-size:16px;font-family:inherit;
          border:1px solid #d8dade;border-radius:2px;background:#fff;margin-bottom:12px">
        <button type="submit" style="
          width:100%;appearance:none;border:0;cursor:pointer;background:#14161a;color:#fff;
          font-size:14px;letter-spacing:.11em;text-transform:uppercase;padding:16px;
          border-radius:2px;font-family:inherit">Sign in</button>
      </form>
      ${error ? `<p class="note" style="color:#8a5230">${escapeHtml(error)}</p>` : ''}`,
  });
}

// Colour separates the three request kinds at a glance, which is the whole
// point of showing type in a queue someone scans rather than reads.
function typePill(type) {
  const svc = getService(type);
  const tone = { cleaning: 'clean', repair: 'fix', supply: 'stock' }[svc.key] || 'clean';
  return `<span class="tp ${tone}">${escapeHtml(svc.en.short)}</span>`;
}

function fmtMinutes(v) {
  if (v === null || v === undefined) return '&mdash;';
  const n = Math.round(v);
  if (n < 60) return `${n} min`;
  return `${Math.floor(n / 60)}h ${n % 60}m`;
}

function elapsedMinutes(iso) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

// The artifact that goes to the Board. Open queue first (operational), then
// 30-day performance (evidential).
function dashboardPage({ open, stats, recent, days }) {
  const completed = recent.filter((r) => r.completed_at);
  const times = completed.map((r) =>
    (new Date(r.completed_at) - new Date(r.created_at)) / 60000);
  const median = times.length
    ? times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)]
    : null;

  const css = `
    body{background:#faf9f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
         color:#14161a;margin:0;padding:0}
    .page{max-width:1000px;margin:0 auto;padding:38px 24px 70px}
    .top{display:flex;justify-content:space-between;align-items:baseline;
         flex-wrap:wrap;gap:12px;margin-bottom:34px}
    .brand{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:#8a8f98}
    h1{font-size:25px;font-weight:500;margin:6px 0 0}
    h2{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#8a8f98;
       margin:40px 0 14px;font-weight:600}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
    .card{background:#fff;border:1px solid #e8e9ec;border-radius:3px;padding:18px 20px}
    .card .n{font-size:27px;font-weight:500;letter-spacing:-.02em}
    .card .k{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:#8a8f98;margin-top:5px}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e8e9ec;
          border-radius:3px;overflow:hidden;font-size:14px}
    th{text-align:left;font-size:10px;letter-spacing:.13em;text-transform:uppercase;
       color:#8a8f98;padding:12px 16px;border-bottom:1px solid #e8e9ec;font-weight:600}
    td{padding:13px 16px;border-bottom:1px solid #f2f3f5}
    tr:last-child td{border-bottom:0}
    .pill{display:inline-block;font-size:11px;letter-spacing:.06em;padding:3px 9px;
          border-radius:11px;text-transform:uppercase}
    .pill.open{background:#f6ece6;color:#8a5230}
    .pill.done{background:#e8f0e9;color:#2f6b3c}
    .pill.off{background:#eceef1;color:#6a707a}
    .btn{display:inline-block;background:#14161a;color:#fff;text-decoration:none;
         font-size:11px;letter-spacing:.09em;text-transform:uppercase;padding:8px 15px;
         border-radius:2px;border:0;cursor:pointer;font-family:inherit}
    .muted{color:#8a8f98}
    .empty{background:#fff;border:1px solid #e8e9ec;border-radius:3px;padding:30px;
           text-align:center;color:#8a8f98;font-size:14px}
    .scroll{overflow-x:auto}
    a.plain{color:#14161a}
    .tp{display:inline-block;font-size:9.5px;letter-spacing:.06em;padding:3px 8px;
        border-radius:2px;text-transform:uppercase;font-weight:600;white-space:nowrap}
    .tp.clean{background:#eceef1;color:#5a6068}
    .tp.fix{background:#f2e9f4;color:#6b4478}
    .tp.stock{background:#eaf1ec;color:#2f6b4f}
  `;

  const openRows = open.length ? `
    <div class="scroll"><table>
      <tr><th>Location</th><th>Type</th><th>Reported</th><th>Waiting</th><th>Re-scans</th><th></th></tr>
      ${open.map((r) => `
        <tr>
          <td><strong>${escapeHtml(r.label_en)}</strong></td>
          <td>${typePill(r.type)}</td>
          <td>${escapeHtml(formatTime(r.created_at))}</td>
          <td>${fmtMinutes(elapsedMinutes(r.created_at))}</td>
          <td class="muted">${r.suppressed_scans || 0}</td>
          <td style="text-align:right">
            <form method="POST" action="/ops/complete" style="margin:0">
              <input type="hidden" name="id" value="${r.id}">
              <button class="btn" type="submit">Mark serviced</button>
            </form>
          </td>
        </tr>`).join('')}
    </table></div>`
    : '<div class="empty">No open requests.</div>';

  const statRows = stats.map((s) => `
    <tr>
      <td><strong>${escapeHtml(s.label_en)}</strong>
        ${s.active ? '' : ' <span class="pill off">Inactive</span>'}</td>
      <td>${s.total || 0}</td>
      <td>${s.open_count || 0}</td>
      <td class="muted">${s.repeat_scans || 0}</td>
      <td>${fmtMinutes(s.avg_minutes)}</td>
      <td>${fmtMinutes(s.max_minutes)}</td>
    </tr>`).join('');

  const recentRows = recent.length ? recent.slice(0, 60).map((r) => `
    <tr>
      <td><strong>${escapeHtml(r.label_en)}</strong></td>
      <td>${typePill(r.type)}</td>
      <td>${escapeHtml(formatTime(r.created_at))}</td>
      <td>${r.status === 'open'
        ? '<span class="pill open">Open</span>'
        : '<span class="pill done">Completed</span>'}</td>
      <td>${r.completed_at ? escapeHtml(formatTime(r.completed_at)) : '<span class="muted">&mdash;</span>'}</td>
      <td>${r.completed_at
        ? fmtMinutes((new Date(r.completed_at) - new Date(r.created_at)) / 60000)
        : '<span class="muted">&mdash;</span>'}</td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="muted" style="text-align:center;padding:26px">No requests yet.</td></tr>';

  const banner = config.dryRun
    ? `<div style="background:#f6ece6;color:#8a5230;padding:11px 16px;border-radius:3px;
         font-size:13px;margin-bottom:22px">
         <strong>DRY_RUN is on.</strong> Requests are recorded but no email is sent to housekeeping.
       </div>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Service Requests - Aston Martin Residences</title>
<style>${css}</style></head>
<body><div class="page">
  <div class="top">
    <div><div class="brand">Aston Martin Residences</div><h1>Service Requests</h1></div>
    <div class="muted" style="font-size:13px">
      Last ${days} days
      &middot; <a class="plain" href="/ops/locations">Locations &amp; signs</a>
      &middot; <a class="plain" href="/ops/logout">Sign out</a>
    </div>
  </div>

  ${banner}

  <div class="cards">
    <div class="card"><div class="n">${open.length}</div><div class="k">Open now</div></div>
    <div class="card"><div class="n">${recent.length}</div><div class="k">Requests / ${days}d</div></div>
    <div class="card"><div class="n">${fmtMinutes(median)}</div><div class="k">Median response</div></div>
    <div class="card"><div class="n">${completed.length}</div><div class="k">Completed</div></div>
  </div>

  <h2>Open</h2>
  ${openRows}

  <h2>By location &middot; last ${days} days</h2>
  <div class="scroll"><table>
    <tr><th>Location</th><th>Requests</th><th>Open</th><th>Re-scans</th>
        <th>Avg response</th><th>Worst</th></tr>
    ${statRows}
  </table></div>

  <h2>History</h2>
  <div class="scroll"><table>
    <tr><th>Location</th><th>Type</th><th>Requested</th><th>Status</th><th>Completed</th><th>Response</th></tr>
    ${recentRows}
  </table></div>

  <p class="muted" style="font-size:12px;margin-top:30px;line-height:1.7">
    Re-scans count residents who scanned a location that was already reported &mdash;
    a rising number is a signal that response time is slipping.<br>
    No resident identity is recorded with any request.
  </p>
</div></body></html>`;
}

// Every sign in the building, its scan URL, and its kill switch. On a hosted
// deployment there is no shell to run scripts/locations.js in, so this page is
// how a code gets deactivated when it turns up in a resident WhatsApp group.
function locationsPage(locations, flash = {}) {
  const css = `
    body{background:#faf9f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
         color:#14161a;margin:0}
    .page{max-width:1000px;margin:0 auto;padding:38px 24px 70px}
    .brand{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:#8a8f98}
    h1{font-size:25px;font-weight:500;margin:6px 0 0}
    h2{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#8a8f98;
       margin:38px 0 14px;font-weight:600}
    .top{display:flex;justify-content:space-between;align-items:baseline;
         flex-wrap:wrap;gap:12px;margin-bottom:14px}
    .nav{font-size:13px;color:#8a8f98}
    .nav a{color:#14161a;margin-left:14px}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e8e9ec;
          border-radius:3px;overflow:hidden;font-size:14px}
    th{text-align:left;font-size:10px;letter-spacing:.13em;text-transform:uppercase;
       color:#8a8f98;padding:12px 16px;border-bottom:1px solid #e8e9ec;font-weight:600}
    td{padding:11px 16px;border-bottom:1px solid #f2f3f5}
    tr:last-child td{border-bottom:0}
    code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;color:#5a6068}
    .pill{display:inline-block;font-size:11px;letter-spacing:.06em;padding:3px 9px;
          border-radius:11px;text-transform:uppercase}
    .pill.on{background:#e8f0e9;color:#2f6b3c}
    .pill.off{background:#f6ece6;color:#8a5230}
    .btn{background:none;border:1px solid #d8dade;color:#5a6068;font-size:11px;
         letter-spacing:.08em;text-transform:uppercase;padding:6px 12px;border-radius:2px;
         cursor:pointer;font-family:inherit}
    .btn:hover{border-color:#14161a;color:#14161a}
    .muted{color:#8a8f98}
    .scroll{overflow-x:auto}
    .print{display:inline-block;background:#14161a;color:#fff;text-decoration:none;
           font-size:11px;letter-spacing:.09em;text-transform:uppercase;padding:10px 18px;
           border-radius:2px;margin-right:8px;border:0;cursor:pointer;font-family:inherit}
    .flash{padding:12px 16px;border-radius:3px;font-size:13.5px;margin-bottom:18px;
           line-height:1.6}
    .flash.good{background:#e8f0e9;color:#245536;border-left:2px solid #2f6b3c}
    .flash.bad{background:#f6ece6;color:#7a4526;border-left:2px solid #8a5230}
    .flash code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
    .adder{margin-bottom:20px;border:1px solid #e8e9ec;background:#fff;border-radius:3px}
    .adder summary{cursor:pointer;padding:13px 16px;font-size:12px;letter-spacing:.1em;
                   text-transform:uppercase;color:#5a6068;font-weight:600}
    .adder[open] summary{border-bottom:1px solid #f2f3f5}
    .addform{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));
             gap:16px;padding:18px 16px}
    .addform label{display:block;font-size:10px;letter-spacing:.13em;text-transform:uppercase;
                   color:#8a8f98;margin-bottom:6px;font-weight:600}
    .addform input,.addform select{width:100%;padding:10px 12px;font-size:14px;
             font-family:inherit;border:1px solid #d8dade;border-radius:2px;background:#fff}
    .addform .fine{display:block;font-size:11.5px;color:#8a8f98;margin-top:5px}
    .addsubmit{display:flex;align-items:flex-end}
    .addsubmit .print{margin:0}
  `;

  const rows = (list) => list.map((l) => `
    <tr>
      <td><strong>${escapeHtml(l.label_en)}</strong>
          <div class="muted" style="font-size:12px">${escapeHtml(l.label_es)}</div></td>
      <td><code>/r/${escapeHtml(l.token)}</code></td>
      <td class="muted">${escapeHtml(l.department)}</td>
      <td>${l.active ? '<span class="pill on">Active</span>' : '<span class="pill off">Off</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <a class="btn" href="/ops/signs?token=${escapeHtml(l.token)}" target="_blank"
           style="text-decoration:none;margin-right:6px">Print</a>
        <form method="POST" action="/ops/locations/toggle" style="margin:0;display:inline">
          <input type="hidden" name="token" value="${escapeHtml(l.token)}">
          <button class="btn" type="submit">${l.active ? 'Deactivate' : 'Activate'}</button>
        </form>
      </td>
    </tr>`).join('');

  const elevators = locations.filter((l) => l.kind === 'elevator');
  const amenities = locations.filter((l) => l.kind !== 'elevator');
  const added = flash.added ? locations.find((l) => l.token === flash.added) : null;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Locations - Aston Martin Residences</title>
<style>${css}</style></head>
<body><div class="page">
  <div class="top">
    <div><div class="brand">Aston Martin Residences</div><h1>Locations</h1></div>
    <div class="nav"><a href="/ops">Requests</a><a href="/ops/logout">Sign out</a></div>
  </div>

  <p class="muted" style="font-size:13px;margin-bottom:22px">
    ${locations.length} signs &middot; ${elevators.length} elevators, ${amenities.length} amenities.
    Deactivating leaves the printed sign on the wall but stops it dispatching.
  </p>

  ${flash.error ? `<div class="flash bad">${escapeHtml(flash.error)}</div>` : ''}
  ${added ? `
    <div class="flash good">
      <strong>${escapeHtml(added.label_en)}</strong> added.
      Its code is <code>/r/${escapeHtml(added.token)}</code> &mdash;
      <a href="/ops/signs?token=${escapeHtml(added.token)}" target="_blank">print just this sign</a>
      and put it up. Nothing else changed; every sign already on a wall keeps working.
    </div>` : ''}

  <details class="adder"${flash.error ? ' open' : ''}>
    <summary>Add a location</summary>
    <form method="POST" action="/ops/locations/add" class="addform">
      <div>
        <label for="a-en">Name</label>
        <input id="a-en" name="label_en" required maxlength="80"
               placeholder="Lobby Restroom" autocomplete="off">
      </div>
      <div>
        <label for="a-es">Name in Spanish</label>
        <input id="a-es" name="label_es" maxlength="80"
               placeholder="Ba&ntilde;o del Vest&iacute;bulo" autocomplete="off">
        <span class="fine">Optional. Blank uses the English name.</span>
      </div>
      <div>
        <label for="a-kind">Type</label>
        <select id="a-kind" name="kind">
          <option value="amenity">Amenity or room</option>
          <option value="elevator">Elevator</option>
        </select>
        <span class="fine">Sets the wording on the printed sign.</span>
      </div>
      <div>
        <label for="a-mail">Notify</label>
        <input id="a-mail" name="notify_email" maxlength="120" type="email"
               placeholder="engineering@300miamicondo.com" autocomplete="off">
        <span class="fine">Optional. Blank sends to housekeeping.</span>
      </div>
      <div class="addsubmit"><button class="print" type="submit">Add location</button></div>
    </form>
  </details>

  <p>
    <a class="print" href="/ops/signs" target="_blank">Print all signs</a>
    <a class="print" href="/ops/signs?kind=elevator" target="_blank">Elevators only</a>
    <a class="print" href="/ops/signs?kind=amenity" target="_blank">Amenities only</a>
  </p>

  <h2>Elevators</h2>
  <div class="scroll"><table>
    <tr><th>Location</th><th>Scan URL</th><th>Department</th><th>Status</th><th></th></tr>
    ${rows(elevators)}
  </table></div>

  <h2>Amenities</h2>
  <div class="scroll"><table>
    <tr><th>Location</th><th>Scan URL</th><th>Department</th><th>Status</th><th></th></tr>
    ${rows(amenities)}
  </table></div>

  <h2>Backup</h2>
  <p class="muted" style="font-size:13px;line-height:1.7;margin-bottom:14px">
    The scan URLs above are printed into 35 physical signs and exist nowhere else.
    If this database is lost without a copy, every sign in the building has to be
    reprinted and reinstalled. Download a copy monthly and keep it somewhere that
    is not this server.
  </p>
  <p><a class="print" href="/ops/backup">Download database</a></p>
</div></body></html>`;
}

module.exports = {
  confirmPage,
  thanksPage,
  alreadyPage,
  messagePage,
  servicedPage,
  loginPage,
  dashboardPage,
  locationsPage,
};
