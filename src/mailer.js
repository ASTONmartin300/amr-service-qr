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
//
// The department the email went to rides inside the signature, so when the
// link is tapped we know which team closed it -- without trusting anything the
// tapper could edit.
function servicedUrl(requestId, dept) {
  const payload = dept ? `req:${requestId}:${dept}` : `req:${requestId}`;
  return `${config.publicBaseUrl}/done/${sign(payload, 7 * 86400000)}`;
}

function buildDispatch(request, location) {
  const when = formatTime(request.created_at);
  const svc = getService(request.type);
  const url = servicedUrl(request.id, svc.dept);
  // "Out of supplies" on its own sends someone to find out what. The picker
  // answers that, and it belongs in the subject where a glance catches it.
  const what = request.detail ? ` (${request.detail})` : '';

  const text = [
    `${location.label_en} has been ${svc.reported}.`,
    '',
    `Request received: ${when}`,
    `Location: ${location.label_en}`,
    `Type: ${svc.en.short}${what}`,
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
        <td style="padding:3px 0"><strong>${escapeHtml(svc.en.short)}${escapeHtml(what)}</strong></td></tr>
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
    subject: `${svc.emailPrefix} - ${location.label_en}${what}`,
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

function providerReady() {
  return (config.emailProvider === 'resend' && config.resend.apiKey) || !!getTransport();
}

// Sends one message through whichever provider is configured. Throws on
// failure and ignores DRY_RUN -- this is the raw path, for callers that have
// explicitly decided to send (the preflight test, the wrappers below).
//
//   { to, cc, subject, text, html, attachments: [{ filename, content: Buffer }] }
async function deliverEmail({ to, cc, subject, text, html, attachments }) {
  const useResend = config.emailProvider === 'resend' && config.resend.apiKey;
  const tx = useResend ? null : getTransport();
  if (!useResend && !tx) throw new Error('no email provider configured');

  const toList = Array.isArray(to) ? to : [to];
  const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  const replyTo = config.resend.replyTo || undefined;
  const files = attachments && attachments.length ? attachments : null;

  if (useResend) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resend.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.resend.from,
        to: toList,
        cc: ccList.length ? ccList : undefined,
        reply_to: replyTo,
        subject, text, html,
        attachments: files
          ? files.map((a) => ({ filename: a.filename, content: a.content.toString('base64') }))
          : undefined,
      }),
      signal: AbortSignal.timeout(20000),
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
    return;
  }

  await tx.sendMail({
    from: config.smtp.from,
    to: toList.join(', '),
    cc: ccList.length ? ccList.join(', ') : undefined,
    replyTo,
    subject, text, html,
    attachments: files ? files.map((a) => ({ filename: a.filename, content: a.content })) : undefined,
  });
}

// The send everything else should use. Three guards: DRY_RUN logs instead of
// sending, an unconfigured provider logs instead of sending, and a delivery
// failure is reported rather than thrown -- nothing that emails should ever be
// able to crash the service. Returns 'dry_run' | 'console' | 'sent' | 'failed'.
async function sendEmail(message, { label } = {}) {
  const tag = label || message.subject;
  const to = Array.isArray(message.to) ? message.to.join(', ') : message.to;

  if (config.dryRun) {
    console.log(`[DRY_RUN] would email ${to}: ${message.subject}`);
    return 'dry_run';
  }
  if (!providerReady()) {
    console.log(`[console] no email provider configured; not sending: ${message.subject}`);
    return 'console';
  }
  try {
    await deliverEmail(message);
    return 'sent';
  } catch (err) {
    console.error(`[mail] FAILED (${tag}): ${err.message}`);
    return 'failed';
  }
}

// Never throws. A mail failure must not cost the resident their thank-you
// screen -- the request is already recorded, and email_status carries the
// failure to the dashboard where someone can see it.
async function sendDispatch(request, location) {
  const message = buildDispatch(request, location);
  const to = recipientFor(request, location);
  const svc = getService(request.type);

  // When nothing is really going out, print the close link so a local tester
  // can still exercise MARK SERVICED.
  if (config.dryRun || !providerReady()) {
    console.log(`[mail] mark serviced: ${servicedUrl(request.id, svc.dept)}`);
  }

  return sendEmail(
    { to, cc: config.dispatchCc || undefined, ...message },
    { label: `request #${request.id}` },
  );
}

module.exports = {
  sendEmail, deliverEmail, sendDispatch, servicedUrl, buildDispatch, recipientFor,
  formatTime, escapeHtml,
};
