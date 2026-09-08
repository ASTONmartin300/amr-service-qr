// Generates one QR per active location into signs/.
//
//   npm run qr
//
// PUBLIC_BASE_URL is baked into every image. Set it to the final live URL
// before printing -- a QR generated against localhost is useless on a wall.
//
// Error correction is set to H (~30% recoverable) because these end up behind
// scratched elevator panel glass and get partially obscured by fingerprints.
'use strict';

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const store = require('../src/db');
const { config } = require('../src/config');

async function main() {
  const locations = store.listLocations().filter((l) => l.active);
  if (!locations.length) {
    console.error('No active locations. Run "npm run seed" first.');
    process.exit(1);
  }

  if (config.publicBaseUrl.includes('localhost')) {
    console.warn('\n  WARNING: PUBLIC_BASE_URL is localhost.');
    console.warn('  These QR codes will only work on this machine. Fine for testing,');
    console.warn('  useless on a printed sign. Set the real URL before printing.\n');
  }

  fs.mkdirSync(config.signsDir, { recursive: true });

  for (const location of locations) {
    const url = `${config.publicBaseUrl}/r/${location.token}`;
    const safe = location.label_en.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    const options = { errorCorrectionLevel: 'H', margin: 1, color: { dark: '#14161a', light: '#ffffff' } };

    await QRCode.toFile(path.join(config.signsDir, `${safe}.png`), url, { ...options, width: 1400 });
    await QRCode.toFile(path.join(config.signsDir, `${safe}.svg`), url, { ...options, type: 'svg' });

    console.log(`  ${location.label_en.padEnd(28)} ${url}`);
  }

  console.log(`\n${locations.length} QR code(s) written to signs/`);
  console.log('Next:  npm run signs   (print-ready sign sheet)');
}

main().catch((err) => { console.error(err); process.exit(1); });
