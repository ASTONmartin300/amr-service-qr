// Creates locations and their permanent random tokens.
//
//   npm run seed -- --building              every AMR location (see amr-building.js)
//   npm run seed -- --elevators 6           generic E01..E06, for testing
//   npm run seed -- "Grand Salon"           one-off
//   npm run seed -- --department engineering "Loading Dock"
//
// Safe to re-run: anything already present by name is skipped, so adding a new
// row to amr-building.js and re-seeding creates only the new sign. Tokens are
// printed into QR codes, so an existing location is never re-tokenized here --
// use scripts/locations.js to deactivate instead.
'use strict';

const store = require('../src/db');
const { randomToken } = require('../src/tokens');
const { serialize: serializeServices } = require('../src/services');

const args = process.argv.slice(2);
let department = 'housekeeping';
let entries = [];

// Spanish for the handful of nouns that show up in ad-hoc seeds. The full AMR
// list carries hand-written Spanish in amr-building.js rather than relying on
// this -- pattern matching is fine for "Elevator", not for "Putting Green".
const ES = [
  [/^Resident(ial)? Elevator\b/i, 'Ascensor Residencial'],
  [/^Service Elevator\b/i, 'Ascensor de Servicio'],
  [/^Elevator\b/i, 'Ascensor'],
  [/^Restroom\b/i, 'Baño'],
  [/^Pool Deck\b/i, 'Terraza de la Piscina'],
  [/^Fitness Center\b/i, 'Gimnasio'],
  [/^Garage\b/i, 'Garaje'],
];

function toSpanish(labelEn) {
  for (const [pattern, replacement] of ES) {
    if (pattern.test(labelEn)) return labelEn.replace(pattern, replacement);
  }
  return labelEn;
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--department') { department = args[++i]; continue; }

  if (args[i] === '--building') {
    entries = entries.concat(require('./amr-building').locations);
    continue;
  }

  if (args[i] === '--elevators') {
    const n = parseInt(args[++i], 10);
    if (!Number.isFinite(n) || n < 1 || n > 40) {
      console.error('--elevators needs a number between 1 and 40');
      process.exit(1);
    }
    for (let e = 1; e <= n; e++) {
      const labelEn = `Resident Elevator E${String(e).padStart(2, '0')}`;
      entries.push({ labelEn, labelEs: toSpanish(labelEn), kind: 'elevator', sortOrder: e * 10 });
    }
    continue;
  }

  entries.push({ labelEn: args[i], labelEs: toSpanish(args[i]), kind: 'amenity' });
}

if (!entries.length) {
  console.error('Nothing to seed.\n');
  console.error('  npm run seed -- --building        every AMR elevator and amenity');
  console.error('  npm run seed -- --elevators 6     generic test elevators');
  console.error('  npm run seed -- "Grand Salon"     a single location');
  process.exit(1);
}

const byName = new Map(store.listLocations().map((l) => [l.label_en.toLowerCase(), l]));
const existing = new Set(byName.keys());
let created = 0;
let skipped = 0;
let synced = 0;

for (const entry of entries) {
  if (existing.has(entry.labelEn.toLowerCase())) {
    skipped++;

    // The manifest is the source of truth for which buttons a location offers.
    // Tokens, history and active state are never touched -- only the service
    // list is brought back in line, so a sign already on a wall keeps working
    // and simply starts offering the right options.
    const current = byName.get(entry.labelEn.toLowerCase());
    const want = serializeServices(entry.services || 'cleaning');
    if (current.services !== want) {
      store.setLocationServices(current.token, want);
      console.log(`  updated   ${entry.labelEn.padEnd(30)}${current.services} -> ${want}`);
      synced++;
    }
    continue;
  }
  const location = store.createLocation({
    token: randomToken(),
    labelEn: entry.labelEn,
    labelEs: entry.labelEs,
    kind: entry.kind || 'amenity',
    department: entry.department || department,
    sortOrder: entry.sortOrder,
    services: entry.services || 'cleaning',
  });
  existing.add(entry.labelEn.toLowerCase());
  created++;
  console.log(`  ${(location.kind === 'elevator' ? 'elevator' : 'amenity ')}  ${location.label_en.padEnd(30)} /r/${location.token}`);
}

console.log(`\n${created} created${skipped ? `, ${skipped} already existed` : ''}`
  + `${synced ? `, ${synced} service list(s) updated` : ''}.`);

const all = store.listLocations();
const byKind = all.reduce((m, l) => { m[l.kind] = (m[l.kind] || 0) + 1; return m; }, {});
console.log(`Total: ${all.length} location(s) -- ` +
  Object.keys(byKind).sort().map((k) => `${byKind[k]} ${k}`).join(', ') + '.');

if (created) console.log('\nNext:  npm run qr     (generate the QR images)');
