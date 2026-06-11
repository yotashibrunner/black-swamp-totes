'use strict';

// Booking lifecycle: create (pending) → sign (signed) → pay (paid). All money
// is recomputed server-side from the trailer + selection; client-sent totals
// are never trusted. Availability is re-checked inside the create transaction
// so two customers can't grab the same window.

const { pool } = require('../db');
const config = require('../config');
const trailerSvc = require('./trailer');
const couponsSvc = require('./coupons');
const { computeQuote, DELIVERY_FEE_CENTS } = require('./pricing');
const { OCCUPYING_STATUSES } = require('./availability');
const { buildAgreement, toPlainText, CONTRACT_VERSION } = require('./contract');
const { parseDateOnly, addDays, todayUTC, toDateOnly } = require('../utils/date');
const { refCode } = require('../utils/ref-code');
const { calcTax } = require('../utils/money');

// Statuses that commit physical bins (count toward the global inventory cap and
// the demand tracker). A booking holds bins from creation through pickup.
const GLOBAL_BIN_STATUSES = ['pending', 'signed', 'paid', 'confirmed', 'out'];

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
  if (trailer.type === 'bins') {
    // Bins price by the week: start = delivery date, end = pickup date.
    const dStart = parseDateOnly(input.start_at);
    const dEnd = parseDateOnly(input.end_at);
    if (!dStart || !dEnd || dEnd < dStart) throw badRequest('Valid delivery and pickup dates are required.');
    const binDays = Math.round((dEnd - dStart) / 86400000) + 1;
    // Complete weeks only; extra days are billed at the extension rate in pricing.
    const weeks = Math.max(1, Math.floor(binDays / 7));
    return { start: dStart, end: addDays(dEnd, 1), periodType: 'week', quantity: weeks };
  }
  if (input.period_type && input.period_type !== 'day') {
    throw badRequest('Online booking currently supports daily rentals. Please call (419) 262-2837 for hourly, weekly, or monthly rentals.');
  }
  const start = parseDateOnly(input.start_at);
  const end = parseDateOnly(input.end_at);
  if (!start || !end || end < start) throw badRequest('Valid pickup and return dates are required.');
  // Inclusive day rental: a Jun 10–12 selection occupies through Jun 12, so the
  // exclusive end is Jun 13.
  const days = Math.round((end - start) / 86400000) + 1;
  return { start, end: addDays(end, 1), periodType: 'day', quantity: days };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function findOrCreateCustomer(client, customer) {
  const name = (customer.name || '').trim();
  const email = (customer.email || '').trim().toLowerCase();
  const phone = (customer.phone || '').trim();
  if (!name || !phone) throw badRequest('Name and phone are required.');
  // Email is required so the confirmation + receipt always have a destination.
  if (!EMAIL_RE.test(email)) throw badRequest('A valid email address is required for your confirmation.');

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

  // The Rental Agreement / Liability Waiver must be accepted to book. We stamp
  // the server's current waiver version (authoritative — we know what was live)
  // along with the timestamp and the customer's IP, as the acceptance record.
  const termsAccepted = input.terms_accepted === true || input.terms_accepted === 'true';
  if (!termsAccepted) {
    throw badRequest('You must agree to the Rental Agreement and Liability Waiver to book.');
  }
  const termsVersion = config.termsVersion;
  const termsIp = (input.terms_ip || '').toString().slice(0, 64) || null;

  const { start, end, periodType, quantity } = resolveWindow(trailer, input);

  // Requested pickup/delivery time-of-day (HH:MM), stored as wall-clock UTC on
  // the start date. The date-based [start, end) window still drives availability.
  let startAt = start;
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(input.start_time || '').trim());
  if (tm) {
    const h = Math.min(23, parseInt(tm[1], 10));
    const m = Math.min(59, parseInt(tm[2], 10));
    startAt = new Date(start.getTime() + h * 3600000 + m * 60000);
  }

  const quote = await computeQuote(trailer, {
    period_type: periodType,
    start_at: input.start_at,
    end_at: input.end_at,
    extra_days: quantity,
    quantity,
    bin_quantity: input.bin_quantity,
  });

  const isDumpster = trailer.type === 'dumpster';
  const isBins = trailer.type === 'bins';
  const baseAmount = isDumpster ? trailer.flat_drop_off_cents : quote.base_cents;
  const extraCharges = isDumpster ? quote.base_cents - trailer.flat_drop_off_cents : 0;
  const tireCount = Math.max(0, Math.floor(Number(input.tire_count) || 0));

  // Bin/dolly counts (from the quote) saved on the booking.
  const binCount = isBins ? (quote.bin_count || 0) : 0;
  const dollyCount = isBins ? (quote.dolly_count || 0) : 0;

  // Fulfillment. Bins are ALWAYS delivered (free) — a delivery address is
  // required and a separate pickup address may be given. Trailers/dumpsters keep
  // the pickup-or-delivery (flat fee) choice.
  let fulfillment;
  let deliveryAddress = null;
  let pickupAddress = null;
  let deliveryFee = 0;
  if (isBins) {
    fulfillment = 'delivery';
    deliveryAddress = (input.delivery_address || '').trim();
    if (!deliveryAddress) throw badRequest('A delivery address is required — where should we bring your bins?');
    pickupAddress = (input.pickup_address || '').trim() || null;
  } else {
    fulfillment = input.fulfillment === 'delivery' ? 'delivery' : 'pickup';
    if (fulfillment === 'delivery') {
      deliveryAddress = (input.delivery_address || '').trim();
      if (!deliveryAddress) throw badRequest('A delivery address is required for delivery.');
      deliveryFee = DELIVERY_FEE_CENTS;
    }
  }

  // Optional discount code. Resolved + validated server-side (never trusted from
  // the client); throws a tagged error if a code is given but invalid.
  let couponId = null;
  let discountCents = 0;
  let couponFreeDelivery = false;
  if (input.coupon_code) {
    ({ couponId, discountCents, freeDelivery: couponFreeDelivery } = await couponsSvc.resolveForBooking({
      code: input.coupon_code,
      trailerId: trailer.id,
      baseAmountCents: quote.base_cents,
      deliveryFeeCents: deliveryFee,
      fulfillment,
    }));
  }

  // .edu student discount — 20% off the pre-tax package price. Does NOT stack
  // with a promo code: whichever discount is greater wins (no double discount).
  const customerEmail = ((input.customer && input.customer.email) || '').trim();
  const studentEligible = isBins && /\.edu$/i.test(customerEmail);
  const studentDiscountCents = studentEligible ? Math.round(quote.base_cents * 0.20) : 0;
  let studentDiscountApplied = false;
  if (studentDiscountCents > discountCents) {
    // Student discount beats the coupon — apply it and drop the coupon.
    studentDiscountApplied = true;
    couponId = null;
    discountCents = 0;
    couponFreeDelivery = false;
  }
  const studentDiscountFinal = studentDiscountApplied ? studentDiscountCents : 0;
  const appliedDiscount = studentDiscountApplied ? studentDiscountFinal : discountCents;

  // Sales tax is charged on the POST-discount taxable base (what the customer
  // actually pays), per Ohio. A percentage/flat code reduces the taxable base; a
  // free_delivery code reduces the (untaxed) delivery fee instead, so it must
  // NOT shrink the taxable base. Tax is recomputed here at the booking's rate
  // rather than reusing quote.tax_cents (which was computed pre-discount).
  const discountOnDelivery = !studentDiscountApplied && couponFreeDelivery;
  const baseDiscount = discountOnDelivery ? 0 : appliedDiscount;
  const deliveryDiscount = discountOnDelivery ? Math.min(deliveryFee, appliedDiscount) : 0;
  const taxRate = quote.tax_rate;
  const taxableBaseCents = Math.max(0, quote.base_cents - baseDiscount);
  const taxCents = calcTax(taxableBaseCents, taxRate);
  const totalCents = Math.max(0, taxableBaseCents + taxCents + (deliveryFee - deliveryDiscount));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-check availability. A blackout closes all units for the range; past
    // that, a unit must be free for the whole window — i.e. fewer than
    // capacity (= quantity_total - quantity_on_hold) occupying bookings overlap.
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const blackout = await client.query(
      `SELECT 1 FROM blackouts
        WHERE (trailer_id = $1 OR trailer_id IS NULL)
          AND start_at < $3 AND end_at > $2
        LIMIT 1`,
      [trailer.id, startIso, endIso]
    );
    if (blackout.rows.length) {
      throw badRequest('Those dates are blocked. Please pick another range.', 409);
    }
    const cap = Math.max(0, (trailer.quantity_total ?? 1) - (trailer.quantity_on_hold ?? 0));
    const overlap = await client.query(
      `SELECT count(*)::int AS n FROM bookings
        WHERE trailer_id = $1 AND status = ANY($2)
          AND start_at < $4 AND end_at > $3`,
      [trailer.id, OCCUPYING_STATUSES, startIso, endIso]
    );
    if (overlap.rows[0].n >= cap) {
      throw badRequest('Those dates are no longer available. Please pick another range.', 409);
    }

    // Global bin-inventory cap. Total bins committed across every booking that
    // overlaps this window must leave room for the requested bins, otherwise
    // we'd overbook the physical fleet. TOTAL_INVENTORY keeps a turnaround
    // buffer below the real bin count.
    if (isBins && binCount > 0) {
      const committed = await client.query(
        `SELECT COALESCE(SUM(bin_count), 0)::int AS bins_committed
           FROM bookings
          WHERE status = ANY($1)
            AND start_at::date <= $3::date
            AND end_at::date >= $2::date`,
        [GLOBAL_BIN_STATUSES, startIso, endIso]
      );
      if (committed.rows[0].bins_committed + binCount > config.totalInventory) {
        throw badRequest(
          "Those dates aren't available — we're fully booked. Please choose different dates or contact us at (419) 262-2837.",
          409
        );
      }
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
              customer_notes, status, fulfillment, delivery_address, delivery_fee_cents,
              coupon_id, discount_applied_cents, bin_count, dolly_count, pickup_address,
              student_discount_applied, discount_cents,
              tax_rate, discount_total_cents, payment_status,
              terms_accepted, terms_accepted_at, terms_version, terms_accepted_ip)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
              $24,$25,'unpaid',true,NOW(),$26,$27)
           RETURNING id, ref_code`,
          [ref, trailer.id, customerId, startAt.toISOString(), end.toISOString(), periodType, quantity,
            tireCount, baseAmount, extraCharges, taxCents, totalCents,
            (input.notes || '').trim() || null, fulfillment, deliveryAddress, deliveryFee,
            couponId, discountCents, binCount, dollyCount, pickupAddress,
            studentDiscountApplied, studentDiscountFinal,
            taxRate, appliedDiscount, termsVersion, termsIp]
        );
        booking = res.rows[0];
      } catch (e) {
        if (e.code === '23505') continue; // ref_code collision — retry
        throw e;
      }
    }
    if (!booking) throw new Error('Could not allocate a booking reference.');

    // Audit the creation (customer action — no operator).
    await client.query(
      `INSERT INTO audit_log (action, entity_type, entity_id, details)
       VALUES ('booking.create', 'booking', $1, $2)`,
      [booking.id, JSON.stringify({ ref: booking.ref_code, total_cents: totalCents, fulfillment })]
    );

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
            t.deposit_cents AS trailer_deposit_cents, t.deposit_enabled AS trailer_deposit_enabled,
            c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            m.name AS managed_by_name, cp.code AS coupon_code
       FROM bookings b
       JOIN trailers t ON t.id = b.trailer_id
       JOIN customers c ON c.id = b.customer_id
       LEFT JOIN admin_users m ON m.id = b.managed_by
       LEFT JOIN coupons cp ON cp.id = b.coupon_id
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
// `opts.customerEmail` is the address Stripe collected on its checkout page — we
// backfill it onto the customer when our own form left it blank, so the
// confirmation email always has somewhere to go. When a deposit was collected,
// `opts.customerId` / `opts.paymentMethodId` are the saved card (off-session)
// and `opts.depositCents` the held amount.
async function markPaidBySession(sessionId, opts = {}) {
  const {
    paymentIntentId = null, amountCents = 0, customerEmail = null,
    customerId = null, paymentMethodId = null, depositCents = 0,
    chargeId = null, feeCents = null,
  } = opts;
  const deposit = Math.max(0, Math.round(depositCents) || 0);
  const { rows } = await pool.query(
    `UPDATE bookings SET
       status = 'paid',
       payment_status = 'paid',
       paid_at = COALESCE(paid_at, NOW()),
       -- Stripe's amount_total includes the refundable deposit; the deposit is
       -- not revenue, so amount_paid_cents tracks only the rental balance.
       amount_paid_cents = GREATEST(COALESCE($2,0) - $6, 0),
       stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id),
       stripe_customer_id = COALESCE($4, stripe_customer_id),
       stripe_payment_method_id = COALESCE($5, stripe_payment_method_id),
       stripe_charge_id = COALESCE($7, stripe_charge_id),
       stripe_fee_cents = COALESCE($8, stripe_fee_cents),
       deposit_paid_cents = CASE WHEN $6 > 0 THEN $6 ELSE deposit_paid_cents END,
       deposit_status = CASE WHEN $6 > 0 THEN 'held' ELSE deposit_status END,
       updated_at = NOW()
     WHERE stripe_session_id = $1 AND status <> 'paid'
     RETURNING id, customer_id`,
    [sessionId, amountCents || 0, paymentIntentId || null, customerId, paymentMethodId, deposit,
      chargeId || null, feeCents == null ? null : Math.round(feeCents)]
  );
  if (!rows.length) return null; // unknown session or already paid

  // Audit the payment (Stripe-driven — no operator).
  await pool.query(
    `INSERT INTO audit_log (action, entity_type, entity_id, details)
     VALUES ('booking.paid', 'booking', $1, $2)`,
    [rows[0].id, JSON.stringify({ amount_cents: amountCents || 0 })]
  ).catch((e) => console.error('[booking] paid audit failed:', e.message));

  const email = (customerEmail || '').trim().toLowerCase();
  if (email) {
    // Only fill in when the customer record has no email yet.
    await pool.query(
      `UPDATE customers SET email = $2
        WHERE id = $1 AND (email IS NULL OR email = '')`,
      [rows[0].customer_id, email]
    ).catch((e) => console.error('[booking] email backfill failed:', e.message));
  }
  return getById(rows[0].id);
}

async function attachCheckoutSession(bookingId, sessionId) {
  await pool.query('UPDATE bookings SET stripe_session_id = $2, updated_at = NOW() WHERE id = $1',
    [bookingId, sessionId]);
}

// ── Operator views (Phase 6) ─────────────────────────────────────────────
// All rows below carry the trailer + customer fields the PWA renders, so the
// dashboard / schedule / detail screens never make a second round-trip.
const OPERATOR_SELECT = `
  SELECT b.id, b.ref_code, b.status, b.start_at, b.end_at, b.period_type, b.quantity,
         b.total_cents, b.amount_paid_cents, b.tire_count,
         b.picked_up_at, b.returned_at, b.customer_notes, b.operator_notes,
         b.contract_signed_at, b.contract_signed_name, b.created_at,
         b.fulfillment, b.delivery_address, b.delivery_fee_cents,
         b.bin_count, b.dolly_count, b.pickup_address, b.pickup_requested_at,
         b.deposit_paid_cents, b.deposit_refunded_cents, b.deposit_status,
         b.stripe_customer_id, b.stripe_payment_method_id, b.stripe_payment_intent_id,
         b.coupon_id, b.discount_applied_cents, cp.code AS coupon_code,
         t.id AS trailer_id, t.name AS trailer_name, t.type AS trailer_type,
         t.slug AS trailer_slug, t.size_label, t.status AS trailer_status,
         t.deposit_cents AS trailer_deposit_cents, t.deposit_enabled AS trailer_deposit_enabled,
         c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
    FROM bookings b
    JOIN trailers t ON t.id = b.trailer_id
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN coupons cp ON cp.id = b.coupon_id`;

// Statuses that represent an upcoming, confirmed-but-not-yet-out rental.
const UPCOMING_STATUSES = ['paid', 'confirmed'];
// A booking that is scheduled but not yet out (delivery still ahead).
const DELIVER_STATUSES = ['pending', 'signed', 'paid', 'confirmed'];

// Operator dashboard — only what needs action today, plus a 3-day heads-up:
//   dropoffs        — being delivered today (scheduled, not yet out)
//   pickupRequested — customer texted READY (out); action ASAP, floats to top
//   retrievals      — scheduled pickup due today/overdue (out, no READY yet)
//   upcoming        — deliveries in the next 3 days (heads-up only, no action)
// Mid-rental ("active") and completed ("returned") bookings are intentionally
// excluded — they aren't actionable today and only add clutter. "Today" is
// UTC-anchored, matching availability/calendar reasoning (utils/date.js).
async function getDashboard() {
  const today = todayUTC();
  const t0 = today.toISOString();
  const t1 = addDays(today, 1).toISOString(); // tomorrow 00:00 — exclusive end of "today"
  const t4 = addDays(today, 4).toISOString(); // today+4 00:00 — exclusive end of the +1..+3 window

  // DELIVER TODAY — delivery (start) date is today, not yet out.
  const dropoffs = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status = ANY($1) AND b.start_at >= $2 AND b.start_at < $3
      ORDER BY b.start_at, t.name`,
    [DELIVER_STATUSES, t0, t1]
  );

  // PICKUP REQUESTED — customer texted READY, still out. Action ASAP.
  const pickupRequested = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status = 'out' AND b.pickup_requested_at IS NOT NULL
      ORDER BY b.pickup_requested_at, b.end_at, t.name`
  );

  // PICKUP TODAY — scheduled pickup due today (or overdue), out, no READY yet.
  const retrievals = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status = 'out' AND b.pickup_requested_at IS NULL AND b.end_at < $1
      ORDER BY b.end_at, t.name`,
    [t1]
  );

  // COMING UP — deliveries in the next 3 days (today+1 .. today+3). Heads-up only.
  const upcoming = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status = ANY($1) AND b.start_at >= $2 AND b.start_at < $3
      ORDER BY b.start_at, t.name`,
    [DELIVER_STATUSES, t1, t4]
  );

  return {
    dropoffs: dropoffs.rows,
    pickupRequested: pickupRequested.rows,
    retrievals: retrievals.rows,
    upcoming: upcoming.rows,
  };
}

// Bin demand tracker: bins committed per day across the next 30 days plus the
// active bookings driving them, for the operator inventory screen.
async function getBinDemand() {
  const daysRes = await pool.query(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(b.bin_count), 0)::int AS bins_committed
       FROM generate_series(CURRENT_DATE, CURRENT_DATE + 30, '1 day') d(day)
       LEFT JOIN bookings b
         ON b.start_at::date <= d.day
        AND b.end_at::date >= d.day
        AND b.status = ANY($1)
      GROUP BY d.day
      ORDER BY d.day`,
    [GLOBAL_BIN_STATUSES]
  );
  const bookingsRes = await pool.query(
    `SELECT b.ref_code, b.bin_count,
            to_char(b.start_at, 'YYYY-MM-DD') AS start_date,
            to_char(b.end_at, 'YYYY-MM-DD') AS end_date,
            c.name AS customer_name, t.name AS package_name
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN trailers t ON t.id = b.trailer_id
      WHERE b.status = ANY($1)
        AND b.start_at::date <= CURRENT_DATE + 30
        AND b.end_at::date >= CURRENT_DATE
      ORDER BY b.start_at, t.name`,
    [GLOBAL_BIN_STATUSES]
  );
  return {
    total_inventory: config.totalInventory,
    days: daysRes.rows,
    bookings: bookingsRes.rows,
  };
}

