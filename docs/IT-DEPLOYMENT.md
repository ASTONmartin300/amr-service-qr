# Deployment specification — AMR Service Requests

**Requested by:** Operations, Aston Martin Residences · operations@300miamicondo.com
**Application:** `amr-service-qr`
**Hostname requested:** `service.300miamicondo.com`

---

## Summary

A small internal web application. Residents scan a QR code posted in an
elevator cab or amenity area, tap one button, and housekeeping receives an email
with a one-tap "mark serviced" link that records the response time. Management
reviews open requests and response-time history on a passcode-protected page.

**35 QR codes** are being installed: 17 elevator cabs (S1–S5, P1–P9, P11, P12,
LULA) and 18 amenity locations.

It is roughly 900 lines of Node.js, three npm dependencies, and a SQLite file.
No database server, no message queue, no cache, no external API. It does not
handle payments, credentials, or personal data.

**We are asking IT to host and run it.** Operations owns the application and its
content; we are not asking IT to develop or support the code.

---

## What we need from IT

1. A host to run it on (VM, container host, or an existing web server).
2. DNS: `service.300miamicondo.com` resolving to that host.
3. A TLS certificate for that hostname and a reverse proxy in front of the app.
4. A backed-up path for the SQLite database.
5. Confirmation of the final hostname **before we print signage** — the URL is
   encoded into all 35 printed QR codes and cannot be changed afterwards
   without reprinting and reinstalling every sign.

Outbound SMTP to `smtp.office365.com:587` must be permitted. No inbound access
to the app host is needed beyond ports 80/443 on the reverse proxy.

---

## Requirements

| | |
|---|---|
| Runtime | **Node.js 24 or newer** (see note below), or Docker |
| Dependencies | `dotenv`, `nodemailer`, `qrcode` |
| Listens | TCP 8080, plain HTTP, loopback by default |
| TLS | Terminated at the reverse proxy; the app never handles certificates |
| Storage | One SQLite file. Tens of MB after years of use. |
| Memory | Under 100 MB resident |
| Outbound | `smtp.office365.com:587` only |

> **Node version matters.** The application uses Node's built-in `node:sqlite`
> module, which stopped requiring a flag in Node 23.4. On Node 22 LTS it will
> refuse to start unless you pass `NODE_OPTIONS=--experimental-sqlite`. The
> startup error says so explicitly. Node 24 is the clean choice.

---

## Option A — Docker (simplest)

A `Dockerfile` and `docker-compose.yml` are included and need no modification.

```bash
cp .env.example .env      # then edit -- see Configuration below
docker compose up -d
docker compose logs -f
```

The compose file publishes to `127.0.0.1:8080` only and stores the database in a
named volume (`service-qr-data`). It runs unprivileged and includes a
healthcheck that queries the app's own `/health` route, so the container
restarts if SQLite becomes unreadable rather than only if the process dies.

## Option B — systemd (Linux VM, no Docker)

A hardened unit file is included at `deploy/amr-service-qr.service`. It assumes
`/opt/amr-service-qr` owned by a service account `amrsvc`, with the database at
`/var/lib/amr-service-qr`.

```bash
sudo cp deploy/amr-service-qr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now amr-service-qr
journalctl -u amr-service-qr -f
```

The unit sets `ProtectSystem=strict` with a single `ReadWritePaths` entry, so
the service can write only its own data directory.

## Option C — Windows Server

Run it as a service with a wrapper such as NSSM or WinSW:

```
nssm install AMRServiceQR "C:\Program Files\nodejs\node.exe" "C:\apps\amr-service-qr\src\server.js"
nssm set AMRServiceQR AppDirectory C:\apps\amr-service-qr
nssm set AMRServiceQR AppStdout C:\apps\amr-service-qr\logs\out.log
nssm set AMRServiceQR AppStderr C:\apps\amr-service-qr\logs\err.log
```

Put IIS with ARR + URL Rewrite in front for TLS, forwarding to
`http://127.0.0.1:8080`. Set `DATA_DIR` to a path outside the application
directory so a redeploy cannot delete the database.

The application handles `SIGTERM` by draining in-flight requests before exiting,
so a service restart will not cut off a resident mid-request.

---

## Reverse proxy

An nginx example is included at `deploy/nginx.conf.example`. The essentials:

- Forward `/` to `http://127.0.0.1:8080`
- Set `X-Forwarded-Proto` and `X-Forwarded-For`
- Redirect HTTP to HTTPS; HSTS is appropriate
- `client_max_body_size 16k` — nothing here accepts an upload, and the largest
  legitimate request is a form post with one field

Optionally restrict `/ops` (the management dashboard) to the building or office
network. It is passcode-protected, but there is no reason for it to be reachable
from the public internet. Everything under `/r/` and `/done/` must stay publicly
reachable — those are the resident and housekeeping paths.

---

## Configuration

All configuration is one `.env` file. `.env.example` documents every value.

