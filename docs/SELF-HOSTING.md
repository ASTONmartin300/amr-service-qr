# Setting this up yourself, without IT

A complete walkthrough: buy a server, install the application, print the signs,
go live. Budget about **90 minutes** the first time and **$6–8/month plus
~$12/year** for the domain.

## Before you start — is this the right path?

You will be administering a Linux server. That means you are responsible for
patching it, noticing when it breaks, and restoring it if it dies. It is not
hard — the install below is largely one script — but it is a standing
commitment, not a one-time task.

Two smaller asks that avoid most of that, worth ruling out first:

- **Ask IT for one DNS record only.** Not hosting, not a server — a single
  `A` record pointing `service.300miamicondo.com` at an IP you give them. That
  is a two-minute request, and you keep control of everything else. It is a much
  smaller ask than the one you already made.
- **Use a managed platform instead of a VPS.** Railway or Render will run this
  with no server to patch, for roughly the same money. You give up shell access
  and some control. See the last section.

If you still want your own server, continue. It is a legitimate choice and the
one that gives you the most control.

---

## What you need

| | Cost | Notes |
|---|---|---|
| A domain | ~$12/year | You cannot use `300miamicondo.com` — IT controls it |
| A server | ~$6/month | DigitalOcean, Hetzner, Vultr, Linode all work |
| M365 app password | free | The one already working for the reservation bot |

A note on the domain: a printed sign in an Aston Martin Residences elevator
reading `amr-service.up.railway.app` looks like a science project. Spend the $12
on something like `amrservice.com` or `300service.com`. This is the one place
where the cheap option is visibly cheap.

---

## Step 1 — Buy a domain (10 minutes)

Use **Cloudflare Registrar** (sells at cost, no upsells, no renewal price jump)
or Namecheap.

