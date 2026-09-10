// End-to-end smoke test against a running server. Exercises the whole path a
// resident and housekeeping actually take, including the two behaviours that
// are easy to break and hard to notice: duplicate suppression, and single-use
// MARK SERVICED links.
//
//   npm start          (in one terminal)
//   node test/smoke.js (in another)
//
// Safe to run against DRY_RUN=true. Do NOT run it against a live server --
// it files real requests.
'use strict';

const store = require('../src/db');
const { config } = require('../src/config');
const { servicedUrl, recipientFor } = require('../src/mailer');

const BASE = `http://localhost:${config.port}`;
let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function main() {
  console.log('\nSmoke test\n');

  if (!config.dryRun) {
    console.error('  Refusing to run: DRY_RUN is false. This would email housekeeping.\n');
    process.exit(1);
  }

  const location = store.listLocations().find((l) => l.active);
  if (!location) {
    console.error('  No active locations. Run "npm run seed -- --elevators 4".\n');
    process.exit(1);
  }
  console.log(`  Using ${location.label_en} (/r/${location.token})\n`);

  // Clear prior state so the run is repeatable.
  store.db.prepare('DELETE FROM requests WHERE location_id = ?').run(location.id);

  // 1. Confirm page renders, in both languages. A location offering more than
  //    one service labels its buttons by service; a single-service one keeps
  //    the generic wording.
  const en = await fetch(`${BASE}/r/${location.token}`);
  const enHtml = await en.text();
  check('Confirm page loads',
    en.status === 200
      && (enHtml.includes('Request service') || enHtml.includes('Needs cleaning')));

  const es = await fetch(`${BASE}/r/${location.token}?lang=es`);
  const esHtml = await es.text();
  check('Spanish confirm page',
    esHtml.includes('Solicitar servicio') || esHtml.includes('Necesita limpieza'));

  check('No resident data requested on the page',
    !/<input[^>]+type=["']?(text|email|tel)/i.test(enHtml),
    'The confirm page should have no text inputs at all.');

  // 2. Filing a request.
  const post = await fetch(`${BASE}/r/${location.token}`, { method: 'POST' });
  const postHtml = await post.text();
  check('Request files and shows thank-you',
    post.status === 200 && postHtml.includes('has been notified'));

  await new Promise((r) => setTimeout(r, 250)); // email is sent after the response
  const request = store.latestRequestForLocation(location.id);
  check('Request stored as open', request && request.status === 'open');
  check('Email marked dry_run', request && request.email_status === 'dry_run',
    `email_status was "${request && request.email_status}"`);

  // 3. Duplicate suppression -- the behaviour that keeps housekeeping from
  //    receiving fifteen emails about one elevator.
  const second = await fetch(`${BASE}/r/${location.token}`, { method: 'POST' });
  const secondHtml = await second.text();
  check('Second scan is suppressed', secondHtml.includes('already been reported'));

  const after = store.latestRequestForLocation(location.id);
  check('No duplicate request row', after.id === request.id);
  check('Re-scan counted', after.suppressed_scans === 1,
    `suppressed_scans was ${after.suppressed_scans}`);

  // 4. MARK SERVICED.
  const doneUrl = servicedUrl(request.id);
  const done = await fetch(doneUrl);
  const doneHtml = await done.text();
  check('MARK SERVICED closes the request',
    done.status === 200 && doneHtml.includes('Marked serviced'));

  const closed = store.getRequest(request.id);
  check('Completion time recorded', closed.status === 'completed' && !!closed.completed_at);

  // 5. Replaying the same link must not reopen or double-close it.
  const replayHtml = await (await fetch(doneUrl)).text();
  check('Replayed link is a no-op', replayHtml.includes('Already closed'));

  // 6. A tampered link must be rejected.
  const tampered = doneUrl.slice(0, -4) + 'aaaa';
  const tamperedHtml = await (await fetch(tampered)).text();
  check('Tampered link rejected', tamperedHtml.includes('not valid'));

  // 7. Unknown and inactive tokens.
  const unknown = await fetch(`${BASE}/r/zzzzzzz`);
  check('Unknown token 404s', unknown.status === 404);

  store.setLocationActive(location.token, false);
  const inactiveHtml = await (await fetch(`${BASE}/r/${location.token}`)).text();
  check('Deactivated sign stops dispatching', inactiveHtml.includes('not currently active'));
  store.setLocationActive(location.token, true);

  // 8. Dashboard is not readable without the passcode.
  const ops = await (await fetch(`${BASE}/ops`)).text();
  check('Dashboard requires passcode', ops.includes('Passcode') && !ops.includes('Median response'));

  // 9. Health endpoint, for whatever watches the machine.
  const health = await (await fetch(`${BASE}/health`)).json();
  check('Health endpoint reports state', health.ok === true && typeof health.open === 'number');

  // --- seeded service options ---------------------------------------------
  //
  // Regression guard. First-boot seeding once failed to pass services through,
  // so every location came up cleaning-only. Nothing broke visibly: the site
  // worked, requests dispatched. It only showed as one button instead of three
  // and wrong wording on the printed sign -- discoverable after lamination.
  const seeded = store.listLocations();
  const multiService = seeded.filter((l) => String(l.services).includes(','));
  check('Seeded locations carry their service options',
    multiService.length > 0,
    'Every location is single-service. Seeding dropped the services column.');

  const supplyPoint = seeded.find((l) => l.kind === 'supply');
  if (supplyPoint) {
    check('Supply points are not seeded as cleaning',
      !String(supplyPoint.services).includes('cleaning'),
      `${supplyPoint.label_en} offers "${supplyPoint.services}" -- a dispenser should never ask to be cleaned.`);
  }

  // --- request types ------------------------------------------------------

  const multi = store.listLocations().find(
    (l) => l.active && String(l.services).split(',').length > 2,
  );

  if (!multi) {
    check('A multi-service location exists to test', false,
      'Seed the building first: npm run seed -- --building');
  } else {
    console.log(`\n  Using ${multi.label_en} (${multi.services})\n`);
    store.db.prepare('DELETE FROM requests WHERE location_id = ?').run(multi.id);

    const page = await (await fetch(`${BASE}/r/${multi.token}`)).text();
    check('Confirm page offers every service',
      page.includes('Needs cleaning') && page.includes('Something is broken')
        && page.includes('Out of supplies'));

    const post = (type) => fetch(`${BASE}/r/${multi.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(type ? { type } : {}),
    });

    await post('repair');
    await new Promise((r) => setTimeout(r, 200));
    const repair = store.latestRequestForLocation(multi.id, 'repair');
    check('Repair request records its type', repair && repair.type === 'repair');

    check('Repair routes to engineering',
      recipientFor({ type: 'repair' }, { notify_email: null })
        === (config.departments.engineering || config.housekeepingEmail));
    check('Cleaning routes to housekeeping',
      recipientFor({ type: 'cleaning' }, { notify_email: null })
        === config.housekeepingEmail);

    // The important one. A broken light must still reach engineering even
    // though the same room was reported dirty a moment ago.
    const second = await (await post('cleaning')).text();
    check('An open repair does not suppress cleaning',
      second.includes('Housekeeping has been notified')
        || second.includes('right team has been notified'),
      'Cleaning was swallowed by the open repair request.');

    const cleaning = store.latestRequestForLocation(multi.id, 'cleaning');
    check('Cleaning stored as its own request',
      cleaning && cleaning.type === 'cleaning' && cleaning.id !== repair.id);

    // ...but a second repair, while one is open, is still suppressed.
    const dupe = await (await post('repair')).text();
    check('A repeated repair is still suppressed', dupe.includes('already been reported'));

    // A hand-crafted POST must not raise a type the sign does not offer.
    const cleanOnly = store.listLocations().find(
      (l) => l.active && String(l.services) === 'cleaning,repair',
    );
    if (cleanOnly) {
      store.db.prepare('DELETE FROM requests WHERE location_id = ?').run(cleanOnly.id);
      await fetch(`${BASE}/r/${cleanOnly.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ type: 'supply' }),
      });
      await new Promise((r) => setTimeout(r, 150));
      const forged = store.latestRequestForLocation(cleanOnly.id);
      check('An unoffered type cannot be forged',
        forged && forged.type !== 'supply',
        `Got type "${forged && forged.type}" from a location offering ${cleanOnly.services}.`);
      store.db.prepare('DELETE FROM requests WHERE location_id = ?').run(cleanOnly.id);
    }

    // The dog bag dispenser should never ask to be cleaned.
    const dispenser = store.listLocations().find((l) => l.kind === 'supply');
    if (dispenser) {
      const dp = await (await fetch(`${BASE}/r/${dispenser.token}`)).text();
      check('Supply point offers no cleaning option', !dp.includes('Needs cleaning'));
    }

    store.db.prepare('DELETE FROM requests WHERE location_id = ?').run(multi.id);
  }

  // --- resupply picker, closed-by, escalation, digest, backup ---------------
  const sched = require('../src/scheduler');
  const restroom = store.listLocations().find((l) => /Restroom/.test(l.label_en) && l.supplies);

  if (!restroom) {
    check('A location with supply items exists', false, 'Seed the building: npm run seed -- --building');
  } else {
    console.log(`\n  Using ${restroom.label_en} (${restroom.supplies})\n`);
    store.db.prepare('DELETE FROM requests WHERE location_id = ?').run(restroom.id);
    const post = (body) => fetch(`${BASE}/r/${restroom.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });

    const picker = await (await post({ type: 'supply' })).text();
    check('Resupply asks what is out', picker.includes('What is running low') && picker.includes('Toilet paper'));
    check('Picker still collects nothing typed', !/<input[^>]+type=["']?(text|email|tel)/i.test(picker));
    check('Nothing filed until an item is chosen', !store.latestRequestForLocation(restroom.id, 'supply'));

    await post({ type: 'supply', detail: 'toilet-paper' });
    await new Promise((r) => setTimeout(r, 200));
    const supplyReq = store.latestRequestForLocation(restroom.id, 'supply');
    check('Chosen item stored on the request', supplyReq && supplyReq.detail === 'Toilet paper',
      `detail was "${supplyReq && supplyReq.detail}"`);

    // Closing through the department-stamped link records who did it.
    await fetch(servicedUrl(supplyReq.id, 'housekeeping'));
    check('Close link records the team', store.getRequest(supplyReq.id).closed_by === 'housekeeping',
      `closed_by was "${store.getRequest(supplyReq.id).closed_by}"`);

    // Escalation: backdate an open request and run the job directly.
    const old = store.createRequest(restroom.id, 'cleaning');
    const backdate = (min) => store.db.prepare('UPDATE requests SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - min * 60000).toISOString(), old.id);

    backdate(45);
    await sched.runEscalations();
    check('45-minute-old request escalates to level 1', store.getRequest(old.id).escalation_level === 1,
      `level=${store.getRequest(old.id).escalation_level}`);

    const again = await sched.runEscalations();
    check('Escalation is not repeated', again === 0 && store.getRequest(old.id).escalation_level === 1);

    backdate(75);
    await sched.runEscalations();
    check('75-minute-old request escalates to level 2', store.getRequest(old.id).escalation_level === 2);

    store.db.prepare('DELETE FROM requests WHERE location_id = ?').run(restroom.id);
  }

  const digest = sched.buildDigest();
  check('Weekly digest builds', digest.subject.startsWith('Service requests') && digest.html.includes('Median'));

  const snap = sched.snapshotDatabase();
  check('Backup snapshot is a valid SQLite file',
    snap.content.subarray(0, 15).toString() === 'SQLite format 3' && snap.filename.endsWith('.db'));

  console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  Could not reach ${BASE} -- is the server running? ("npm start")\n`);
  console.error(err.message);
  process.exit(1);
});
