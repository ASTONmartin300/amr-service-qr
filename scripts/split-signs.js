// Splits the sign sheet downloaded from /ops/signs into one PDF per location,
// named after the location.
//
//   node scripts/split-signs.js "C:\path\to\Service signs - Aston Martin Residences.html"
//   node scripts/split-signs.js "...html" "C:\where\to\put\them"
//
// Works from the downloaded sheet rather than the local database, so the QR
// codes are the live ones from the server. Each section already carries its own
// location name, so the pairing of code to room is preserved by construction --
// nothing here can shuffle a code into the wrong room.
'use strict';

const fs = require('fs');
const path = require('path');

const PLAYWRIGHT = path.join(__dirname, '..', '..', 'reservation-bot', 'node_modules', 'playwright');

// Windows forbids \ / : * ? " < > | in filenames. Apostrophes are legal and
// worth keeping -- "Men's Spa.pdf" reads better than "Mens Spa.pdf".
function safeName(label) {
  return label.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

async function main() {
  const src = process.argv[2];
  const outDir = process.argv[3]
    || path.join(path.dirname(src || '.'), 'AMR QR Signs');

  if (!src || !fs.existsSync(src)) {
    console.error('\nUsage:  node scripts/split-signs.js "path\\to\\Service signs ....html"\n');
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

  // The sheet's own stylesheet, reused verbatim so each PDF is identical to
  // what the browser would print.
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  const sections = html.match(/<section class="sign">[\s\S]*?<\/section>/g) || [];

  if (!sections.length) {
    console.error('\nNo signs found in that file. Is it the sheet from /ops/signs?\n');
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n${sections.length} signs found\n`);

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    // Playwright keeps its browsers per Windows account. An elevated "Run as
    // administrator" PowerShell runs as a different account, which has none.
    if (/Executable doesn't exist/.test(err.message)) {
      const who = (err.message.match(/C:\\Users\\([^\\]+)/) || [])[1];
      console.error(`\nChromium is not installed for the account this terminal runs as${who ? ` (${who})` : ''}.`);
      console.error('Close this window and open a normal PowerShell -- not "Run as administrator" --');
      console.error('so it runs as your own account, where the browser is already installed.\n');
      process.exit(1);
    }
    throw err;
  }
  const page = await browser.newPage({ viewport: { width: 480, height: 672 } });

  const used = new Set();
  let written = 0;
  const missing = [];

  for (const section of sections) {
    const tag = (section.match(/<div class="tag">([\s\S]*?)<\/div>/) || [, ''])[1];
    const label = decodeEntities(tag).trim();

    if (!label) { missing.push(written + 1); continue; }

    // Two locations should never share a name, but if the sheet ever contains
    // duplicates, keep both rather than silently overwriting one.
    let name = safeName(label);
    if (used.has(name.toLowerCase())) {
      let n = 2;
      while (used.has(`${name} (${n})`.toLowerCase())) n++;
      name = `${name} (${n})`;
      console.log(`  note: duplicate name, saved as "${name}"`);
    }
    used.add(name.toLowerCase());

    // margin:0 on .sign because the page itself is now exactly one sign.
    const doc = `<!doctype html><html><head><meta charset="utf-8">
<style>${style}
  body { background:#fff; margin:0; }
  .sign { margin:0 !important; box-shadow:none !important; }
</style></head><body>${section}</body></html>`;

    await page.setContent(doc, { waitUntil: 'load' });
    await page.pdf({
      path: path.join(outDir, `${name}.pdf`),
      width: '5in',
      height: '7in',
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    written++;
    console.log(`  ${String(written).padStart(2)}. ${name}.pdf`);
  }

  await browser.close();

  if (missing.length) {
    console.log(`\n  WARNING: ${missing.length} section(s) had no location name and were skipped.`);
  }
  console.log(`\n${written} PDFs written to:\n  ${outDir}\n`);
  console.log('Each is one 5x7in page. Print at 100% scale, or send the folder to a print shop.\n');
}

main().catch((err) => { console.error('\n' + err.message + '\n'); process.exit(1); });
