'use strict';

// Booking lifecycle: create (pending) → sign (signed) → pay (paid). All money
// is recomputed server-side from the trailer + selection; client-sent totals
// are never trusted. Availability is re-checked inside the create transaction
// so two customers can't grab the same window.

const { pool } = require('../db');
const trailerSvc = require('./trailer');
const { computeQuote } = require('./pricing');
const { OCCUPYING_STATUSES } = require('./availability');
const { buildAgreement, toPlainText, CONTRACT_VERSION } = require('./contract');
const { parseDateOnly, addDays } = require('../utils/date');
const { refCode } = require('../utils/ref-code');

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the rental window [start, end) as UTC instants. end is exclusive so
// overlap checks are clean. Returns { start, end, periodType, quantity }.
function resolveWindow(trailer, input) {
  if (trailer.type === 'dumpster') {
    const drop = parseDateOnly(input.start_at || input.drop_date);
    if (!drop) throw badRequest('A drop-off date is required.');
    const extraDays = Math.max(0, Math.floor(Number(input.extra_days ?? input.quantity ?? 0)) || 0);
    const totalDays = (trailer.flat_drop_off_days || 0) + extraDays;
    return { start: drop, end: addDays(drop, totalDays), periodType: 'roll_off', quantity: extraDays };
  }
  if (input.period_type && input.period_type !== 'day') {
    throw badRequest('Online booking currently supports daily rentals. Please call (419) 654-3584 for hourly, weekly, or monthly rentals.');
  }
  const start = parseDateOnly(input.start_at);
  const end = parseDateOnly(input.end_at);
  if (!start || !end || end < start) throw badRequest('Valid pickup and return dates are required.');
  // Inclusive day rental: a Jun 10–12 selection occupies through Jun 12, so the
  // exclusive end is Jun 13.
  const days = Math.round((end - start) / 86400000) + 1;
  return { start, end: addDays(end, 1), periodType: 'day', quantity: days };
}

async function findOrCreateCustomer(client, customer) {
  const name = (customer.name || '').trim();
  const email = (customer.email || '').trim().toLowerCase();
  const phone = (customer.phone || '').trim();
  if (!name || !phone) throw badRequest('Name and phone are required.');

  const found = await client.query(
    'SELECT id FROM customers WHERE lower(email) = $1 AND phone = $2 LIMIT 1',
    [email, phone]
  );
  if (found.rows.length) return found.rows[0].id;

  const inserted = await client.query(
    'INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
    [name, email, phone]
  );
  return inserted.rows[0].id;
}

