#!/usr/bin/env bash
#
# One-shot installer for a fresh Ubuntu 24.04 server.
#
#   sudo bash deploy/setup-ubuntu.sh
#
# Installs Node 24, creates a service account, configures systemd, installs
# Caddy for automatic HTTPS, and sets up the firewall. Prompts for the handful
# of values it cannot guess.
#
# Safe to re-run. It will not overwrite an existing .env or an existing
# database -- re-running to pick up a code change or repair a service is
# expected and does not mint new QR tokens.
#
# See docs/SELF-HOSTING.md for the full walkthrough.

set -euo pipefail

APP_DIR=/opt/amr-service-qr
DATA_DIR=/var/lib/amr-service-qr
SVC_USER=amrsvc

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo:  sudo bash deploy/setup-ubuntu.sh" >&2
  exit 1
fi

# The script must be run from inside the uploaded application directory.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "$SRC/package.json" ]]; then
  echo "Cannot find package.json. Run this from inside the service-qr folder." >&2
  exit 1
fi

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- 1. System packages ----------------------------------------------------

say "Updating system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg ufw rsync debian-keyring debian-archive-keyring apt-transport-https

# --- 2. Node 24 ------------------------------------------------------------
#
# Node 24 specifically: the app uses the built-in node:sqlite module, which
# still required a flag on Node 22.

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 24 ]]; then
  say "Installing Node 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
echo "Node $(node -v)"

# --- 3. Caddy --------------------------------------------------------------

if ! command -v caddy >/dev/null; then
  say "Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# --- 4. Service account and directories ------------------------------------

if ! id "$SVC_USER" >/dev/null 2>&1; then
  say "Creating service account $SVC_USER"
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi

mkdir -p "$APP_DIR" "$DATA_DIR"

say "Installing application to $APP_DIR"
# .env and the database live outside the copied tree, so this is safe to re-run.
rsync -a --delete \
  --exclude node_modules --exclude data --exclude signs --exclude .env --exclude .git \
  "$SRC/" "$APP_DIR/"

cd "$APP_DIR"
npm ci --omit=dev --silent

# --- 5. Configuration ------------------------------------------------------

if [[ -f "$APP_DIR/.env" ]]; then
  say "Keeping existing .env (delete it and re-run to reconfigure)"
else
  say "Configuration"
  echo "These go into $APP_DIR/.env. You can edit that file later."
  echo

  read -rp "  Domain for residents to reach (e.g. amrservice.com): " DOMAIN
  read -rp "  Housekeeping email (cleaning + resupply requests): " HK_EMAIL
  read -rp "  Engineering email (broken items) [blank = housekeeping]: " ENG_EMAIL
  read -rp "  Copy requests to (blank for none): " CC_EMAIL
  echo
  echo "  How should email be sent?"
  echo "    1) Resend  -- from your own domain, no password to expire (recommended)"
  echo "    2) Microsoft 365 -- mailbox + app password (stops working end of 2026)"
  read -rp "  Choose 1 or 2 [1]: " MAIL_CHOICE
  MAIL_CHOICE="${MAIL_CHOICE:-1}"

  RESEND_KEY=""; RESEND_SENDER=""; SMTP_USER=""; SMTP_PASS=""; SMTP_HOSTNAME=""
  if [[ "$MAIL_CHOICE" == "2" ]]; then
    read -rp "  Microsoft 365 mailbox to send FROM: " SMTP_USER
    read -rsp "  App password for that mailbox: " SMTP_PASS; echo
    SMTP_HOSTNAME="smtp.office365.com"
  else
    read -rp "  Resend API key (starts re_): " RESEND_KEY
    read -rp "  Send from address [notifications@${DOMAIN}]: " RESEND_ADDR
    RESEND_ADDR="${RESEND_ADDR:-notifications@${DOMAIN}}"
    RESEND_SENDER="AMR Service Requests <${RESEND_ADDR}>"
  fi

  read -rp "  Where staff replies should go [${CC_EMAIL:-$HK_EMAIL}]: " REPLY_ADDR
  REPLY_ADDR="${REPLY_ADDR:-${CC_EMAIL:-$HK_EMAIL}}"

  read -rp "  Manager email (escalations, weekly digest, monthly backup) [${CC_EMAIL:-$HK_EMAIL}]: " MGR_EMAIL
  MGR_EMAIL="${MGR_EMAIL:-${CC_EMAIL:-$HK_EMAIL}}"

  read -rp "  Passcode for the management dashboard: " OPS_PASSCODE

  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"

  cat > "$APP_DIR/.env" <<EOF
