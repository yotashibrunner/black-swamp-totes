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

module.exports = { isConfigured, sendBookingConfirmation };