async function createBooking(input) {
  // Resolve the trailer up front (read-only).
  let trailer = null;
  if (input.trailer_id && UUID_RE.test(input.trailer_id)) {
    trailer = await trailerSvc.getTrailerById(input.trailer_id);
  } else if (input.slug) {
    trailer = await trailerSvc.getTrailerBySlug(input.slug);
  }
  if (!trailer) throw badRequest('Trailer not found.', 404);
  if (trailer.status !== 'available') throw badRequest('This item is currently unavailable.', 409);

  const { start, end, periodType, quantity } = resolveWindow(trailer, input);
  const quote = await computeQuote(trailer, {
    period_type: periodType,
    start_at: input.start_at,
    end_at: input.end_at,
    extra_days: quantity,
    quantity,
  });

  const isDumpster = trailer.type === 'dumpster';
  const baseAmount = isDumpster ? trailer.flat_drop_off_cents : quote.base_cents;
  const extraCharges = isDumpster ? quote.base_cents - trailer.flat_drop_off_cents : 0;
  const tireCount = Math.max(0, Math.floor(Number(input.tire_count) || 0));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-check availability against other occupying bookings + blackouts.
    const conflict = await client.query(
      `SELECT 1 FROM bookings
        WHERE trailer_id = $1 AND status = ANY($2)
          AND start_at < $4 AND end_at > $3
        UNION ALL
        SELECT 1 FROM blackouts
        WHERE (trailer_id = $1 OR trailer_id IS NULL)
          AND start_at < $4 AND end_at > $3
        LIMIT 1`,
      [trailer.id, OCCUPYING_STATUSES, start.toISOString(), end.toISOString()]
    );
    if (conflict.rows.length) {
      throw badRequest('Those dates are no longer available. Please pick another range.', 409);
    }

    const customerId = await findOrCreateCustomer(client, input.customer || {});

    // Unique ref_code with a couple of retries on the unlikely collision.
    let booking = null;
    for (let attempt = 0; attempt < 5 && !booking; attempt++) {
      const ref = refCode();
      try {
        const res = await client.query(
          `INSERT INTO bookings
             (ref_code, trailer_id, customer_id, start_at, end_at, period_type, quantity,
              tire_count, base_amount_cents, extra_charges_cents, tax_cents, total_cents,
              customer_notes, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
           RETURNING id, ref_code`,
          [ref, trailer.id, customerId, start.toISOString(), end.toISOString(), periodType, quantity,
            tireCount, baseAmount, extraCharges, quote.tax_cents, quote.total_cents,
            (input.notes || '').trim() || null]
        );
        booking = res.rows[0];
      } catch (e) {
        if (e.code === '23505') continue; // ref_code collision — retry
        throw e;
      }
    }
    if (!booking) throw new Error('Could not allocate a booking reference.');

    await client.query('COMMIT');
    return { id: booking.id, ref_code: booking.ref_code };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Booking joined with its trailer + customer, by id or ref_code.
async function fetchBooking(where, value) {
  const { rows } = await pool.query(
    `SELECT b.*,
            t.name AS trailer_name, t.type AS trailer_type, t.slug AS trailer_slug,
            t.size_label, t.hitch_requirement, t.plug_requirement, t.per_tire_cents,
            c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
       FROM bookings b
       JOIN trailers t ON t.id = b.trailer_id
       JOIN customers c ON c.id = b.customer_id
      WHERE ${where} = $1`,
    [value]
  );
  return rows[0] || null;
}

const getById = (id) => fetchBooking('b.id', id);
const getByRef = (ref) => fetchBooking('b.ref_code', ref);

// Shape a booking row into the {booking, trailer, customer} the contract
// builder expects.
function asAgreementInput(row) {
  return {
    booking: row,
    trailer: {
      name: row.trailer_name, type: row.trailer_type, size_label: row.size_label,
      hitch_requirement: row.hitch_requirement, plug_requirement: row.plug_requirement,
      per_tire_cents: row.per_tire_cents,
    },
    customer: { name: row.customer_name, email: row.customer_email, phone: row.customer_phone },
  };
}

function buildAgreementFor(row) {
  return buildAgreement(asAgreementInput(row));
}

// Capture the e-signature and lock the immutable snapshot. Booking must be
// pending. Returns the updated booking row.
async function signBooking(id, sig) {
  const row = await getById(id);
  if (!row) throw badRequest('Booking not found.', 404);
  if (row.status === 'signed' || row.status === 'paid') {
    return row; // already signed — idempotent
  }
  if (row.status !== 'pending') throw badRequest('This booking can no longer be signed.', 409);

  const name = (sig.name || '').trim();
  if (!name) throw badRequest('A typed signature name is required.');

  const agreement = buildAgreement(asAgreementInput(row));
  const snapshot = toPlainText(agreement);

  await pool.query(
    `UPDATE bookings SET
       status = 'signed',
       contract_version = $2,
       contract_signed_at = NOW(),
       contract_signed_name = $3,
       contract_signed_ip = $4,
       contract_signed_user_agent = $5,
       contract_signature_image = $6,
       contract_snapshot = $7,
       updated_at = NOW()
     WHERE id = $1`,
    [id, CONTRACT_VERSION, name, sig.ip || null, sig.userAgent || null,
      sig.signatureImage || null, snapshot]
  );
  return getById(id);
}

// Mark a booking paid from a Stripe checkout session. Idempotent.
async function markPaidBySession(sessionId, paymentIntentId, amountCents) {
  const { rows } = await pool.query(
    `UPDATE bookings SET
       status = 'paid',
       amount_paid_cents = $2,
       stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id),
       updated_at = NOW()
     WHERE stripe_session_id = $1 AND status <> 'paid'
     RETURNING id`,
    [sessionId, amountCents || 0, paymentIntentId || null]
  );
  if (!rows.length) return null; // unknown session or already paid
  return getById(rows[0].id);
}

async function attachCheckoutSession(bookingId, sessionId) {
  await pool.query('UPDATE bookings SET stripe_session_id = $2, updated_at = NOW() WHERE id = $1',
    [bookingId, sessionId]);
}

module.exports = {
  createBooking, getById, getByRef, signBooking, markPaidBySession,
  attachCheckoutSession, buildAgreementFor,
};
