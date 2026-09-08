# Deploys the service-QR app to your server, start to finish.
#
# You do not need to know any of this. Open PowerShell and paste one line:
#
#   & "C:\Users\jQuintero\Documents\Claude Folder\service-qr\deploy-to-server.ps1"
#
# It packages the app, checks your DNS, uploads it, and starts the installer.
# You will be asked for your droplet password twice -- once to upload, once to
# connect. The password is INVISIBLE while you type it. That is normal. Type it
# and press Enter.

param(
    [string]$ServerIP = "198.211.113.21",
    [string]$Domain   = "amrservices300.com"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$parent = Split-Path -Parent $root
$archive = Join-Path $parent "service-qr-upload.tar.gz"

function Say($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Good($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Bad($msg)  { Write-Host "    $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  AMR Service Requests - deploy" -ForegroundColor White
Write-Host "  server $ServerIP   domain $Domain"

# --- 1. Package -----------------------------------------------------------
# Rebuilt every run so the server always gets the current code. Excludes the
# dependencies (the server installs its own), the local test database, and the
# local settings file -- all three would be wrong on a server.

Say "Packaging the application"
Push-Location $parent
try {
    if (Test-Path $archive) { Remove-Item $archive -Force }
    tar -czf "service-qr-upload.tar.gz" --exclude=node_modules --exclude=data --exclude=signs --exclude=.env service-qr
    if (-not (Test-Path $archive)) { throw "tar did not produce the archive" }
    $kb = [math]::Round((Get-Item $archive).Length / 1KB)
    Good "$kb KB ready"
} finally {
    Pop-Location
}

# --- 2. DNS ---------------------------------------------------------------
# The single most common reason the install fails later is the domain not
# pointing at this server yet, so it is worth ten seconds to check.

Say "Checking $Domain points at $ServerIP"
try {
    $resolved = (Resolve-DnsName -Name $Domain -Type A -ErrorAction Stop |
                 Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
    if ($resolved -eq $ServerIP) {
        Good "DNS is correct"
    } else {
        Bad "DNS points at $resolved, not $ServerIP"
        Bad "Fix the A record in Cloudflare (grey cloud, not orange), wait 2 min, run this again."
        exit 1
    }
} catch {
    Bad "Could not look up $Domain. Check the A record exists in Cloudflare."
    exit 1
}

# --- 3. Upload ------------------------------------------------------------

Say "Checking SSH is reachable from this network"
# Many corporate and building networks block outbound port 22. Finding that out
# here, in two seconds, beats a password prompt that was never going to work --
# and stops anyone typing a password into a dead terminal afterwards.
$sshOk = (Test-NetConnection -ComputerName $ServerIP -Port 22 -WarningAction SilentlyContinue).TcpTestSucceeded
if (-not $sshOk) {
    Bad "Cannot reach $ServerIP on port 22."
    Write-Host ""
    Write-Host "    This is almost always the network you are on, not the server." -ForegroundColor Yellow
    Write-Host "    Quickest fix: connect this PC to your phone's hotspot and run this again." -ForegroundColor Yellow
    Write-Host "    Mobile networks do not block SSH; office networks often do." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    Do NOT type your password after this message -- there is no prompt" -ForegroundColor Yellow
    Write-Host "    waiting for it, and it would be saved into your command history." -ForegroundColor Yellow
    exit 1
}
Good "Port 22 reachable"

Say "Uploading to the server"
Write-Host "    Your password is invisible while you type it. That is normal." -ForegroundColor Yellow
scp $archive "root@${ServerIP}:/root/"
if ($LASTEXITCODE -ne 0) {
    Bad "Upload failed."
    Bad "If it said 'Permission denied': wrong password. DigitalOcean -> your"
    Bad "droplet -> Access -> Reset Root Password."
    Write-Host ""
    Write-Host "    Do NOT type your password now -- nothing is prompting for it." -ForegroundColor Yellow
    exit 1
}
Good "Uploaded"

# --- 4. Unpack and install -----------------------------------------------
# -t gives the remote session a terminal, so the installer's questions appear
# here and your answers reach it.

Say "Starting the installer on the server"
Write-Host "    Password again. Then answer the installer's seven questions." -ForegroundColor Yellow
Write-Host "    At the first one, enter exactly:  $Domain" -ForegroundColor Yellow
Write-Host ""

ssh -t "root@$ServerIP" "cd /root && tar -xzf service-qr-upload.tar.gz && cd service-qr && bash deploy/setup-ubuntu.sh"

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Bad "The installer did not finish cleanly. Copy what it printed and send it over."
    exit 1
}

Write-Host ""
Good "Done."
Write-Host ""
Write-Host "  Next: open https://$Domain/ops and sign in with your dashboard passcode." -ForegroundColor White
Write-Host "  You should see 44 locations. Nothing is emailed to staff yet -- it starts"
Write-Host "  in rehearsal mode on purpose."
Write-Host ""
