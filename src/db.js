// Storage. Uses node:sqlite (built into Node 22.5+), so there is no native
// module to compile and nothing to install beyond npm packages -- which matters
// on a Windows box without build tools.
//
// Deliberately stores NO resident identity: no IP, no user agent, no cookie, no
// unit number. The anonymity promised on the sign is structural, not a policy.
'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { serialize: serializeServices } = require('./services');

// node:sqlite is built into Node, so there is no native module to compile --
// but it only stopped requiring a flag in Node 23.4, and Node 22 LTS is still
// what many shops standardise on. Fail with an instruction rather than a
// confusing ERR_UNKNOWN_BUILTIN_MODULE.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error(`\nThis application needs Node 24 or newer. Running: ${process.version}\n`);
  console.error('Node 22 can run it with the SQLite module enabled explicitly:');
  console.error('  NODE_OPTIONS=--experimental-sqlite npm start\n');
  throw err;
}

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS locations (
    id            INTEGER PRIMARY KEY,
    token         TEXT    NOT NULL UNIQUE,
    label_en      TEXT    NOT NULL,
    label_es      TEXT    NOT NULL,
    kind          TEXT    NOT NULL DEFAULT 'amenity',
    department    TEXT    NOT NULL DEFAULT 'housekeeping',
    notify_email  TEXT,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id                INTEGER PRIMARY KEY,
    location_id       INTEGER NOT NULL REFERENCES locations(id),
    created_at        TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'open',
    completed_at      TEXT,
    suppressed_scans  INTEGER NOT NULL DEFAULT 0,
    email_status      TEXT    NOT NULL DEFAULT 'pending'
  );

  CREATE INDEX IF NOT EXISTS idx_requests_location
    ON requests(location_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_requests_status
    ON requests(status, created_at DESC);
`);

// Additive migrations for databases created by an earlier version. SQLite has
// no "ADD COLUMN IF NOT EXISTS", so this checks the existing columns first --
// which matters once this is on a server holding real history that must not be
// rebuilt to pick up a schema change.
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] migrated: added ${table}.${column}`);
}
addColumnIfMissing('locations', 'kind', "TEXT NOT NULL DEFAULT 'amenity'");
addColumnIfMissing('locations', 'sort_order', 'INTEGER NOT NULL DEFAULT 1000');
// Which buttons a location offers. Existing rows keep the old single-button
// behaviour until they are told otherwise, so a migration never silently
// changes what a printed sign does.
addColumnIfMissing('locations', 'services', "TEXT NOT NULL DEFAULT 'cleaning'");
// Requests filed before this column existed were all cleaning requests.
addColumnIfMissing('requests', 'type', "TEXT NOT NULL DEFAULT 'cleaning'");

// What a resupply request is for (towels, paper, dog bags). Null for other
// types, and for resupply requests filed before the picker existed.
addColumnIfMissing('requests', 'detail', 'TEXT');

// Who closed it: 'housekeeping' or 'engineering' when tapped from their email,
// 'dashboard' when closed by management, null for requests closed before this
// was tracked. Lets response times split by team.
addColumnIfMissing('requests', 'closed_by', 'TEXT');

// How far up the chain an open request has been escalated. 0 = not yet,
// 1 = front desk notified, 2 = manager notified. Kept on the row rather than
// in memory so a restart never re-sends an escalation already sent.
addColumnIfMissing('requests', 'escalation_level', 'INTEGER NOT NULL DEFAULT 0');

// The items a resupply request at this location can be for, comma-separated.
// Blank means the picker is skipped and the request is filed as plain resupply.
addColumnIfMissing('locations', 'supplies', 'TEXT');

// Small key/value store for "when did the digest last go out" and the like.
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const nowIso = () => new Date().toISOString();

// --- meta ------------------------------------------------------------------

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value == null ? null : String(value));
}

// --- locations -------------------------------------------------------------

function serializeSupplies(list) {
  const items = (Array.isArray(list) ? list : String(list || '').split(','))
    .map((s) => s.trim()).filter(Boolean);
  return items.length ? items.join(',') : null;
}

