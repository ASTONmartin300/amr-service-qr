// Dispatch email. Same M365 SMTP pattern as reservation-bot, so the app
// password already working there works here.
//
// Two guards before anything leaves the building:
//   DRY_RUN=true     -> log only, never send
//   SMTP_HOST blank  -> console mode, never send
'use strict';

const nodemailer = require('nodemailer');
const { config } = require('./config');
const { sign } = require('./tokens');
const { get: getService } = require('./services');

let transport = null;
function getTransport() {
  if (!config.smtp.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: config.timeZone,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// The link is signed and only ever closes an 'open' row, so forwarding the
// email around cannot reopen or falsely close anything. 7-day TTL keeps a
// months-old email in someone's archive from being tapped by accident.
function servicedUrl(requestId) {
  return `${config.publicBaseUrl}/done/${sign(`req:${requestId}`, 7 * 86400000)}`;
}

function buildDispatch(request, location) {
  const when = formatTime(request.created_at);
  const url = servicedUrl(request.id);
  const svc = getService(request.type);

  const text = [
    `${location.label_en} has been ${svc.reported}.`,
    '',
    `Request received: ${when}`,
    `Location: ${location.label_en}`,
    `Type: ${svc.en.short}`,
    `Request #${request.id}`,
    '',
    'When the work is finished, mark it serviced:',
    url,
    '',
    'No resident information was collected with this request.',
  ].join('\n');

  const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;color:#111">
  <p style="font-size:17px;margin:0 0 18px"><strong>${escapeHtml(location.label_en)}</strong>
     has been ${escapeHtml(svc.reported)}.</p>
  <table style="font-size:15px;border-collapse:collapse;margin:0 0 26px">
    <tr><td style="padding:3px 18px 3px 0;color:#666">Request received</td>
        <td style="padding:3px 0"><strong>${escapeHtml(when)}</strong></td></tr>
    <tr><td style="padding:3px 18px 3px 0;color:#666">Location</td>
        <td style="padding:3px 0"><strong>${escapeHtml(location.label_en)}</strong></td></tr>
    <tr><td style="padding:3px 18px 3px 0;color:#666">Type</td>
        <td style="padding:3px 0"><strong>${escapeHtml(svc.en.short)}</strong></td></tr>
    <tr><td style="padding:3px 18px 3px 0;color:#666">Request</td>
        <td style="padding:3px 0">#${request.id}</td></tr>
  </table>
  <a href="${url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;
     padding:15px 34px;font-size:15px;letter-spacing:.09em;border-radius:2px">MARK SERVICED</a>
  <p style="font-size:12px;color:#888;margin:26px 0 0;line-height:1.6">
    Tap once the work is done. This records the completion time and closes the
    request.<br>No resident information was collected with this request.
  </p>
</div>`.trim();

  return {
    subject: `${svc.emailPrefix} - ${location.label_en}`,
    text,
    html,
  };
}

// A per-location notify_email overrides everything -- that is the escape hatch
// for "the pool deck reports go to the amenities manager, whatever the type".
// Otherwise the request type picks the department.
function recipientFor(request, location) {
  if (location.notify_email) return location.notify_email;
  const svc = getService(request.type);
  return config.departments[svc.dept] || config.housekeepingEmail;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Resend's HTTPS API. Node 24 has fetch built in, so this adds no dependency.
// Throws on failure; sendDispatch catches.
async function sendViaResend({ to, message }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.resend.from,
      to: [to],
      cc: config.dispatchCc ? [config.dispatchCc] : undefined,
      reply_to: config.resend.replyTo || undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    // Resend returns a JSON body explaining the refusal -- an unverified
    // sending domain being the usual one. Surface it rather than just a code.
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || body.name || JSON.stringify(body);
    } catch { detail = await res.text().catch(() => ''); }
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
}

// Never throws. A mail failure must not cost the resident their thank-you
// screen -- the request is already recorded, and email_status carries the
// failure to the dashboard where someone can see it.
async function sendDispatch(request, location) {
  const message = buildDispatch(request, location);
  const to = recipientFor(request, location);

  if (config.dryRun) {
    console.log(`[DRY_RUN] would email ${to}: ${message.subject}`);
    console.log(`[DRY_RUN] mark serviced: ${servicedUrl(request.id)}`);
    return 'dry_run';
  }

  const useResend = config.emailProvider === 'resend' && config.resend.apiKey;
  const tx = useResend ? null : getTransport();

  if (!useResend && !tx) {
    console.log(`[console] no email provider configured; not sending: ${message.subject}`);
    console.log(`[console] mark serviced: ${servicedUrl(request.id)}`);
    return 'console';
  }

  try {
    if (useResend) {
      await sendViaResend({ to, message });
    } else {
      await tx.sendMail({
        from: config.smtp.from,
        to,
        cc: config.dispatchCc || undefined,
        replyTo: config.resend.replyTo || undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    }
    return 'sent';
  } catch (err) {
    console.error(`[mail] FAILED for request #${request.id}: ${err.message}`);
    return 'failed';
  }
}

module.exports = {
  sendDispatch, sendViaResend, servicedUrl, buildDispatch, recipientFor,
  formatTime, escapeHtml,
};
