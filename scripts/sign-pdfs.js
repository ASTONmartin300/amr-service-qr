// Generates one print-ready PDF per sign, named after its location.
//
//   node scripts/sign-pdfs.js "C:\path\to\amr-locations-2026-09-10.csv"
//
// Produces  signs-pdf/Residential Elevator P3.pdf  and 43 others, each a
// single 5x7in page ready to hand to a print shop.
//
// Reads the CSV exported from the live dashboard (/ops/locations.csv) rather
// than the local database, because the codes printed on real signs only exist
// on the server. Generating from a local database would produce 44 handsome
// signs that scan to nothing.
//
// Rendering uses the Chromium that reservation-bot already installed, so there
// is nothing extra to install on this machine.
'use strict';

const fs = require('fs');
const path = require('path');
const { buildSignSheet } = require('../src/signsheet');

const PLAYWRIGHT = path.join(__dirname, '..', '..', 'reservation-bot', 'node_modules', 'playwright');
const OUT_DIR = path.join(__dirname, '..', 'signs-pdf');

// Minimal CSV reader: enough for the quoted, comma-separated, CRLF file the
// export writes. Not a general parser, and does not need to be.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else { field += c; }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

// Windows forbids \ / : * ? " < > | in filenames. Apostrophes are legal and
// worth keeping -- "Men's Spa.pdf" reads better than "Mens Spa.pdf".
function safeName(label) {
  return label.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('\nUsage:  node scripts/sign-pdfs.js "path\\to\\amr-locations.csv"\n');
    console.error('Download the CSV first: sign in to /ops/locations and click');
    console.error('"Download location list".\n');
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`\nCannot find ${csvPath}\n`);
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = require(PLAYWRIGHT));
  } catch (err) {
    console.error('\nCould not load Playwright from reservation-bot.');
    console.error('Expected it at: ' + PLAYWRIGHT + '\n');
    process.exit(1);
  }

  // Strip the BOM the export writes for Excel's benefit.
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  const header = rows.shift().map((h) => h.trim().toLowerCase());

  const col = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSV has no "${name}" column. Is this the export from /ops/locations.csv?`);
    return i;
  };
  const iName = col('location'), iEs = col('spanish'), iKind = col('type');
  const iOpts = col('options'), iActive = col('active'), iToken = col('code'), iUrl = col('scan url');

  const locations = rows
    .filter((r) => (r[iActive] || '').trim().toLowerCase() !== 'no')
    .map((r) => ({
      label_en: r[iName].trim(),
      label_es: (r[iEs] || r[iName]).trim(),
      kind: (r[iKind] || 'amenity').trim(),
      services: (r[iOpts] || 'cleaning').split('+').map((s) => s.trim()).join(','),
      token: r[iToken].trim(),
      url: (r[iUrl] || '').trim(),
    }));

  if (!locations.length) {
    console.error('\nNo active locations found in that CSV.\n');
    process.exit(1);
  }

  // The base URL comes from the exported scan URLs, so the PDFs always match
  // whatever the live site is actually using.
  const first = locations[0].url;
  const baseUrl = first ? first.replace(/\/r\/.*$/, '') : '';
  if (!baseUrl) {
    console.error('\nCSV has no scan URLs to derive the site address from.\n');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n${locations.length} active locations · ${baseUrl}\n`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  let written = 0;

  for (const loc of locations) {
    const html = await buildSignSheet([loc], baseUrl);
    await page.setContent(html, { waitUntil: 'load' });

    const file = path.join(OUT_DIR, `${safeName(loc.label_en)}.pdf`);
    await page.pdf({
      path: file,
      width: '5in',
      height: '7in',
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    written++;
    console.log(`  ${String(written).padStart(2)}. ${loc.label_en.padEnd(30)} /r/${loc.token}`);
  }

  await browser.close();
  console.log(`\n${written} PDFs written to:\n  ${OUT_DIR}\n`);
  console.log('Each is one 5x7in page. Print at 100% scale, or send the folder to a print shop.\n');
}

main().catch((err) => { console.error('\n' + err.message + '\n'); process.exit(1); });