// All bookings touching a given 'YYYY-MM-DD' date, chronological. A booking is
// included if its [start, end) window overlaps the day; each row is tagged with
// whether the pickup and/or return falls on that day so the PWA can label it.
async function getSchedule(dateStr) {
  const day = parseDateOnly(dateStr);
  if (!day) throw badRequest('A valid date (YYYY-MM-DD) is required.');
  const next = addDays(day, 1);
  const d0 = day.toISOString();
  const d1 = next.toISOString();

  const { rows } = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status <> 'cancelled'
        AND b.start_at < $2 AND b.end_at > $1
      ORDER BY b.start_at, b.end_at, t.name`,
    [d0, d1]
  );

  const bookings = rows.map((r) => ({
    ...r,
    is_pickup_day: r.start_at >= day && r.start_at < next,
    // end_at is exclusive: a booking whose last rental day is `day` ends at the
    // following midnight, so the return falls on `day` when end is in (d0, d1].
    is_return_day: r.end_at > day && r.end_at <= next,
  }));

  return { date: toDateOnly(day), bookings };
}

// All non-cancelled bookings whose [start, end) window overlaps [from, to).
// Backs the operator calendar; each row carries trailer + customer fields for
// color-coding and labels.
async function getBookingsInRange(from, to) {
  const { rows } = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status <> 'cancelled'
        AND b.start_at < $2 AND b.end_at > $1
      ORDER BY b.start_at, t.name`,
    [from, to]
  );
  return rows;
}

