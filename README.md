# AMR Service Requests

QR-code service dispatch for Aston Martin Residences. A resident scans a code in
an elevator or amenity area, taps one button, and housekeeping is emailed.
Housekeeping taps **MARK SERVICED** when the work is done, which records the
response time.

Built from James Olacio's 2026-08-26 "QR scan reporting" concept.

**35 locations, building-wide:** 17 elevator cabs (S1-S5, P1-P9, P11, P12, LULA)
and 18 amenity areas. The full list, with Spanish labels, is
[scripts/amr-building.js](scripts/amr-building.js) -- that file is the source of
truth, and re-running the seed after editing it adds only what is new.

Runs as a hosted service. Two paths, pick one:

- **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)** — buy a $6/month server and install it
  yourself, no IT involvement. Start here if you want control.
- **[docs/IT-DEPLOYMENT.md](docs/IT-DEPLOYMENT.md)** — hand this to the IT company and
  let them run it. Start here if you would rather not own a Linux box.

---

## What a resident sees

1. Scans the QR in the cab or the room.
2. A page opens in English or Spanish: *"Request housekeeping service — Residential Elevator P3"* with one button.
3. Taps it. *"Thank you. Housekeeping has been notified."*

No name, unit number, phone, email, or account. Nothing to type. The location's
identity is in the QR, so the resident never picks from a list of thirty-five.

If that location was already reported, the button is replaced with *"This
location has already been reported."* — so one dirty elevator cannot generate
fifteen emails.

## What housekeeping sees

An email: **SERVICE REQUEST — Residential Elevator P3**, with the time, the
location, and one **MARK SERVICED** button. Tapping it closes the request and
stamps the completion time. The link is signed and single-use — forwarding the
email cannot reopen or falsely close anything.

## What management sees

`/ops` — open requests with a Mark serviced button, then per-location volume and
response times over 30 days, then full history. This is the artifact for the
Board.

---

## First run

```bash
npm install
cp .env.example .env
```

Then edit `.env`:

```bash
# generate a SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set `SECRET`, `OPS_PASSCODE`, and `HOUSEKEEPING_EMAIL`. Leave `DRY_RUN=true` and
`SMTP_HOST=` blank for now — nothing will be emailed while you test.

```bash
npm run seed -- --building        # all 35 AMR locations
npm start
```

Open http://localhost:8080/ops and sign in with your `OPS_PASSCODE`.
`npm run locations` prints every scan URL so you can try one in a browser.

---

## Going live

In order. Steps 1 and 2 are the ones that cost real money if skipped.

**1. Confirm cell signal in every elevator cab.**
Stand in each of the seventeen cabs, doors closed, and load any web page on your
phone. If it does not load, the QR will not work and no amount of software fixes
it. This is the single biggest risk in the project. Amenity areas are almost
certainly fine; the cabs are the question.

**2. Fix the hostname before printing anything.**
Hand [docs/IT-DEPLOYMENT.md](docs/IT-DEPLOYMENT.md) to IT — it covers
requirements, three deployment options, reverse proxy, backup, and monitoring.
Once they confirm the hostname:

```bash
PUBLIC_BASE_URL=https://service.300miamicondo.com
```

That string is encoded into all 35 QR images. Changing it later means
reprinting and reinstalling every sign in the building.

**3. Turn on email.**
Copy `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` from
`../reservation-bot/.env` — the same M365 app password already works. Set
`SMTP_FROM` to that mailbox.

```bash
npm run check -- --email you@300miamicondo.com
```
This verifies the SMTP login and sends a sample dispatch so you can confirm it
renders and the MARK SERVICED button works before housekeeping ever sees one.

**4. Seed the building on the production host.**
```bash
npm run seed -- --building
```
Seed on the server, not locally — the tokens live in that database and cannot be
regenerated without invalidating printed signs. Confirm 35 locations:
17 elevators, 18 amenities.

**5. Generate and print the signs.**
```bash
npm run qr                            # 35 PNG + SVG, into signs/
npm run signs                         # signs/signs.html
npm run signs -- --kind elevator      # or print in phases
```
Open `signs.html` and print at 100% scale, or Save as PDF for the printer. Each
sign is 5×7in with a small grey location name at the bottom, so whoever installs
them cannot put the Grand Cinema code in the Small Cinema.

**6. Rehearse with DRY_RUN on.**
Leave `DRY_RUN=true` and walk the building scanning all 35 signs. Confirm the
right location name appears every single time — this is the step that catches a
sign installed in the wrong room, and it is far cheaper to catch now than after
housekeeping has been sent to the wrong floor twice.

**7. Go live.** Set `DRY_RUN=false` and restart the service.

---

## Day to day

```bash
npm run locations                          # every sign, its URL, its last request
npm run locations -- --off  <token>        # kill switch: sign stops dispatching
npm run locations -- --on   <token>
npm run locations -- --email <token> <addr>  # route one sign to a different team
npm run check                              # is anything broken?
npm test                                   # end-to-end, DRY_RUN only

