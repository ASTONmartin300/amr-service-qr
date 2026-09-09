// Preflight. Run this before going live, and again any time something feels
// wrong -- it is faster than guessing which of six things broke.
//
//   npm run check
//   npm run check -- --email you@example.com    also sends a real test dispatch
'use strict';

const nodemailer = require('nodemailer');
const { config, assertReady } = require('../src/config');
const store = require('../src/db');
const { buildDispatch, sendViaResend } = require('../src/mailer');

const args = process.argv.slice(2);
const testEmail = args.includes('--email') ? args[args.indexOf('--email') + 1] : null;

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const note = (m) => console.log(`  ..    ${m}`);

async function main() {
  console.log('\nAMR Service Requests -- preflight\n');

  // 1. Config
  const problems = assertReady();
  if (problems.length) problems.forEach((p) => bad(p.split('\n')[0]));
  else ok('Config: SECRET and OPS_PASSCODE are set');

  // 2. Public URL
  if (config.publicBaseUrl.includes('localhost')) {
    note(`PUBLIC_BASE_URL is ${config.publicBaseUrl} -- local testing only, do not print QR codes yet`);
  } else if (!config.publicBaseUrl.startsWith('https://')) {
    bad(`PUBLIC_BASE_URL is not https. Phones will warn residents about an insecure page.`);
  } else {
    ok(`Public URL: ${config.publicBaseUrl}`);
  }

  // 3. Database
  const locations = store.listLocations();
  const active = locations.filter((l) => l.active);
  if (!locations.length) bad('No locations. Run "npm run seed -- --elevators 6".');
  else ok(`Database: ${locations.length} location(s), ${active.length} active`);

  const open = store.openRequests();
  if (open.length) {
    note(`${open.length} request(s) currently open:`);
    for (const r of open) {
      const mins = Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000);
      note(`   ${r.label_en} -- waiting ${mins} min`);
    }
  }

  // 4. Email delivery
  //
  // A --email test send runs even under DRY_RUN. Otherwise delivery could only
  // ever be proven by going live first, which is the wrong order: you would be
  // flipping the switch on 44 signs while still guessing whether the mail
  // works. The operator typed a specific address, so honour it.
  if (config.dryRun) {
    note('DRY_RUN=true -- real requests are recorded but staff are NOT emailed');
    if (testEmail) {
      note(`--email given: sending one test to ${testEmail} anyway, so you can`);
      note('   confirm delivery before going live');
    } else {
      note('Add --email you@example.com to prove delivery works before go-live');
    }
  }

  if (config.dryRun && !testEmail) {
    // Nothing to verify: no send requested and none would happen.
  } else if (config.emailProvider === 'resend') {
    if (!config.resend.apiKey) {
      bad('EMAIL_PROVIDER=resend but RESEND_API_KEY is blank');
    } else if (!config.resend.from) {
      bad('EMAIL_PROVIDER=resend but RESEND_FROM is blank');
    } else {
      ok(`Resend: sending as ${config.resend.from}`);
      if (config.resend.replyTo) ok(`Replies go to: ${config.resend.replyTo}`);
      else note('REPLY_TO is blank -- a staff reply to a dispatch would go nowhere');

      if (testEmail && active.length) {
        // Request id 0 never matches a real row, so the test MARK SERVICED
        // link is inert rather than closing a live request.
        const message = buildDispatch(
          { id: 0, type: 'cleaning', created_at: new Date().toISOString() },
          active[0],
        );
        try {
          await sendViaResend({
            to: testEmail,
            message: { ...message, subject: `[TEST] ${message.subject}` },
          });
          ok(`Test dispatch sent to ${testEmail} -- check it arrives and is not in Junk`);
        } catch (err) {
          bad(`Test send failed: ${err.message}`);
          note('A 403 usually means the sending domain is not verified yet in Resend.');
          note('Resend -> Domains -> amrservices300.com must show Verified.');
        }
      } else if (!testEmail) {
        note('Add --email you@example.com to send a real test dispatch');
      }
    }
  } else if (!config.smtp.host) {
    bad('DRY_RUN=false but no email provider is configured -- requests would go nowhere');
  } else {
    const tx = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
    try {
      await tx.verify();
      ok(`SMTP: connected to ${config.smtp.host}:${config.smtp.port} as ${config.smtp.user}`);
    } catch (err) {
      bad(`SMTP: ${err.message}`);
      note('If M365 rejects the login, the mailbox needs "Authenticated SMTP" enabled');
      note('and the password must be an app password (requires MFA on the account).');
    }

    if (testEmail && active.length) {
      // Uses request id 0, which no real row will ever have, so the test
      // MARK SERVICED link is inert rather than closing a live request.
      const message = buildDispatch(
        { id: 0, created_at: new Date().toISOString() },
        active[0],
      );
      try {
        await tx.sendMail({
          from: config.smtp.from, to: testEmail,
          subject: `[TEST] ${message.subject}`, text: message.text, html: message.html,
        });
        ok(`Test dispatch sent to ${testEmail} -- check it renders and the button looks right`);
      } catch (err) {
        bad(`Test send failed: ${err.message}`);
      }
    }
  }

  // 5. Dispatch routing -- show every destination, not just housekeeping.
  // A repair quietly going to the cleaning inbox is the failure nobody notices.
  if (!config.dryRun && !config.housekeepingEmail) {
    bad('HOUSEKEEPING_EMAIL is blank');
  } else if (config.housekeepingEmail) {
    ok(`Cleaning + resupply -> ${config.housekeepingEmail}`);
    const eng = config.departments.engineering;
    if (eng && eng !== config.housekeepingEmail) {
      ok(`Broken items      -> ${eng}`);
    } else {
      note(`Broken items      -> ${config.housekeepingEmail} (ENGINEERING_EMAIL not set,`);
      note('   so repairs go to housekeeping too)');
    }
    if (config.dispatchCc) ok(`Copied on all      -> ${config.dispatchCc}`);
  }

  console.log(
    failures
      ? `\n${failures} problem(s) to fix before going live.\n`
      : `\nAll checks passed. Mode: ${config.dryRun ? 'DRY_RUN' : 'LIVE'}\n`,
  );
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
