// First-boot seeding.
//
// On a hosted platform there is no convenient shell to run "npm run seed" in,
// and getting that wrong leaves 35 signs pointing at nothing. So the service
// seeds itself the first time it starts against an empty database.
//
// Guarded three ways, because accidentally minting new tokens after the signs
// are printed would silently break every QR code in the building:
//   * only runs when the locations table is completely empty
//   * only runs when AUTO_SEED is true
//   * never touches, re-tokenizes, or removes an existing location
'use strict';

const store = require('./db');
const { randomToken } = require('./tokens');

function autoSeed({ enabled }) {
  const existing = store.listLocations();

  if (existing.length) {
    if (enabled) {
      console.log(`[bootstrap] ${existing.length} location(s) already present -- not seeding.`);
    }
    return { seeded: 0, existing: existing.length };
  }

  if (!enabled) {
    console.warn('[bootstrap] Database is empty and AUTO_SEED is off.');
    console.warn('[bootstrap] Every QR will 404 until locations exist.');
    console.warn('[bootstrap] Set AUTO_SEED=true and restart, or run: npm run seed -- --building');
    return { seeded: 0, existing: 0 };
  }

  const { locations } = require('../scripts/amr-building');
  for (const entry of locations) {
    store.createLocation({
      token: randomToken(),
      labelEn: entry.labelEn,
      labelEs: entry.labelEs,
      kind: entry.kind,
      department: entry.department,
      sortOrder: entry.sortOrder,
      // Must be passed. Omitting it silently defaults every location to
      // cleaning-only, which shows one button instead of three AND changes the
      // wording on the printed sign -- a failure that only becomes visible
      // after 44 signs have been laminated.
      services: entry.services,
    });
  }

  console.log(`[bootstrap] Seeded ${locations.length} locations on first boot.`);
  console.log('[bootstrap] Sign in to /ops and use "Print signs" to generate the signage.');
  console.log('[bootstrap] These tokens are now permanent -- back up the database.');

  return { seeded: locations.length, existing: 0 };
}

module.exports = { autoSeed };
