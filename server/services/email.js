'use strict';

// Transactional email via Resend. Guarded by RESEND_API_KEY: with no key,
// sends are logged and skipped so the booking flow never fails on email.

const { Resend } = require('resend');
const config = require('../config');
const { formatCents } = require('../utils/money');

let client = null;
function getClient() {
  if (!config.resendApiKey) return null;
  if (!client) client = new Resend(config.resendApiKey);
  return client;
}

function isConfigured() {
  return !!config.resendApiKey;
}

async function sendBookingConfirmation(booking, pdfBuffer, baseUrl) {
  const resend = getClient();
  if (!resend) {
    console.log(`[email] Resend not configured — skipping confirmation for ${booking.ref_code}`);
    return { skipped: true };
  }
  if (!booking.customer_email) {
    console.log(`[email] no email on file for ${booking.ref_code} — skipping`);
    return { skipped: true };
  }

  const ref = booking.ref_code;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#0a0d0a;max-width:560px">
      <h2 style="color:#1faa30">Booking confirmed — ${ref}</h2>
      <p>Hi ${booking.customer_name || 'there'}, your Glass City Trailer Rentals booking is confirmed and paid.</p>
      <table style="font-size:14px;border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#555">Equipment</td><td><strong>${booking.trailer_name}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">Reference</td><td>${ref}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">Total paid</td><td>${formatCents(booking.total_cents)}</td></tr>
      </table>
      <p>Pickup at 2004 Front Street, Toledo, OH 43605 (7am–7pm). Your signed rental agreement is attached as a PDF.</p>
      <p><a href="${baseUrl}/book/${ref}" style="color:#1faa30">View your booking</a></p>
      <p style="color:#888;font-size:12px">Glass City Trailer Rentals LLC · (419) 654-3584</p>
    </div>`;

  return resend.emails.send({
    from: config.fromEmail,
    to: booking.customer_email,
    subject: `Your Glass City booking ${ref} is confirmed`,
    html,
    attachments: pdfBuffer
      ? [{ filename: `rental-agreement-${ref}.pdf`, content: pdfBuffer }]
      : undefined,
  });
}

// 24-hour reminder email (driven by the reminders cron). `kind` is 'pickup' or
// 'return'. Guarded like the confirmation send.
async function sendBookingReminder(booking, kind, baseUrl) {
  const resend = getClient();
  if (!resend) {
    console.log(`[email] Resend not configured — skipping ${kind} reminder for ${booking.ref_code}`);
    return { skipped: true };
  }
  if (!booking.customer_email) return { skipped: true };

  const ref = booking.ref_code;
  const isPickup = kind === 'pickup';
  const action = isPickup
    ? 'Your pickup is tomorrow.'
    : 'Your rental is due back tomorrow.';
  const detail = isPickup
    ? 'Pickup is at 2004 Front Street, Toledo, OH 43605 (7am–7pm). Bring a properly rated tow vehicle.'
    : 'Please return to 2004 Front Street, Toledo, OH 43605 (7am–7pm) by end of day to avoid late charges.';

  const html = `
    <div style="font-family:Arial,sans-serif;color:#0a0d0a;max-width:560px">
      <h2 style="color:#1faa30">Reminder — ${ref}</h2>
      <p>Hi ${booking.customer_name || 'there'}, ${action}</p>
      <table style="font-size:14px;border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#555">Equipment</td><td><strong>${booking.trailer_name}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">Reference</td><td>${ref}</td></tr>
      </table>
      <p>${detail}</p>
      <p><a href="${baseUrl || ''}/book/${ref}" style="color:#1faa30">View your booking</a></p>
      <p style="color:#888;font-size:12px">Glass City Trailer Rentals LLC · (419) 654-3584</p>
    </div>`;

  return resend.emails.send({
    from: config.fromEmail,
    to: booking.customer_email,
    subject: isPickup ? `Reminder: pickup tomorrow (${ref})` : `Reminder: return due tomorrow (${ref})`,
    html,
  });
}

// Send a simple test email and surface the real outcome (including Resend's
// error, e.g. an unverified sending domain) so an admin can diagnose delivery.
async function sendTest(to) {
  const resend = getClient();
  if (!resend) return { skipped: true, reason: 'RESEND_API_KEY is not set on the server.' };
  if (!to) return { error: 'No recipient email.' };
  try {
    const { data, error } = await resend.emails.send({
      from: config.fromEmail,
      to,
      subject: 'Glass City — test email ✅',
      html:
        '<div style="font-family:Arial,sans-serif;color:#0a0d0a;max-width:520px">'
        + '<h2 style="color:#1faa30">Email is working</h2>'
        + '<p>This is a test from your Glass City operator app. If it reached you, '
        + 'booking confirmations will send too.</p>'
        + `<p style="color:#888;font-size:12px">Sent from ${config.fromEmail}</p></div>`,
    });
    if (error) return { error: error.message || (typeof error === 'string' ? error : JSON.stringify(error)) };
    return { id: data && data.id };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { isConfigured, sendBookingConfirmation, sendBookingReminder, sendTest };
