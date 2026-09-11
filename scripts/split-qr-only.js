// Extracts just the QR code from each sign on a downloaded sheet and writes
// one PDF per location, named after it -- no heading, no text, no branding.
//
//   node scripts/split-qr-only.js "C:\path\to\Service signs - Aston Martin Residences.html"
//   node scripts/split-qr-only.js "...html" "C:\where\to\put\them"
//
// For handing to a sign vendor who will do their own layout, or for dropping a
// code into something else. Each page is 4x4in with the code at 3.25in, which
// leaves the quiet zone a QR needs to scan reliably; it is vector, so it can be
// scaled to any size without loss.
//
// Works from the downloaded sheet rather than the local database, so the codes
// are the live ones from the server. The location name is read from each
// section's own label, so a code cannot end up under the wrong name.
'use strict';

const fs = require('fs');
const path = require('path');

const PLAYWRIGHT = path.join(__dirname, '..', '..', 'reservation-bot', 'node_modules', 'playwright');

function safeName(label) {
  return label.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// A bare code on a white page. The quiet zone is the margin; nothing else.
function qrPage(svg) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: 4in 4in; margin: 0; }
  html, body { margin: 0; background: #fff; }
  body { width: 4in; height: 4in; display: flex; align-items: center; justify-content: center; }
  svg { width: 3.25in; height: 3.25in; display: block; }
</style></head><body>${svg}</body></html>`;
}

async function main() {
  const src = process.argv[2];
  const outDir = process.argv[3] || path.join(path.dirname(src || '.'), 'AMR QR Codes');

  if (!src || !fs.existsSync(src)) {
    console.error('\nUsage:  node scripts/split-qr-only.js "path\\to\\Service signs ....html"\n');
    console.error('Download the sheet first: sign in to /ops/locations and click "Print all signs",');
    console.error('then save that page as an HTML file.\n');
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = require(PLAYWRIGHT));
  } catch (err) {
    console.error('\nCould not load Playwright from reservation-bot.\n  ' + PLAYWRIGHT + '\n');
    process.exit(1);
  }

  const html = fs.readFileSync(src, 'utf8');
  const sections = html.match(/<section class="sign">[\s\S]*?<\/section>/g) || [];
  if (!sections.length) {
    console.error('\nNo signs found in that file. Is it the sheet from /ops/signs?\n');
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    if (/Executable doesn't exist/.test(err.message)) {
      const who = (err.message.match(/C:\\Users\\([^\\]+)/) || [])[1];
      console.error(`\nChromium is not installed for the account this terminal runs as${who ? ` (${who})` : ''}.`);
      console.error('Close this window and open a normal PowerShell -- not "Run as administrator" --');
      console.error('so it runs as your own account, where the browser is already installed.\n');
      process.exit(1);
    }
    throw err;
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n${sections.length} signs found\n`);

  const page = await browser.newPage({ viewport: { width: 384, height: 384 } });
  const used = new Set();
  let written = 0;
  let skipped = 0;

  for (const section of sections) {
    const label = decodeEntities((section.match(/<div class="tag">([\s\S]*?)<\/div>/) || [, ''])[1]).trim();
    const svg = (section.match(/<svg[\s\S]*?<\/svg>/) || [])[0];
    if (!label || !svg) { skipped++; continue; }

    let name = safeName(label);
    if (used.has(name.toLowerCase())) {
      let n = 2;
      while (used.has(`${name} (${n})`.toLowerCase())) n++;
      name = `${name} (${n})`;
      console.log(`  note: duplicate name, saved as "${name}"`);
    }
    used.add(name.toLowerCase());

    await page.setContent(qrPage(svg), { waitUntil: 'load' });
    await page.pdf({
      path: path.join(outDir, `${name}.pdf`),
      width: '4in',
      height: '4in',
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    written++;
    console.log(`  ${String(written).padStart(2)}. ${name}.pdf`);
  }

  await browser.close();

  if (skipped) console.log(`\n  WARNING: ${skipped} section(s) had no code or no label and were skipped.`);
  console.log(`\n${written} PDFs written to:\n  ${outDir}\n`);
  console.log('Each is a 4x4in page holding only the code, as vector. Scale freely.\n');
}

main().catch((err) => { console.error('\n' + err.message + '\n'); process.exit(1); });
