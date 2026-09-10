// Timed work: escalating requests that sit open, the weekly digest, and the
// monthly backup. One tick a minute; each job decides for itself whether it is
// due, and records what it has done in the database rather than in memory so a
// restart never repeats an email that already went out.
//
// Nothing here may throw past the tick. A bug in the digest must not stop
// escalations, and neither may stop the service taking requests.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('./config');
const store = require('./db');
const { sendEmail, servicedUrl, formatTime, escapeHtml } = require('./mailer');
const { get: getService } = require('./services');

const TEAM_LABEL = {
  housekeeping: 'Janitorial',
  engineering: 'Maintenance',
  dashboard: 'Dashboard',
  email: 'Email link',
  unrecorded: 'Not recorded',
};

// Wall-clock parts in the building's time zone, which is the only clock the
// "Monday at 7" and "1st of the month" rules make sense in.
function localParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timeZone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return {
    weekday,
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    ymd: `${p.year}-${p.month}-${p.day}`,
  };
}

const fmtMin = (m) => (m == null ? '—' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`);

const shell = (inner) => `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;color:#111">
${inner}
</div>`.trim();

// --- 1. Escalation ---------------------------------------------------------

function buildEscalation(r, level, waitedMin) {
  const svc = getService(r.type);
  const what = r.detail ? ` (${r.detail})` : '';
  const url = servicedUrl(r.id, svc.dept);
  const since = formatTime(r.created_at);
  const nth = level === 1 ? 'Nobody has marked it serviced yet.' : 'It was escalated to the front desk earlier and is still open.';

  const text = [
    `${r.label_en}${what} has been open for ${waitedMin} minutes.`,
    '',
    `Reported: ${since}`,
    `Type: ${svc.en.short}${what}`,
    `Request #${r.id}`,
    '',
    nth,
    'If the work is done, mark it serviced:',
    url,
  ].join('\n');

  const html = shell(`
  <p style="font-size:17px;margin:0 0 6px"><strong>${escapeHtml(r.label_en)}${escapeHtml(what)}</strong>
     has been open for <strong>${waitedMin} minutes</strong>.</p>
  <p style="margin:0 0 18px;color:#666">${escapeHtml(nth)}</p>
  <table style="font-size:15px;border-collapse:collapse;margin:0 0 24px">
    <tr><td style="padding:3px 18px 3px 0;color:#666">Reported</td><td style="padding:3px 0"><strong>${escapeHtml(since)}</strong></td></tr>
    <tr><td style="padding:3px 18px 3px 0;color:#666">Type</td><td style="padding:3px 0"><strong>${escapeHtml(svc.en.short)}${escapeHtml(what)}</strong></td></tr>
    <tr><td style="padding:3px 18px 3px 0;color:#666">Request</td><td style="padding:3px 0">#${r.id}</td></tr>
  </table>
  <a href="${url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;
     padding:14px 30px;font-size:14px;letter-spacing:.09em;border-radius:2px">MARK SERVICED</a>
  <p style="font-size:12px;color:#888;margin:22px 0 0;line-height:1.6">
    Or open the dashboard: ${escapeHtml(config.publicBaseUrl)}/ops
  </p>`);

  return {
    subject: `STILL OPEN ${waitedMin} min - ${r.label_en}${what}`,
    text,
    html,
  };
}

async function runEscalations() {
  const e = config.escalation;
  const levels = [
    { level: 1, minutes: e.afterMinutes, to: e.to },
    { level: 2, minutes: e.againAfterMinutes, to: e.againTo },
  ];

  let sent = 0;
  for (const L of levels) {
    if (!L.to || !(L.minutes > 0)) continue;
    for (const r of store.openRequestsOlderThan(L.minutes, L.level)) {
      const waited = Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000);
      const status = await sendEmail(
        { to: L.to, ...buildEscalation(r, L.level, waited) },
        { label: `escalation L${L.level} #${r.id}` },
      );
      // Only a real delivery failure leaves the row un-escalated, so it is
      // retried next tick. dry_run and console both count as handled --
      // otherwise a rehearsal would log the same line every minute.
      if (status !== 'failed') {
        store.setEscalationLevel(r.id, L.level);
        sent++;
        console.log(`[escalate] L${L.level} #${r.id} ${r.label_en} (${waited} min) -> ${status}`);
      }
    }
  }
  return sent;
}

// --- 2. Weekly digest ------------------------------------------------------

