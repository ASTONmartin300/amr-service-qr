// Writes the print-ready sign sheet to disk.
//
//   npm run signs
//   npm run signs -- --kind elevator
//
// On a hosted deployment you will not usually run this -- sign in to /ops and
// use the "Print signs" link instead, which serves the same sheet straight from
// the live database. This script exists for local generation and archiving.
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../src/db');
const { config } = require('../src/config');
const { buildSignSheet } = require('../src/signsheet');

async function main() {
  const args = process.argv.slice(2);
  const kindFilter = args.includes('--kind') ? args[args.indexOf('--kind') + 1] : null;

  let locations = store.listLocations().filter((l) => l.active);
  if (kindFilter) locations = locations.filter((l) => l.kind === kindFilter);

  if (!locations.length) {
    console.error(kindFilter
      ? `No active locations of kind "${kindFilter}".`
      : 'No active locations. Run "npm run seed -- --building" first.');
    process.exit(1);
  }

  if (config.publicBaseUrl.includes('localhost')) {
    console.warn('\n  WARNING: PUBLIC_BASE_URL is localhost. These signs are for testing only.\n');
  }

  fs.mkdirSync(config.signsDir, { recursive: true });

  const html = await buildSignSheet(locations, config.publicBaseUrl);
  const out = path.join(config.signsDir, kindFilter ? `signs-${kindFilter}.html` : 'signs.html');
  fs.writeFileSync(out, html, 'utf8');

  const elevators = locations.filter((l) => l.kind === 'elevator').length;
  console.log(`  ${locations.length} sign(s) -> ${out}`);
  console.log(`  ${elevators} elevator, ${locations.length - elevators} amenity`);
  console.log('\nOpen it in a browser and print at 100% scale, or Save as PDF for the printer.');
  console.log('The small grey code at the bottom of each sign names its location, so');
  console.log('whoever installs them cannot put the Grand Cinema code in the Small Cinema.');
  console.log('\nPrinting in phases?  npm run signs -- --kind elevator');
}

main().catch((err) => { console.error(err); process.exit(1); });