1. Go to [cloudflare.com](https://cloudflare.com), create an account
2. **Domain Registration → Register Domain**
3. Search for something short and obvious: `amrservice.com`, `300service.com`
4. Buy it. Cloudflare manages DNS automatically.

Write down the domain. You will need it twice below, and it gets printed into
all 35 QR codes.

## Step 2 — Buy a server (10 minutes)

**DigitalOcean** is the easiest to start with.

1. [digitalocean.com](https://digitalocean.com) → sign up
2. **Create → Droplet**
3. Choose:
   - **Region:** New York (closest to Miami of their US options)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/month** (1 GB RAM). This application uses
     under 100 MB; the smallest droplet is genuinely enough.
   - **Authentication:** **SSH Key** if you have one, otherwise Password. Write
     the password down — you will need it in a minute.
   - **Hostname:** `amr-service`
4. **Create Droplet.** Wait about 60 seconds.
5. Copy the **IP address** shown (e.g. `164.92.10.55`).

> Hetzner is roughly half the price for the same specs if you would rather. The
> instructions below are identical; only the signup differs.

## Step 3 — Point the domain at the server (5 minutes)

Back in Cloudflare, open your new domain → **DNS → Records → Add record**:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `@` |
| IPv4 address | your droplet's IP |
| Proxy status | **DNS only** (grey cloud, not orange) |

Add a second record so `www` works too:

| Type | Name | Target | Proxy |
|---|---|---|---|
| `CNAME` | `www` | `amrservice.com` | DNS only |

**Turn the orange cloud off.** With Cloudflare proxying on, the server cannot
complete the certificate check in step 6 and the install will stall.

Wait 2–3 minutes, then confirm from PowerShell on your PC:

```bash
nslookup amrservice.com
```

It should return your droplet's IP. If it does not, wait another few minutes
before continuing — everything after this depends on it.

## Step 4 — Connect to the server (5 minutes)

Windows has SSH built in. Open **PowerShell** and:

```bash
ssh root@YOUR_DROPLET_IP
```

Type `yes` when it asks about the fingerprint, then your password. You are now
on the server. The prompt changes to something like `root@amr-service:~#`.

## Step 5 — Upload the application (3 minutes)

From **a second PowerShell window on your PC** (leave the SSH one open), from
inside your `Claude Folder`.

Package it first. This deliberately leaves out `node_modules` (the server
installs its own), your local test database (the server seeds fresh tokens), and
your local `.env` (which holds a test passcode and localhost settings that would
be wrong on a server):

```bash
tar -czf service-qr-upload.tar.gz --exclude=node_modules --exclude=data --exclude=signs --exclude=.env service-qr
```

That produces a ~50 KB file. Send it up and unpack it:

```bash
scp service-qr-upload.tar.gz root@YOUR_DROPLET_IP:/root/
```

```bash
ssh root@YOUR_DROPLET_IP "cd /root && tar -xzf service-qr-upload.tar.gz && ls service-qr"
```

You should see the file listing. If `tar` is not recognised, you are on an old
Windows build — use `scp -r service-qr root@YOUR_DROPLET_IP:/root/` instead and
expect it to take several minutes.

## Step 6 — Run the installer (15 minutes)

Back in the **SSH window**:

```bash
cd /root/service-qr && sudo bash deploy/setup-ubuntu.sh
```

It installs Node 24, Caddy, and the service, then asks you six questions:

| Prompt | What to enter |
|---|---|
| Domain | `amrservice.com` — no `https://`, no trailing slash |
| Housekeeping email | the distribution address that should receive requests |
| Copy requests to | `operations@300miamicondo.com`, or blank |
| Mailbox to send FROM | the M365 mailbox — same as `SMTP_USER` in `reservation-bot\.env` |
| App password | same as `SMTP_PASS` in that file |
| Dashboard passcode | anything you can share with management |

Then it finishes on its own: firewall, HTTPS certificate, service start, and
seeding all 35 locations.

When it prints **"Service is up"**, open `https://amrservice.com/ops` in a
browser and sign in with your passcode. You should see the dashboard, and
**Locations & signs** should list 35 locations — 17 elevators, 18 amenities.

> It starts in **DRY_RUN** mode on purpose. Requests are recorded but
> housekeeping is not emailed yet. That is what you want until step 9.

## Step 7 — Test the email (5 minutes)

```bash
cd /opt/amr-service-qr && sudo -u amrsvc npm run check -- --email you@300miamicondo.com
```

This verifies the M365 login and sends you a sample dispatch. Open it on your
phone and confirm the **MARK SERVICED** button looks right and is not sitting in
Junk. If the SMTP login fails, the app password has probably expired — generate
a new one in the Microsoft 365 admin center and update `/opt/amr-service-qr/.env`.

## Step 8 — Print and install the signs (however long the printer takes)

1. Sign in to `https://amrservice.com/ops/locations`
2. **Print all signs** — or do it in phases with **Elevators only**
3. In the print dialog: **100% scale, no fit-to-page**. Each sign is 5×7in.
   Save as PDF if you are sending it to a print shop.
4. Install each sign in the location named in small grey type at its bottom.

Have them laminated or printed on adhesive vinyl. Elevator cabs get cleaned with
solvents and paper will not last a month.

**Before printing 35 of anything, print one and check it scans** with an actual
phone, from the distance a resident would stand.

## Step 9 — Rehearse, then go live

Walk the building and scan **every** sign while still in DRY_RUN. Confirm the
name that appears matches the room you are standing in. This is the step that
catches a sign installed in the wrong cinema, and it is far cheaper to catch now
than after housekeeping has been sent to the wrong floor twice.

Then:

```bash
sudo nano /opt/amr-service-qr/.env
```

Change `DRY_RUN=true` to `DRY_RUN=false`. Save with `Ctrl+O`, `Enter`, then
`Ctrl+X`. Restart:

```bash
sudo systemctl restart amr-service-qr
```

You are live. Tell housekeeping what the email looks like and what the button
does before the first one arrives.

---

## Running it

**Check on it**

```bash
sudo systemctl status amr-service-qr     # is it running
journalctl -u amr-service-qr -f          # live logs
curl https://amrservice.com/health       # from anywhere
```

**Back it up — do this monthly**

Sign in to `/ops/locations` and click **Download database**. Keep the file
somewhere that is not the server: OneDrive, SharePoint, anywhere.

This matters more than anything else in this document. The QR tokens exist only
in that database. If the droplet is destroyed and you have no copy, all 35 signs
become dead links and every one has to be reprinted and reinstalled. A monthly
download takes ten seconds.

Put a recurring calendar reminder in now, before you forget this paragraph.

**Turn a sign off**

`/ops/locations` → **Deactivate**. The sign stays on the wall and still
resolves, but shows "not currently active" instead of dispatching. Use it during
elevator modernization, when an amenity closes, or if a code gets photographed
and shared around.

**Patch the server** — monthly, alongside the backup:

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot
```

The service restarts itself on boot.

**Deploy a change**

Same three commands as the first install:

```bash
tar -czf service-qr-upload.tar.gz --exclude=node_modules --exclude=data --exclude=signs --exclude=.env service-qr
```

```bash
scp service-qr-upload.tar.gz root@YOUR_DROPLET_IP:/root/
```

```bash
ssh root@YOUR_DROPLET_IP "cd /root && tar -xzf service-qr-upload.tar.gz && cd service-qr && sudo bash deploy/setup-ubuntu.sh"
```

Re-running the installer keeps your existing `.env` and database untouched. It
will not mint new tokens, so your printed signs keep working.

---

## If something goes wrong

**"Service did not respond" at the end of the install**

```bash
journalctl -u amr-service-qr -n 50 --no-pager
```

Usually a typo in `.env`. The app refuses to start with a specific message
rather than running misconfigured, so the error normally names the problem.

**The site will not load / no certificate**

```bash
sudo journalctl -u caddy -n 30 --no-pager
```

Almost always DNS: either it has not propagated, or Cloudflare's orange cloud is
still on. Confirm `nslookup amrservice.com` returns your droplet IP, set the
proxy to **DNS only**, then `sudo systemctl restart caddy`.

**A QR code does nothing**

Check cell signal in that elevator cab first, with the doors closed — that is
the usual answer and no software change fixes it. Then check `/health`, then
whether that location was deactivated.

**Wrong location name after scanning**

A sign was installed in the wrong room. The grey label at the bottom of each
sign says where it belongs. Swap the physical signs — do **not** re-seed, which
would mint new tokens and invalidate every printed code.

**Locked out of the dashboard**

```bash
sudo nano /opt/amr-service-qr/.env      # change OPS_PASSCODE
sudo systemctl restart amr-service-qr
```

---

## The managed alternative

If a Linux server turns out to be more than you want to own, **Railway** runs
this with no server to patch:

1. [railway.app](https://railway.app) → sign up → **New Project → Empty Project**
2. Install the CLI: `npm install -g @railway/cli`
3. From your `service-qr` folder: `railway login`, then `railway link`, then `railway up`
4. **Add a Volume** mounted at `/data` — without this the database is wiped on
   every redeploy, which would destroy your QR tokens
5. Set variables in **Settings → Variables**: the same values the installer asks
   for, plus `DATA_DIR=/data`, `BIND_HOST=0.0.0.0`, `AUTO_SEED=true`
6. **Settings → Networking → Custom Domain**, then add the CNAME it gives you at
   Cloudflare

Hobby is $5/month including usage, with volumes around $0.15/GB-month — this
database will be a rounding error. Render is comparable at $7/month for a
Starter service plus a persistent disk; note that Render's **free** tier cannot
attach a disk, so it will not work for this.

Everything else in this document — signs, rehearsal, backups, DRY_RUN — applies
unchanged.

Sources: [Railway volumes](https://docs.railway.com/volumes/reference) ·
[Render pricing](https://render.com/pricing)
