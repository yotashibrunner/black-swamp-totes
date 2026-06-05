'use strict';

// Hourly cron endpoint for automated booking reminders, called by an external
// scheduler (e.g. cron-job.org). Protected by a CRON_SECRET bearer token.
//
//   GET | POST  /api/cron/reminders
//   Authorization: Bearer <CRON_SECRET>
//
// Runs three best-effort jobs, each guarded by a boolean "sent" flag on the
// booking so re-runs are idempotent. SMS is env-gated via the Twilio service:
// when Twilio is unconfigured the send is a logged no-op (the booking is still
// flagged so it isn't reprocessed every hour) — set the TWILIO_* vars before
// going live, and watch `twilio_active` in the response.

const express = require('express');

const router = express.Router();

const { query } = require('../db');
const config = require('../config');
const smsSvc = require('../services/sms');

const BUSINESS_PHONE = '(419) 972-1669';

// Bearer-token guard. Fail closed with 503 when the server has no secret set;
// 401 when the caller's token is missing or wrong.
function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is not configured on the server.' });
  }
  if ((req.get('authorization') || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }
  return next();
}

// Text each matching booking and flip its flag. Marks the flag on a successful
// send or an intentional skip (Twilio off / no phone); leaves it unset on a hard
// send error so the next run retries. Returns the number processed.
async function runJob(rows, flagColumn, messageFor) {
  let count = 0;
  for (const b of rows) {
    const result = await smsSvc.sendSms(b.customer_phone, messageFor(b));
    if (!result.error) {
      await query(`UPDATE bookings SET ${flagColumn} = TRUE WHERE id = $1`, [b.id]);
      count += 1;
    }
  }
  return count;
}

const SELECT_COLS =
  `b.id, b.ref_code, c.name AS customer_name, c.phone AS customer_phone
     FROM bookings b JOIN customers c ON c.id = b.customer_id`;

async function handleReminders(req, res, next) {
  try {
    const ranAt = new Date().toISOString();

    // JOB 1 — pickup reminders: out, due in ~24h (23–25h), not yet reminded.
    const job1 = await query(
      `SELECT ${SELECT_COLS}
        WHERE b.status = 'out'
          AND b.end_at BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'
          AND b.pickup_reminder_sent IS NOT TRUE`
    );
    const reminders_sent = await runJob(job1.rows, 'pickup_reminder_sent', (b) =>
      `Hi ${b.customer_name || 'there'}, your Black Swamp Totes bins are due tomorrow. `
      + `Reply READY when you're set for pickup or EXTEND to add more time. Questions? ${BUSINESS_PHONE}`);

    // JOB 2 — overdue follow-up: out, past due, no READY yet, not yet notified.
    const job2 = await query(
      `SELECT ${SELECT_COLS}
        WHERE b.status = 'out'
          AND b.end_at < NOW()
          AND b.pickup_requested_at IS NULL
          AND b.overdue_notice_sent IS NOT TRUE`
    );
    const overdue_notices = await runJob(job2.rows, 'overdue_notice_sent', (b) =>
      `Hi ${b.customer_name || 'there'}, your Black Swamp Totes rental ended yesterday. `
      + `Please reply READY to schedule pickup or EXTEND at $0.30/bin/day. ${BUSINESS_PHONE}`);

    // JOB 3 — review requests: returned ~24h ago (23–25h), not yet asked. Only
    // runs when a review link is configured (otherwise the message is useless).
    const reviewLink = config.googleReviewLink || '';
    let review_requests = 0;
    if (reviewLink) {
      const job3 = await query(
        `SELECT ${SELECT_COLS}
          WHERE b.status = 'returned'
            AND b.returned_at > NOW() - INTERVAL '25 hours'
            AND b.returned_at < NOW() - INTERVAL '23 hours'
            AND b.review_request_sent IS NOT TRUE`
      );
      review_requests = await runJob(job3.rows, 'review_request_sent', (b) =>
        `Hi ${b.customer_name || 'there'}, thanks for using Black Swamp Totes! Hope your move went smoothly. `
        + `Would you mind leaving us a quick review? ${reviewLink} It means a lot 🌿`);
    }

    return res.json({
      ok: true,
      ran_at: ranAt,
      reminders_sent,
      overdue_notices,
      review_requests,
      twilio_active: smsSvc.isConfigured(),
    });
  } catch (err) {
    return next(err);
  }
}

router.get('/reminders', requireCronSecret, handleReminders);
router.post('/reminders', requireCronSecret, handleReminders);

module.exports = router;
