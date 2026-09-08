// Inspect and control locations without touching the database by hand.
//
//   npm run locations
//   npm run locations -- --off  <token>     stop a sign from filing requests
//   npm run locations -- --on   <token>
//   npm run locations -- --email <token> <address>
//
// Deactivating is the kill switch: the printed QR stays on the wall and keeps
// resolving, but shows "not currently active" instead of dispatching. Use it if
// a code gets photographed and shared, or during elevator modernization.
'use strict';

const store = require('../src/db');
const { config } = require('../src/config');

const [flag, token, value] = process.argv.slice(2);

function requireLocation(tok) {
  const location = store.getLocationByToken(tok);
  if (!location) {
    console.error(`No location with token "${tok}".`);
    process.exit(1);
  }
  return location;
}

if (flag === '--off' || flag === '--on') {
  const location = requireLocation(token);
  store.setLocationActive(token, flag === '--on');
  console.log(`${location.label_en} is now ${flag === '--on' ? 'ACTIVE' : 'INACTIVE'}.`);
  process.exit(0);
}

if (flag === '--email') {
  const location = requireLocation(token);
  store.db.prepare('UPDATE locations SET notify_email = ? WHERE token = ?')
    .run(value || null, token);
  console.log(`${location.label_en} now notifies ${value || `the default (${config.housekeepingEmail})`}.`);
  process.exit(0);
}

const locations = store.listLocations();
if (!locations.length) {
  console.log('No locations yet. Run "npm run seed -- --elevators 6".');
  process.exit(0);
}

console.log('');
for (const l of locations) {
  const latest = store.latestRequestForLocation(l.id);
  const state = l.active ? 'active  ' : 'INACTIVE';
  const last = latest
    ? `${latest.status === 'open' ? 'OPEN since' : 'last'} ${new Date(latest.created_at)
        .toLocaleString('en-US', { timeZone: config.timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    : 'no requests yet';
  console.log(`  ${state}  ${l.label_en.padEnd(28)} ${`/r/${l.token}`.padEnd(14)} ${l.department.padEnd(13)} ${last}`);
}
console.log(`\n  ${config.publicBaseUrl}/r/<token>\n`);
