'use strict';

// Stripe webhook. Mounted with express.raw so the signature is verified against
// the exact bytes Stripe sent (express.json would corrupt the signature check).
// On checkout.session.completed: mark the booking paid, then best-effort email
// the customer their confirmation with the signed contract PDF attached.

const express = require('express');
const stripeSvc = require('../services/stripe');
const bookingSvc = require('../services/booking');
const chargesSvc = require('../services/charges');
const couponsSvc = require('../services/coupons');
const emailSvc = require('../services/email');
const notifySvc = require('../services/notify');
const pushSvc = require('../services/push');
const smsSvc = require('../services/sms');
const config = require('../config');
const { query } = require('../db');
const { generatePdf } = require('../services/contract');

const BUSINESS_PHONE = '(419) 262-2837';

const router = express.Router();

// Escape text for inclusion in a TwiML XML body.
function xmlEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function twiml(res, message) {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`);
}

router.post('/stripe', async (req, res) => {
  let event;
  try {
    event = stripeSvc.constructEvent(req.body, req.get('stripe-signature'));
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    console.log(`[webhook] received ${event.type} (${event.id})`);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const kind = (session.metadata && session.metadata.type) || 'booking';

      // Extension / additional-charge payment links resolve their own records
      // (an extension also pushes the booking's return date out). They don't
      // send a confirmation email.
      if (kind === 'extension') {
        const ext = await chargesSvc.markExtensionPaidBySession(session.id, session.payment_intent);
        console.log(`[webhook] extension ${ext ? ext.id + ' paid (return date moved)' : 'already paid / unknown'}`);
        return res.json({ received: true });
      }
      if (kind === 'charge') {
        const ch = await chargesSvc.markChargePaidBySession(session.id, session.payment_intent);
        console.log(`[webhook] additional charge ${ch ? ch.id + ' paid' : 'already paid / unknown'}`);
        return res.json({ received: true });
      }

      // Stripe always collects an email on its checkout page; prefer that, then
      // any email we passed. Used to mark paid + backfill the customer record.
      const stripeEmail =
        (session.customer_details && session.customer_details.email) || session.customer_email || null;

      // We save the card off-session on every booking — resolve the customer +
      // payment method so we can later refund a deposit / charge the card on file.
      const depositCents = Number(session.metadata && session.metadata.deposit_cents) || 0;
      const { customerId, paymentMethodId } = await stripeSvc.getSavedPaymentDetails(session);
      // Real charge id + processing fee (for true net revenue), best-effort.
      const { chargeId, feeCents } = await stripeSvc.getChargeDetails(session.payment_intent);

      const booking = await bookingSvc.markPaidBySession(session.id, {
        paymentIntentId: session.payment_intent,
        amountCents: session.amount_total,
        customerEmail: stripeEmail,
        customerId,
        paymentMethodId,
        depositCents,
        chargeId,
        feeCents,
      });
      if (!booking) {
        console.warn(`[webhook] no pending booking for session ${session.id} (already paid or unknown).`);
        return res.json({ received: true });
      }

      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      console.log(`[webhook] booking ${booking.ref_code} marked paid; email=${booking.customer_email || '(none)'}`);

      // Confirmation email with the signed-contract PDF (best-effort).
      try {
        const pdf = await generatePdf(booking);
        const result = await emailSvc.sendBookingConfirmation(booking, pdf, baseUrl);
        if (result && result.skipped) {
          console.warn(`[webhook] confirmation email skipped for ${booking.ref_code} (${booking.customer_email ? 'email service not configured' : 'no customer email'}).`);
        } else {
          console.log(`[webhook] confirmation email sent for ${booking.ref_code}.`);
        }
      } catch (e) {
        console.error('[webhook] confirmation email failed:', e.message);
      }

      // Record the coupon use (idempotent) — only counts a PAID booking.
      if (booking.coupon_id) {
        try {
          await couponsSvc.recordUse(booking.coupon_id, booking.id, booking.discount_applied_cents);
        } catch (e) {
          console.error('[webhook] coupon use record failed:', e.message);
        }
      }

      // Alert the operator(s) on push + SMS. Best-effort: notify never throws.
      try {
        await notifySvc.notifyNewBooking(booking, baseUrl);
      } catch (e) {
        console.error('[webhook] operator notification failed:', e.message);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err.message);
    res.status(500).json({ error: 'handler_error' });
  }
});

// ── Twilio inbound SMS ──────────────────────────────────────────────────────
// Register in Twilio: https://blackswamptotes.com/webhooks/twilio-inbound (POST).
// Customers reply READY (confirm pickup) or EXTEND. The /webhooks mount uses
// express.raw, so the form-urlencoded body arrives as a Buffer we parse here.
// Always replies with TwiML so Twilio doesn't retry. Last 10 digits match the
// customer's phone to their active ('out') booking.
router.post('/twilio-inbound', async (req, res) => {
  try {
    const form = new URLSearchParams(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || ''));
    const from = form.get('From') || '';
    const body = (form.get('Body') || '').trim();
    const upper = body.toUpperCase();
    const last10 = from.replace(/\D/g, '').slice(-10);

    // Audit every inbound message (best-effort).
    query(
      `INSERT INTO audit_log (action, entity_type, details)
       VALUES ('sms.inbound', 'sms', $1)`,
      [JSON.stringify({ from, body: body.slice(0, 300) })]
    ).catch((e) => console.error('[twilio] audit failed:', e.message));

    // Find the active rental for this phone (most recent out booking).
    let booking = null;
    if (last10) {
      const { rows } = await query(
        `SELECT b.id, b.ref_code, b.pickup_address, b.delivery_address, c.name AS customer_name
           FROM bookings b JOIN customers c ON c.id = b.customer_id
          WHERE right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10) = $1
            AND b.status = 'out'
          ORDER BY b.end_at DESC LIMIT 1`,
        [last10]
      );
      booking = rows[0] || null;
    }

    if (!booking) {
      return twiml(res, `We couldn't find an active rental for this number. Questions? Call us at ${BUSINESS_PHONE}.`);
    }

    const firstName = (booking.customer_name || 'there').trim().split(' ')[0];

    if (upper.includes('READY')) {
      await query('UPDATE bookings SET pickup_requested_at = NOW() WHERE id = $1 AND pickup_requested_at IS NULL', [booking.id]);
      await query(
        `INSERT INTO audit_log (action, entity_type, entity_id, details)
         VALUES ('booking.pickup_requested', 'booking', $1, $2)`,
        [booking.id, JSON.stringify({ via: 'sms', ref: booking.ref_code })]
      ).catch(() => {});

      // Notify operators (push + SMS), best-effort.
      const baseUrl = config.baseUrl || '';
      const pickupAddr = booking.pickup_address || booking.delivery_address || '(address on file)';
      const opBody = `${booking.customer_name} is ready for pickup.\nAddress: ${pickupAddr}\nBooking: ${booking.ref_code}`;
      try {
        await pushSvc.sendToOperators({
          title: '✓ Ready for pickup',
          body: opBody,
          url: `${baseUrl}/operator/?booking=${booking.id}`,
          tag: `pickup-${booking.id}`,
        });
      } catch (e) { console.error('[twilio] operator push failed:', e.message); }
      try {
        await smsSvc.notifyOperators(`${opBody}\nOpen: ${baseUrl}/operator`);
      } catch (e) { console.error('[twilio] operator sms failed:', e.message); }

      return twiml(res, `Got it ${firstName}! We'll be in touch shortly to confirm a pickup time.`);
    }

    if (upper.includes('EXTEND')) {
      return twiml(res, `No problem! Extensions are $0.30 per bin per day. How many extra days do you need? Or manage your booking at blackswamptotes.com/my-booking`);
    }

    // Recognized number but unrecognized command.
    return twiml(res, `Thanks ${firstName}! Reply READY to confirm pickup, or EXTEND to add more time. Questions? Call ${BUSINESS_PHONE}.`);
  } catch (err) {
    console.error('[twilio] inbound handler error:', err.message);
    // Still return valid TwiML so Twilio doesn't retry-storm.
    return twiml(res, 'Thanks for your message — we’ll follow up shortly.');
  }
});

module.exports = router;