function createLocation({
  token, labelEn, labelEs, kind, department, notifyEmail, sortOrder, services, supplies,
}) {
  db.prepare(`
    INSERT INTO locations
      (token, label_en, label_es, kind, department, notify_email, sort_order,
       services, supplies, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(token, labelEn, labelEs, kind || 'amenity',
    department || 'housekeeping', notifyEmail || null,
    Number.isFinite(sortOrder) ? sortOrder : 1000,
    serializeServices(services || 'cleaning'), serializeSupplies(supplies), nowIso());
  return getLocationByToken(token);
}

function setLocationServices(token, services) {
  db.prepare('UPDATE locations SET services = ? WHERE token = ?')
    .run(serializeServices(services), token);
}

function setLocationSupplies(token, supplies) {
  db.prepare('UPDATE locations SET supplies = ? WHERE token = ?')
    .run(serializeSupplies(supplies), token);
}

function getLocationByToken(token) {
  return db.prepare('SELECT * FROM locations WHERE token = ?').get(token);
}

function getLocationById(id) {
  return db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
}

function listLocations() {
  return db.prepare('SELECT * FROM locations ORDER BY sort_order, label_en').all();
}

function setLocationActive(token, active) {
  db.prepare('UPDATE locations SET active = ? WHERE token = ?').run(active ? 1 : 0, token);
}

// Rotates the URL behind a sign without reprinting it -- only useful together
// with a redirect, so it is exposed for completeness but not wired into the UI.
function rotateLocationToken(oldToken, newToken) {
  db.prepare('UPDATE locations SET token = ? WHERE token = ?').run(newToken, oldToken);
}

// --- requests --------------------------------------------------------------

// Pass a type to look only at that kind of request. Omit it for the location's
// most recent request of any kind.
function latestRequestForLocation(locationId, type) {
  if (type) {
    return db.prepare(`
      SELECT * FROM requests WHERE location_id = ? AND type = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(locationId, type);
  }
  return db.prepare(`
    SELECT * FROM requests WHERE location_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(locationId);
}

// A location is suppressed for a given request type if it already has an OPEN
// request of that type (reported, nobody has cleared it), or if one was filed
// within the suppression window (so a just-serviced cab is not re-reported on
// the way back down). Returns the blocking request, or null.
//
// Suppression is per type, deliberately. A broken light in Cabana 3 must still
// reach engineering even though someone reported the same cabana dirty ten
// minutes ago -- those are different problems for different people, and
// collapsing them would silently swallow the repair.
function suppressingRequest(locationId, type, minutes) {
  const latest = latestRequestForLocation(locationId, type);
  if (!latest) return null;
  if (latest.status === 'open') return latest;
  const ageMs = Date.now() - new Date(latest.created_at).getTime();
  if (ageMs < minutes * 60 * 1000) return latest;
  return null;
}

function createRequest(locationId, type, detail) {
  const info = db.prepare(`
    INSERT INTO requests (location_id, type, detail, created_at, status)
    VALUES (?, ?, ?, ?, 'open')
  `).run(locationId, type || 'cleaning', detail || null, nowIso());
  return getRequest(Number(info.lastInsertRowid));
}

// Open requests that have been waiting longer than `minutes` and have not yet
// been escalated past `belowLevel`. The scheduler calls this once per level.
function openRequestsOlderThan(minutes, belowLevel) {
  const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
  return db.prepare(`
    SELECT r.*, l.label_en, l.label_es, l.token
    FROM requests r JOIN locations l ON l.id = r.location_id
    WHERE r.status = 'open' AND r.created_at <= ? AND r.escalation_level < ?
    ORDER BY r.created_at ASC
  `).all(cutoff, belowLevel);
}

function setEscalationLevel(requestId, level) {
  db.prepare('UPDATE requests SET escalation_level = ? WHERE id = ? AND escalation_level < ?')
    .run(level, requestId, level);
}

function getRequest(id) {
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

function noteSuppressedScan(requestId) {
  db.prepare('UPDATE requests SET suppressed_scans = suppressed_scans + 1 WHERE id = ?')
    .run(requestId);
}

function setEmailStatus(requestId, status) {
  db.prepare('UPDATE requests SET email_status = ? WHERE id = ?').run(status, requestId);
}

// Single-use by construction: only an 'open' row is updated, so a forwarded or
// replayed MARK SERVICED link is a no-op. Returns true if this call closed it.
// closedBy is who did it -- a department name from the email link, or
// 'dashboard' -- so response times can be split by team.
function completeRequest(id, closedBy) {
  const info = db.prepare(`
    UPDATE requests SET status = 'completed', completed_at = ?, closed_by = ?
    WHERE id = ? AND status = 'open'
  `).run(nowIso(), closedBy || null, id);
  return info.changes > 0;
}

// --- reporting -------------------------------------------------------------

function openRequests() {
  return db.prepare(`
    SELECT r.*, l.label_en, l.label_es, l.token
    FROM requests r JOIN locations l ON l.id = r.location_id
    WHERE r.status = 'open'
    ORDER BY r.created_at ASC
  `).all();
}

function recentRequests(days) {
  return db.prepare(`
    SELECT r.*, l.label_en, l.label_es, l.token
    FROM requests r JOIN locations l ON l.id = r.location_id
    WHERE r.created_at >= ?
    ORDER BY r.created_at DESC
  `).all(new Date(Date.now() - days * 86400000).toISOString());
}

// Per-location rollup: volume, how many people re-scanned a reported location
// (a proxy for "housekeeping is too slow"), and response times.
function locationStats(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare(`
    SELECT
      l.id, l.token, l.label_en, l.active,
      COUNT(r.id)                                       AS total,
      SUM(CASE WHEN r.status = 'open' THEN 1 ELSE 0 END) AS open_count,
      COALESCE(SUM(r.suppressed_scans), 0)              AS repeat_scans,
      AVG(CASE WHEN r.completed_at IS NOT NULL
               THEN (julianday(r.completed_at) - julianday(r.created_at)) * 1440
          END)                                          AS avg_minutes,
      MAX(CASE WHEN r.completed_at IS NOT NULL
               THEN (julianday(r.completed_at) - julianday(r.created_at)) * 1440
          END)                                          AS max_minutes
    FROM locations l
    LEFT JOIN requests r ON r.location_id = l.id AND r.created_at >= ?
    GROUP BY l.id
    ORDER BY l.sort_order, l.label_en
  `).all(since);
}

// Everything the weekly digest needs, in one call. Window is [since, until).
function periodSummary(sinceIso, untilIso) {
  const rows = db.prepare(`
    SELECT r.*, l.label_en
    FROM requests r JOIN locations l ON l.id = r.location_id
    WHERE r.created_at >= ? AND r.created_at < ?
  `).all(sinceIso, untilIso);

  const minutes = (r) => (new Date(r.completed_at) - new Date(r.created_at)) / 60000;
  const completed = rows.filter((r) => r.completed_at);
  const times = completed.map(minutes).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : null;

  const byType = {};
  const byTeam = {};
  const byLocation = {};
  for (const r of rows) {
    byType[r.type] = (byType[r.type] || 0) + 1;
    const loc = byLocation[r.label_en] || (byLocation[r.label_en] = {
      label: r.label_en, total: 0, open: 0, rescans: 0, times: [],
    });
    loc.total++;
    if (r.status === 'open') loc.open++;
    loc.rescans += r.suppressed_scans || 0;
    if (r.completed_at) {
      loc.times.push(minutes(r));
      const team = r.closed_by || 'unrecorded';
      const t = byTeam[team] || (byTeam[team] = { closed: 0, times: [] });
      t.closed++;
      t.times.push(minutes(r));
    }
  }

  const locations = Object.values(byLocation).map((l) => ({
    label: l.label,
    total: l.total,
    open: l.open,
    rescans: l.rescans,
    avg: l.times.length ? l.times.reduce((a, b) => a + b, 0) / l.times.length : null,
    worst: l.times.length ? Math.max(...l.times) : null,
  })).sort((a, b) => b.total - a.total);

  const teams = Object.entries(byTeam).map(([team, t]) => ({
    team,
    closed: t.closed,
    median: t.times.sort((a, b) => a - b)[Math.floor(t.times.length / 2)],
  }));

  return {
    since: sinceIso,
    until: untilIso,
    total: rows.length,
    completed: completed.length,
    stillOpen: rows.filter((r) => r.status === 'open').length,
    median,
    worst: times.length ? times[times.length - 1] : null,
    rescans: rows.reduce((n, r) => n + (r.suppressed_scans || 0), 0),
    byType,
    locations,
    teams,
  };
}

module.exports = {
  db,
  getMeta,
  setMeta,
  createLocation,
  getLocationByToken,
  getLocationById,
  listLocations,
  setLocationActive,
  setLocationServices,
  setLocationSupplies,
  rotateLocationToken,
  latestRequestForLocation,
  suppressingRequest,
  createRequest,
  getRequest,
  noteSuppressedScan,
  setEmailStatus,
  completeRequest,
  openRequests,
  openRequestsOlderThan,
  setEscalationLevel,
  recentRequests,
  locationStats,
  periodSummary,
};