| Variable | Notes |
|---|---|
| `PUBLIC_BASE_URL` | `https://service.300miamicondo.com`. **Baked into every printed QR code.** |
| `PORT` / `BIND_HOST` | `8080` / `127.0.0.1` (use `0.0.0.0` inside a container) |
| `DATA_DIR` | Where the SQLite database lives. **This is the backup target.** |
| `SECRET` | 32+ random bytes. Signs staff links and dashboard sessions. |
| `OPS_PASSCODE` | Shared passcode for the `/ops` dashboard |
| `HOUSEKEEPING_EMAIL` | Distribution address that receives service requests |
| `SMTP_*` | Microsoft 365 SMTP AUTH — see below |
| `DRY_RUN` | `true` records requests without emailing. We will run this way during rehearsal. |

Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`.env` contains an SMTP password and the dashboard passcode. It should be mode
`0600` and owned by the service account, and it is excluded from source control.

The application validates its configuration at startup and **refuses to start**
with a specific error rather than running misconfigured — for example if
`DRY_RUN=false` while `PUBLIC_BASE_URL` still points at localhost, which would
put unreachable links in housekeeping's email.

### Email

The application sends through the existing `operations@300miamicondo.com`
mailbox using SMTP AUTH with an app password. This mechanism is already in use
by another Operations tool and works today — **no new mailbox permissions or
tenant changes are needed.**

If you would prefer it send via Microsoft Graph with a dedicated app
registration (`Mail.Send` scoped to the single mailbox), tell us and we will
switch. We have no preference; yours governs.

Verify delivery end to end before go-live:

```bash
npm run check -- --email someone@300miamicondo.com
```

This tests the SMTP login and sends a sample dispatch so the recipient can
confirm it renders and is not quarantined.

---

## Backup

**Back up `DATA_DIR`.** It holds two things:

1. Request history — useful, replaceable.
2. **The QR tokens.** Each of the 35 printed signs encodes a random token that
   only exists in this database. If it is lost and cannot be restored, every
   sign in the building becomes a dead link and all 35 must be reprinted and
   reinstalled.

A nightly file copy is sufficient. SQLite runs in WAL mode, so either stop the
service briefly or use `sqlite3 service.db ".backup"` for a consistent snapshot.

Retention: whatever your standard is. The data is operational, not regulated —
there is no personal data in it (see below).

## Monitoring

`GET /health` returns JSON and touches the database:

```json
{ "ok": true, "dryRun": false, "open": 2, "locations": 35 }
```

A non-200 or `ok: false` means the service needs attention. Alerting on it is
worthwhile: a failure is invisible to us but visible to residents standing in
front of a QR code that does nothing.

Logs go to stdout/stderr (journald, Docker logs, or the NSSM log files). One
line per request filed and per request closed. Nothing sensitive is logged.

---

## Data stored

Per request: the location, the time reported, open or completed, the completion
time, and a count of repeat scans.

Per location: a random token, English and Spanish labels, the department, and
whether it is active.

**No resident data is collected or stored** — no name, unit number, email,
phone, IP address, user agent, or cookie. The database schema has no column for
any of it, so this is a structural property rather than a policy that a future
change could quietly reverse.

The only per-source data anywhere is an in-memory rate-limit counter with a
sixty-second window, held in process memory to stop the endpoint being scripted.
It is never written to disk and is lost on restart.

We are specific about this because the printed signage states "no information or
registration required," and we would like that to be verifiable.

## Security notes

- QR codes encode a random seven-character token, not a guessable identifier
  like `/elevator/P3`, so the URL cannot be edited to file a request against a
  different location.
- "Mark serviced" links are HMAC-signed, expire after seven days, and close only
  an open request. A forwarded or replayed link is inert.
- The dashboard session is an HMAC-signed, HttpOnly, SameSite=Lax cookie, marked
  Secure when `PUBLIC_BASE_URL` is HTTPS. Login is rate-limited and the passcode
  comparison is constant-time.
- Every location has a remote kill switch. If a QR code is photographed and
  circulated, Operations deactivates it in one command — no reprint, no
  redeployment, no IT involvement.
- No file upload, no resident-supplied text stored anywhere, no third-party
  scripts, fonts, or analytics. The pages make zero external requests, which is
  also why they load on marginal cellular signal inside an elevator.
- The application serves nothing at its root and sets `noindex`.

Source is available for review before deployment on request.

---

## What we need back

1. **Final hostname**, confirmed and resolving. We cannot print until this is
   fixed — it is encoded in all 35 QR codes.
2. **Which option** (A, B, or C) and where it will run.
3. **A maintenance window expectation** — how restarts and patching will be
   handled, so we can tell residents nothing.
4. **Confirmation that `DATA_DIR` is in the backup rotation.**

Operations will handle seeding the 35 locations, generating the QR codes, and
producing the printed signage once the hostname is final.

Thank you.