function buildDigest(days = 7, until = new Date()) {
  const since = new Date(until.getTime() - days * 86400000);
  const s = store.periodSummary(since.toISOString(), until.toISOString());
  const dateOpts = { timeZone: config.timeZone, month: 'short', day: 'numeric' };
  const range = `${since.toLocaleDateString('en-US', dateOpts)} – ${until.toLocaleDateString('en-US', dateOpts)}`;

  const top = s.locations.slice(0, 12);
  const worstLoc = s.locations.filter((l) => l.worst != null).sort((a, b) => b.worst - a.worst)[0];
  const rescanLoc = s.locations.filter((l) => l.rescans > 0).sort((a, b) => b.rescans - a.rescans)[0];

  const text = [
    `Service requests, ${range}`,
    '',
    `Requests: ${s.total}   Completed: ${s.completed}   Still open: ${s.stillOpen}`,
    `Median response: ${fmtMin(s.median)}   Worst: ${fmtMin(s.worst)}   Re-scans: ${s.rescans}`,
    '',
    'By type: ' + Object.entries(s.byType).map(([t, n]) => `${getService(t).en.short} ${n}`).join(', ') || 'none',
    'By team: ' + (s.teams.map((t) => `${TEAM_LABEL[t.team] || t.team} ${t.closed} (median ${fmtMin(t.median)})`).join(', ') || 'none'),
    '',
    'Locations:',
    ...top.map((l) => `  ${l.label.padEnd(28)} ${String(l.total).padStart(3)}  avg ${fmtMin(l.avg).padEnd(8)} worst ${fmtMin(l.worst).padEnd(8)} re-scans ${l.rescans}`),
    '',
    worstLoc ? `Slowest: ${worstLoc.label} (${fmtMin(worstLoc.worst)})` : '',
    rescanLoc ? `Most re-scanned: ${rescanLoc.label} (${rescanLoc.rescans})` : '',
    '',
    `Dashboard: ${config.publicBaseUrl}/ops`,
  ].filter((l) => l !== null).join('\n');

  const stat = (n, k) => `<td style="padding:0 22px 0 0"><div style="font-size:24px;font-weight:600">${n}</div><div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#888">${k}</div></td>`;
  const row = (cells, head) => `<tr>${cells.map((c, i) => `<t${head ? 'h' : 'd'} style="text-align:${i ? 'right' : 'left'};padding:6px ${i ? '0 0 14px' : '14px 0 0'};border-bottom:1px solid #eee;font-size:${head ? '11px;letter-spacing:.1em;text-transform:uppercase;color:#888;font-weight:600' : '13px'}">${c}</t${head ? 'h' : 'd'}>`).join('')}</tr>`;

  const html = shell(`
  <p style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#888;margin:0 0 4px">Aston Martin Residences · Service Requests</p>
  <p style="font-size:20px;font-weight:600;margin:0 0 20px">Week of ${escapeHtml(range)}</p>
  <table style="border-collapse:collapse;margin:0 0 24px"><tr>
    ${stat(s.total, 'Requests')}${stat(s.completed, 'Completed')}${stat(s.stillOpen, 'Still open')}
    ${stat(fmtMin(s.median), 'Median')}${stat(fmtMin(s.worst), 'Worst')}${stat(s.rescans, 'Re-scans')}
  </tr></table>

  <p style="font-size:13px;color:#444;margin:0 0 6px">
    <strong>By type:</strong> ${Object.entries(s.byType).map(([t, n]) => `${escapeHtml(getService(t).en.short)} ${n}`).join(' · ') || 'none'}<br>
    <strong>By team:</strong> ${s.teams.map((t) => `${escapeHtml(TEAM_LABEL[t.team] || t.team)} ${t.closed} <span style="color:#888">(median ${fmtMin(t.median)})</span>`).join(' · ') || 'none'}
  </p>

  <table style="width:100%;border-collapse:collapse;margin:18px 0 6px">
    ${row(['Location', 'Requests', 'Avg', 'Worst', 'Re-scans'], true)}
    ${top.map((l) => row([escapeHtml(l.label), l.total, fmtMin(l.avg), fmtMin(l.worst), l.rescans])).join('')}
  </table>
  ${s.locations.length > top.length ? `<p style="font-size:12px;color:#888;margin:0 0 14px">and ${s.locations.length - top.length} more with fewer requests</p>` : ''}

  ${worstLoc || rescanLoc ? `<p style="font-size:13px;color:#444;margin:14px 0 0;line-height:1.6">
    ${worstLoc ? `<strong>Slowest:</strong> ${escapeHtml(worstLoc.label)} took ${fmtMin(worstLoc.worst)}.<br>` : ''}
    ${rescanLoc ? `<strong>Most re-scanned:</strong> ${escapeHtml(rescanLoc.label)} — ${rescanLoc.rescans} residents scanned it while it was already reported.` : ''}
  </p>` : ''}

  <p style="font-size:12px;color:#888;margin:24px 0 0">
    Re-scans count residents who scanned a location already reported — a rising number means response time is slipping.<br>
    <a href="${escapeHtml(config.publicBaseUrl)}/ops" style="color:#1C4938">Open the dashboard</a>
  </p>`);

  return { subject: `Service requests — week of ${range}`, text, html, summary: s };
}

