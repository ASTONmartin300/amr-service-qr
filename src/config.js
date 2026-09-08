// Central config. Everything tunable lives in .env so nothing operational
// requires a code change.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  port: int(process.env.PORT, 8080),

  // Defaults to loopback. On a server this process sits behind nginx/IIS/Caddy
  // on the same host, so it should not be listening on a routable interface --
  // that would let anything on the internal network reach it directly and
  // bypass whatever the reverse proxy is enforcing. Set 0.0.0.0 only when the
  // proxy is on a different host (a container, for instance).
  bindHost: process.env.BIND_HOST || '127.0.0.1',

  secret: process.env.SECRET || '',
  opsPasscode: process.env.OPS_PASSCODE || '',

  housekeepingEmail: process.env.HOUSEKEEPING_EMAIL || '',
  dispatchCc: process.env.DISPATCH_CC || '',
  suppressionMinutes: int(process.env.SUPPRESSION_MINUTES, 30),

  // Where each kind of request goes. Engineering and supply fall back to
  // housekeeping when unset, so leaving them blank degrades to the previous
  // single-destination behaviour rather than dropping reports on the floor.
  departments: {
    housekeeping: process.env.HOUSEKEEPING_EMAIL || '',
    engineering: process.env.ENGINEERING_EMAIL || process.env.HOUSEKEEPING_EMAIL || '',
  },

  // How mail leaves the building.
  //
  //   resend  HTTPS API, sends from a domain you control. No password to
  //           expire, and unaffected by Microsoft retiring basic auth for
  //           SMTP AUTH at the end of 2026.
  //   smtp    Microsoft 365 mailbox + app password. Works today; has a
  //           deadline.
  //
  // Defaults to whichever is configured, preferring Resend.
  emailProvider: (process.env.EMAIL_PROVIDER
    || (process.env.RESEND_API_KEY ? 'resend' : 'smtp')).trim().toLowerCase(),

  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    // Must be on a domain verified in Resend. A display name is allowed:
    //   AMR Service Requests <notifications@amrservices300.com>
    from: process.env.RESEND_FROM || '',
    // Where a staff member's reply goes, since the sending address is a
    // notification identity rather than a monitored inbox.
    replyTo: process.env.REPLY_TO || '',
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },

  dryRun: bool(process.env.DRY_RUN, true),

  // Seeds the full AMR location list on first boot against an empty database.
  // Only meaningful once -- see src/bootstrap.js for the guards.
  autoSeed: bool(process.env.AUTO_SEED, false),

  // DATA_DIR lets the service keep its database on a persistent volume or a
  // backed-up path rather than inside the deployed application directory,
  // which a redeploy may replace wholesale.
  dbPath: process.env.DATABASE_PATH
    || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'service.db'),
  signsDir: process.env.SIGNS_DIR || path.join(__dirname, '..', 'signs'),
  timeZone: process.env.TZ_DISPLAY || 'America/New_York',
};

// Fail loudly at boot rather than mysteriously at 2am. A missing SECRET would
// silently make every MARK SERVICED link forgeable.
function assertReady() {
  const problems = [];
  if (!config.secret || config.secret.length < 32) {
    problems.push('SECRET is missing or too short (need >= 32 chars). Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  if (!config.opsPasscode) {
    problems.push('OPS_PASSCODE is missing -- the /ops dashboard would be unprotected.');
  }
  if (!config.dryRun && !config.housekeepingEmail) {
    problems.push('DRY_RUN=false but HOUSEKEEPING_EMAIL is blank -- requests would go nowhere.');
  }
  if (!config.dryRun) {
    if (config.emailProvider === 'resend') {
      if (!config.resend.apiKey) {
        problems.push('EMAIL_PROVIDER=resend but RESEND_API_KEY is blank.');
      }
      if (!config.resend.from) {
        problems.push('EMAIL_PROVIDER=resend but RESEND_FROM is blank. It must be an address\n'
          + '  on a domain verified in Resend, e.g.\n'
          + '  RESEND_FROM="AMR Service Requests <notifications@amrservices300.com>"');
      }
    } else if (!config.smtp.host) {
      problems.push('DRY_RUN=false but no email provider is configured -- dispatch emails\n'
        + '  would go nowhere. Set RESEND_API_KEY, or SMTP_HOST for Microsoft 365.');
    }
  }
  if (config.publicBaseUrl.includes('localhost') && !config.dryRun) {
    problems.push('DRY_RUN=false but PUBLIC_BASE_URL is still localhost -- the MARK SERVICED\n' +
      '  links in housekeeping\'s email would not resolve from their phones.');
  }
  return problems;
}

module.exports = { config, assertReady };
