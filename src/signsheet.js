// Builds the print-ready sign sheet. Lives in src/ rather than scripts/ because
// the running server serves it at /ops/signs too -- on a hosted platform there
// is no convenient way to run a script and retrieve the file it wrote, so the
// app has to hand it over through the browser.
'use strict';

const QRCode = require('qrcode');
const { escapeHtml } = require('./mailer');

// One heading and one call to action on every sign in the building. The code
// already knows where it is, so the sign never needs to say "Elevator" or
// "Supply" -- and one voice across 44 signs reads as intentional where three
// headings read as a ticketing system. Only the middle line varies, to name
// what might need attention here.
//
// Register chosen with Operations, 2026-09-10: hospitality, not facilities.
// It offers rather than asks, and avoids "report", "issue" and "request".
const VOICE = {
  en: 'At Your Service',
  es: 'A su servicio',
  ctaEn: 'Scan and let us know',
  ctaEs: 'Escanee y av&iacute;senos',
  fineEn: 'Discreet and anonymous. Nothing to type.',
  fineEs: 'Discreto y an&oacute;nimo. Nada que escribir.',
};

const LEDE = {
  elevator: {
    en: 'Should this elevator need attention, we would be glad to know.',
    es: 'Si este ascensor requiere atenci&oacute;n, nos gustar&iacute;a saberlo.',
  },
  amenity: {
    en: 'Should anything here need attention, we would be glad to know.',
    es: 'Si algo aqu&iacute; requiere atenci&oacute;n, nos gustar&iacute;a saberlo.',
  },
  supply: {
    en: 'Should the bags run low, we would be glad to know.',
    es: 'Si las bolsas se agotan, nos gustar&iacute;a saberlo.',
  },
};

function headingFor(location) {
  return { ...VOICE, lede: LEDE[location.kind] || LEDE.amenity };
}

const STYLE = `
  @page { size: 5in 7in; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background:#6b6f76; font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
         color:#14161a; }
  .sign { width:5in; height:7in; background:#fff; margin:0 auto 26px;
          padding:0.62in 0.55in 0.5in; display:flex; flex-direction:column;
          align-items:center; text-align:center; page-break-after:always; }
  .rule { width:34px; height:1px; background:#14161a; opacity:.5; }
  .eyebrow { font-size:7.5pt; letter-spacing:.28em; text-transform:uppercase;
             color:#8a8f98; margin:16px 0 30px; }
  h1 { font-size:20pt; font-weight:400; letter-spacing:.03em; line-height:1.22; }
  h1 .es { display:block; font-size:11pt; color:#8a8f98; letter-spacing:.05em;
           margin-top:5px; }
  .lede { font-size:9.5pt; line-height:1.55; color:#4a4f57; margin:16px 0 0;
          max-width:3.1in; }
  .lede .es { display:block; color:#9aa0a8; font-size:8.5pt; margin-top:4px; }
  .qr { margin:auto 0; padding:16px 0; }
  .qr svg { width:2.35in; height:2.35in; display:block; }
  .cta { font-size:10.5pt; letter-spacing:.02em; line-height:1.5; margin-bottom:9px; }
  .cta .es { display:block; color:#8a8f98; font-size:9pt; margin-top:3px; }
  .fine { font-size:7.5pt; color:#9aa0a8; line-height:1.5; margin-bottom:22px; }
  .fine .es { display:block; margin-top:2px; }
  .tag { font-size:6.5pt; letter-spacing:.22em; text-transform:uppercase;
         color:#c2c6cc; margin-top:10px; }
  .hint { max-width:5in; margin:0 auto 22px; color:#e8e9ec; font-size:12px;
          font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
          line-height:1.6; }
  @media print { body { background:#fff; } .sign { margin:0; } .hint { display:none; } }
`;

// Error correction H (~30% recoverable) because these end up behind scratched
// elevator panel glass and collect fingerprints.
async function signSvg(url) {
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'H',
    margin: 0,
    color: { dark: '#14161a', light: '#ffffff' },
  });
}

async function buildSignSheet(locations, baseUrl, { hint } = {}) {
  const pages = [];

  for (const location of locations) {
    const heading = headingFor(location);
    const svg = await signSvg(`${baseUrl}/r/${location.token}`);

    pages.push(`
  <section class="sign">
    <div class="rule"></div>
    <div class="eyebrow">Aston Martin Residences</div>
    <h1>${escapeHtml(heading.en)}<span class="es">${escapeHtml(heading.es)}</span></h1>
    <p class="lede">
      ${heading.lede.en}
      <span class="es">${heading.lede.es}</span>
    </p>
    <div class="qr">${svg}</div>
    <p class="cta">
      ${heading.ctaEn}
      <span class="es">${heading.ctaEs}</span>
    </p>
    <p class="fine">
      ${heading.fineEn}
      <span class="es">${heading.fineEs}</span>
    </p>
    <div class="rule"></div>
    <div class="tag">${escapeHtml(location.label_en)}</div>
  </section>`);
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Service signs - Aston Martin Residences</title>
<style>${STYLE}</style></head>
<body>
${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ''}
${pages.join('\n')}
</body></html>`;
}

module.exports = { buildSignSheet, signSvg, VOICE, LEDE };