async function runDigest({ force = false } = {}) {
  const d = config.digest;
  if (!d.to) return 'skipped';
  const now = localParts();
  const key = 'digest_last';
  if (!force) {
    if (now.weekday !== d.day || now.hour < d.hour) return 'not_due';
    if (store.getMeta(key) === now.ymd) return 'already_sent';
  }
  const msg = buildDigest();
  const status = await sendEmail({ to: d.to, subject: msg.subject, text: msg.text, html: msg.html }, { label: 'weekly digest' });
  if (status !== 'failed') store.setMeta(key, now.ymd);
  console.log(`[digest] ${msg.summary.total} requests -> ${status}`);
  return status;
}

// --- 3. Monthly backup -----------------------------------------------------

function snapshotDatabase() {
  const stamp = new Date().toISOString().slice(0, 10);
  const tmp = path.join(os.tmpdir(), `amr-service-qr-${stamp}-${process.pid}.db`);
  try {
    // VACUUM INTO gives a consistent copy while WAL is active; copying the
    // file directly could yield a torn database.
    store.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    return { filename: `amr-service-qr-${stamp}.db`, content: fs.readFileSync(tmp) };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

async function runBackup({ force = false } = {}) {
  const b = config.backup;
  if (!b.to) return 'skipped';
  const now = localParts();
  const key = 'backup_last';
  if (!force) {
    if (now.day !== b.dayOfMonth || now.hour < b.hour) return 'not_due';
    if (store.getMeta(key) === now.ymd) return 'already_sent';
  }

  const file = snapshotDatabase();
  const kb = Math.round(file.content.length / 1024);
  const locations = store.listLocations().length;

  const text = [
    `Monthly backup of the AMR service-request database, attached (${kb} KB).`,
    '',
    `It holds the ${locations} QR codes and all request history. Keep this email,`,
    'or save the attachment somewhere that is not the server.',
    '',
    'If the server is ever lost, this file restores every printed sign.',
  ].join('\n');

  const html = shell(`
  <p style="font-size:16px;margin:0 0 14px">Monthly backup of the service-request database, attached
     <span style="color:#888">(${kb} KB)</span>.</p>
  <p style="font-size:14px;color:#444;margin:0 0 14px;line-height:1.6">
    It holds the <strong>${locations} QR codes</strong> and all request history.
    Keep this email, or save the attachment somewhere that is not the server.
  </p>
  <p style="font-size:13px;color:#888;margin:0">If the server is ever lost, this file restores every printed sign.</p>`);

  const status = await sendEmail(
    { to: b.to, subject: `AMR service-request database backup — ${file.filename}`, text, html, attachments: [file] },
    { label: 'monthly backup' },
  );
  if (status !== 'failed') store.setMeta(key, now.ymd);
  console.log(`[backup] ${kb} KB -> ${status}`);
  return status;
}

// --- tick ------------------------------------------------------------------

async function tick() {
  for (const job of [runEscalations, runDigest, runBackup]) {
    try { await job(); } catch (err) { console.error(`[scheduler] ${job.name} failed:`, err.message); }
  }
}

let timer = null;
function start() {
  if (timer) return;
  // First pass shortly after boot so a restart during the escalation window
  // does not lose it; then every minute.
  setTimeout(() => tick().catch(() => {}), 5000).unref();
  timer = setInterval(() => tick().catch(() => {}), 60000);
  timer.unref();
  console.log(`  scheduler   escalate ${config.escalation.afterMinutes}/${config.escalation.againAfterMinutes} min · digest day ${config.digest.day} ${config.digest.hour}:00 · backup day ${config.backup.dayOfMonth}`);
}

module.exports = { start, tick, runEscalations, runDigest, runBackup, buildDigest, buildEscalation, snapshotDatabase };