node scripts/split-signs.js   "<sheet>.html"  # one PDF per full sign, named by location
node scripts/split-qr-only.js "<sheet>.html"  # one PDF per bare QR code, for a sign vendor
```

Both read the sheet you download from `/ops/signs`, so the codes are the live
ones. `split-signs` refuses a sheet whose wording predates the current copy;
`split-qr-only` does not care about wording, only codes.

The printed QR never changes. Deactivating a location leaves the sticker on the
wall, still resolving, but showing "not currently active" instead of dispatching
— use it during elevator modernization, when an amenity closes for renovation,
or if a code gets photographed and passed around.

### What happens on its own

Three jobs run inside the service, once a minute, and record what they have
done in the database so a restart never repeats an email.

| Job | When | Goes to |
|---|---|---|
| **Escalation** | A request still open after 30 minutes, then again at 60 | `ESCALATE_TO` (front desk), then `ESCALATE_AGAIN_TO` (manager) |
| **Weekly digest** | Monday 07:00 building time | `DIGEST_TO` — requests, response times, re-scans, by location and team |
| **Monthly backup** | 1st of the month, 06:00 | `BACKUP_TO` — the database file, attached. Keep these emails. |

All three fall back to `MANAGER_EMAIL`, then `DISPATCH_CC`, so a minimal
`.env` still routes them somewhere. Preview the digest, or send either the
digest or the backup immediately, at `/ops/digest`.

An escalated request shows an `L1` or `L2` badge in the dashboard's Open
section. The history table's **By** column shows which team closed each
request — janitorial, maintenance, or the dashboard — which is what lets
response times be compared by team.

### Resupply picker

At locations stocked with consumables, tapping **Out of supplies** asks one
more question — *Towels? Water?* — before filing. Still one tap, still nothing
typed. The chosen item goes in the email subject, so janitorial knows what to
bring. Items are set per location in [scripts/amr-building.js](scripts/amr-building.js)
(restrooms get paper and soap, pools and cabanas get towels and water, the
dog station gets bags) and synced by the seed.

### External uptime monitoring

Nothing in the app can tell you the app is down. Use a free external monitor:

1. [uptimerobot.com](https://uptimerobot.com) → sign up → **Add New Monitor**
2. Type **HTTP(s)**, URL `https://amrservices300.com/health`, interval 5 minutes
3. Alert contact: your email

`/health` returns `{"ok":true,...}` and touches the database, so it fails if
SQLite becomes unreadable, not only if the process dies.

### Adding a location

Add a line to [scripts/amr-building.js](scripts/amr-building.js) and re-run the
seed. Anything already present is skipped by name, so only the new sign is
created and no existing token changes:

```bash
npm run seed -- --building
npm run qr
npm run signs
```

Amenity restrooms and locker rooms are the obvious next additions — they are the
highest-value housekeeping QR in any building and are not in the current list.

### Routing to a different department

Everything currently dispatches to housekeeping. Several locations are more
likely to generate engineering calls than cleaning ones — the golf simulator,
putting green, both cinemas, the business center, the fitness center. Re-routing
is per location and takes effect immediately:

```bash
npm run locations -- --email <token> engineering@300miamicondo.com
```

Worth revisiting once 30 days of real requests show what people actually report
from each room.

---

## What is stored

Per request: which location, when it was created, whether it is open or
completed, when it was completed, and how many people re-scanned it while it was
open.

Per location: a random token, the English and Spanish label, the department, and
whether it is active.

**Nothing about the resident.** No IP address, no user agent, no cookie, no unit
number, no timestamp tied to a person. The anonymity promised on the sign is
structural — the schema has nowhere to put resident identity, so no future
change can quietly start collecting it. The one exception is an in-memory rate
limiter that counts requests per source for sixty seconds to stop the endpoint
being scripted; it is never written to disk and disappears on restart.

---

## Layout

```
src/
  server.js    HTTP + routing
  db.js        node:sqlite schema and queries
  views.js     every page a resident or staff member sees
  mailer.js    dispatch email + MARK SERVICED link
  tokens.js    random QR tokens, HMAC-signed links and sessions
  i18n.js      English and Spanish resident copy
  config.js    .env loading and startup validation
scripts/
  amr-building.js  every AMR location -- the source of truth
  seed.js          create locations
  qr.js            QR images
  signs.js         print-ready sign sheet
  locations.js     list / activate / deactivate / re-route
  check.js         preflight, SMTP test
test/
  smoke.js     end-to-end, including suppression and link replay
deploy/
  amr-service-qr.service   hardened systemd unit
  nginx.conf.example       reverse proxy
docs/
  IT-DEPLOYMENT.md         hand this to IT
Dockerfile, docker-compose.yml
data/          sqlite database (git-ignored)
signs/         generated QR and signs (git-ignored)
```

Requires **Node 24+** — `node:sqlite` only stopped requiring a flag in Node 23.4,
and the app fails at startup with an explicit message on anything older. Three
npm dependencies: `dotenv`, `nodemailer`, `qrcode`. No native modules.

---

## If something breaks

**No email arrives.** `npm run check`. Most likely `DRY_RUN` is still `true`, or
the M365 app password expired. The request is still recorded either way — check
`/ops`, nothing is lost.

**MARK SERVICED says "not valid".** The link is older than 7 days, or `SECRET`
changed. Close it from `/ops` instead.

**A resident says the QR does nothing.** Check cell signal in that cab first —
that is the usual answer. Then `GET /health`, then whether that location was
deactivated (`npm run locations`).

**Wrong location name after scanning.** A sign was installed in the wrong room.
The grey label at the bottom of each sign says where it belongs; compare and
swap the physical signs. Do not re-seed — that mints new tokens and invalidates
the printed codes.

**Everything is down.** Nothing queues on the resident's phone; they see a
browser error, so an outage is visible to residents rather than to us. `/health`
is the thing to alert on — IT has the details.

**Lost the database.** Every printed QR token lived there. If there is no
backup, all 35 signs must be reseeded, reprinted, and reinstalled. This is why
`DATA_DIR` being in the backup rotation is called out to IT explicitly.