// Allowed operator status transitions and the timestamp each one stamps.
const TRANSITIONS = {
  out: { from: UPCOMING_STATUSES, stamp: 'picked_up_at' },        // Mark Picked Up
  returned: { from: ['out'], stamp: 'returned_at' },              // Mark Returned
};

// Apply an operator update to a booking: a status transition (mark picked up /
// returned) and/or operator notes. On return, the trailer flips back to
// available. Runs in one transaction with an audit-log entry. Returns the
// updated booking detail (getById shape), or throws a tagged Error.
async function updateBooking(id, patch, adminUserId) {
  if (!UUID_RE.test(id)) throw badRequest('Invalid booking id.');

  const hasStatus = patch.status !== undefined;
  const hasNotes = patch.operator_notes !== undefined;
  if (!hasStatus && !hasNotes) throw badRequest('No fields to update.');

  let transition = null;
  if (hasStatus) {
    transition = TRANSITIONS[patch.status];
    if (!transition) throw badRequest("status must be 'out' or 'returned'.");
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row so concurrent operators can't double-transition it.
    const cur = await client.query(
      'SELECT id, status, trailer_id FROM bookings WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!cur.rows.length) throw badRequest('Booking not found.', 404);
    const booking = cur.rows[0];

    const sets = ['updated_at = NOW()'];
    const values = [];

    if (transition) {
      if (!transition.from.includes(booking.status)) {
        throw badRequest(
          `Cannot move a '${booking.status}' booking to '${patch.status}'.`,
          409
        );
      }
      values.push(patch.status);
      sets.push(`status = $${values.length}`);
      sets.push(`${transition.stamp} = NOW()`);
      // Attribute the status change to the operator who made it.
      values.push(adminUserId || null);
      sets.push(`managed_by = $${values.length}`);
    }

    if (hasNotes) {
      const notes = patch.operator_notes;
      if (notes !== null && typeof notes !== 'string') {
        throw badRequest('operator_notes must be a string or null.');
      }
      values.push(notes === null ? null : notes.trim() || null);
      sets.push(`operator_notes = $${values.length}`);
    }

    values.push(id);
    await client.query(
      `UPDATE bookings SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values
    );

    // Returning a trailer frees it for the next renter.
    if (patch.status === 'returned') {
      await client.query(
        `UPDATE trailers SET status = 'available', updated_at = NOW()
          WHERE id = $1 AND status <> 'out_of_service'`,
        [booking.trailer_id]
      );
    }

    await client.query(
      `INSERT INTO audit_log (admin_user_id, action_by, action, entity_type, entity_id, details)
       VALUES ($1, $1, 'booking.update', 'booking', $2, $3)`,
      [adminUserId || null, id, JSON.stringify({
        status: hasStatus ? patch.status : undefined,
        notes_changed: hasNotes || undefined,
      })]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return getById(id);
}

module.exports = {
  createBooking, getById, getByRef, signBooking, markPaidBySession,
  attachCheckoutSession, buildAgreementFor,
  getDashboard, getSchedule, updateBooking, getBookingsInRange, getBinDemand,
};