# Written by deploy/setup-ubuntu.sh on $(date -Is)
PUBLIC_BASE_URL=https://${DOMAIN}
PORT=8080
BIND_HOST=127.0.0.1
DATA_DIR=${DATA_DIR}
SIGNS_DIR=${DATA_DIR}/signs

# Values are quoted because this file is read both by the app (dotenv) and by
# systemd's EnvironmentFile. Both strip surrounding quotes, and an unquoted
# passcode containing a space would break systemd.
SECRET="${SECRET}"
OPS_PASSCODE="${OPS_PASSCODE}"

HOUSEKEEPING_EMAIL="${HK_EMAIL}"
ENGINEERING_EMAIL="${ENG_EMAIL}"
DISPATCH_CC="${CC_EMAIL}"
SUPPRESSION_MINUTES=30

RESEND_API_KEY="${RESEND_KEY}"
RESEND_FROM="${RESEND_SENDER}"
REPLY_TO="${REPLY_ADDR}"

# Escalation, digest, backup. The front desk gets the 30-minute nudge; the
# manager gets the 60-minute one, the Monday digest, and the monthly backup.
MANAGER_EMAIL="${MGR_EMAIL}"
ESCALATE_AFTER_MINUTES=30
ESCALATE_TO="${CC_EMAIL:-$HK_EMAIL}"
ESCALATE_AGAIN_AFTER_MINUTES=60
DIGEST_DAY=1
DIGEST_HOUR=7
BACKUP_DAY=1

SMTP_HOST="${SMTP_HOSTNAME}"
SMTP_PORT=587
SMTP_USER="${SMTP_USER}"
SMTP_PASS="${SMTP_PASS}"
SMTP_FROM="${SMTP_USER}"

# Seeds all 35 AMR locations on first boot against an empty database.
AUTO_SEED=true

# Starts in rehearsal mode: requests are recorded, housekeeping is NOT emailed.
# Walk the building, confirm every sign, then set this to false and restart.
DRY_RUN=true
EOF

  # Contains an SMTP password and the dashboard passcode.
  chmod 600 "$APP_DIR/.env"

  say "Configuring Caddy for ${DOMAIN}"
  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:8080
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Frame-Options "DENY"
		X-Content-Type-Options "nosniff"
		-Server
	}
	request_body {
		max_size 16KB
	}
}
EOF
fi

chown -R "$SVC_USER:$SVC_USER" "$APP_DIR" "$DATA_DIR"

# --- 6. Services -----------------------------------------------------------

say "Installing systemd service"
cp "$APP_DIR/deploy/amr-service-qr.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable amr-service-qr >/dev/null
systemctl restart amr-service-qr
systemctl reload-or-restart caddy

# --- 7. Firewall -----------------------------------------------------------
#
# Deliberately allows SSH first. Enabling ufw without that rule locks you out
# of a remote server permanently.

say "Configuring firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status numbered

# --- 8. Verify -------------------------------------------------------------

say "Checking the service"

# Retry rather than sleeping a fixed amount. First boot seeds 35 locations and
# builds the SQLite file, which on the smallest droplet can take a few seconds
# longer than a fixed sleep allows -- and a false "failed" here would send you
# debugging a service that was actually fine.
UP=""
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 http://127.0.0.1:8080/health 2>/dev/null; then
    UP=yes
    break
  fi
  sleep 2
done

if [[ -n "$UP" ]]; then
  echo
  echo
  echo "Service is up."
else
  echo
  echo "Service did not respond after 30 seconds."
  echo "Look at the log -- it names the problem rather than failing vaguely:"
  echo
  journalctl -u amr-service-qr -n 30 --no-pager || true
  exit 1
fi

DOMAIN_LINE="$(grep -m1 '^PUBLIC_BASE_URL=' "$APP_DIR/.env" | cut -d= -f2-)"

cat <<EOF

------------------------------------------------------------------
Installed.

  Dashboard   ${DOMAIN_LINE}/ops
  Locations   ${DOMAIN_LINE}/ops/locations
  Signs       ${DOMAIN_LINE}/ops/signs
  Database    ${DATA_DIR}/service.db

Currently in DRY_RUN mode: requests are recorded, housekeeping is NOT emailed.

Next:
  1. Open the dashboard and sign in.
  2. Verify 44 locations exist (17 elevators, 26 amenities, 1 supply point).
  3. Print the signs and install them.
  4. Walk the building and scan every one. Confirm the right name appears.
  5. Then go live:
       sudo nano ${APP_DIR}/.env      # DRY_RUN=false
       sudo systemctl restart amr-service-qr

Logs:     journalctl -u amr-service-qr -f
Restart:  sudo systemctl restart amr-service-qr
Backup:   download from ${DOMAIN_LINE}/ops/locations
------------------------------------------------------------------
EOF
