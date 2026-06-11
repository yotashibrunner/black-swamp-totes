'use strict';

// Public (no-auth) JSON API for the customer booking surface.
//   GET  /api/trailers                         active fleet + current status
//   GET  /api/trailers/:slug                   one trailer's public detail
//   GET  /api/trailers/:slug/availability      busy ranges over a date window
//   POST /api/quote                            live price for a selection
//
// /api/quote is rate-limited (plan §13: 30/min/IP) since it hits the DB and is
// the one public endpoint that accepts a body.

const express = require('express');
const { query } = require('../db');
const { rateLimit } = require('../middleware/rate-limit');
const trailerSvc = require('../services/trailer');
const bookingSvc = require('../services/booking');
const stripeSvc = require('../services/stripe');
const settingsSvc = require('../services/settings');
const chargesSvc = require('../services/charges');
const couponsSvc = require('../services/coupons');
const { generatePdf } = require('../services/contract');
const { getBusyRanges } = require('../services/availability');
const { computeQuote, priceWithDiscounts, DELIVERY_FEE_CENTS } = require('../services/pricing');
const { formatCents } = require('../utils/money');
const { todayUTC, addDays, parseDateOnly, toDateOnly } = require('../utils/date');

const router = express.Router();

const HORIZON_DAYS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many quote requests, slow down.',
});

// Booking creation holds a slot, so cap it per IP to deter spam/abandoned holds.
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: 'Too many booking attempts, please wait a moment.',
});

// GET /api/impact — cumulative environmental impact across completed rentals.
// Conversion factors are deliberately conservative, round numbers.
const BOXES_PER_BIN = 1;
const LBS_PER_BOX = 2.5;
const BOXES_PER_TREE = 13;
router.get('/impact', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS rentals_completed, COALESCE(SUM(bin_count), 0)::int AS total_bins
         FROM bookings WHERE status = 'returned'`
    );
    const totalBins = rows[0].total_bins || 0;
    const boxes = totalBins * BOXES_PER_BIN;
    res.json({
      boxes_saved: boxes,
      lbs_saved: Math.round(boxes * LBS_PER_BOX),
      trees_saved: Math.floor(boxes / BOXES_PER_TREE),
      rentals_completed: rows[0].rentals_completed || 0,
    });
  } catch (err) {
    next(err);
  }
});

// Attach formatted dollar strings so the client doesn't reimplement money math.
function withFormatted(t) {
  return {
    ...t,
    hourly_rate_fmt: formatCents(t.hourly_rate),
    daily_rate_fmt: formatCents(t.daily_rate),
    weekly_rate_fmt: formatCents(t.weekly_rate),
    monthly_rate_fmt: formatCents(t.monthly_rate),
    flat_drop_off_fmt: formatCents(t.flat_drop_off_cents),
    extra_day_fmt: formatCents(t.extra_day_cents),
    per_tire_fmt: formatCents(t.per_tire_cents),
  };
}

router.get('/trailers', async (req, res, next) => {
  try {
    const trailers = await trailerSvc.getActiveTrailers();
    res.json({ trailers: trailers.map(withFormatted) });
  } catch (err) {
    next(err);
  }
});

router.get('/trailers/:slug', async (req, res, next) => {
  try {
    const trailer = await trailerSvc.getTrailerBySlug(req.params.slug);
    if (!trailer) return res.status(404).json({ error: 'Trailer not found' });
    res.json({ trailer: withFormatted(trailer) });
  } catch (err) {
    next(err);
  }
});

// GET /api/trailers/:slug/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
// Defaults to a 60-day horizon starting today; clamps any wider request.
router.get('/trailers/:slug/availability', async (req, res, next) => {
  try {
    const trailer = await trailerSvc.getTrailerBySlug(req.params.slug);
    if (!trailer) return res.status(404).json({ error: 'Trailer not found' });

    const today = todayUTC();
    const horizonEnd = addDays(today, HORIZON_DAYS);

    let from = parseDateOnly(req.query.from) || today;
    let to = parseDateOnly(req.query.to) || horizonEnd;
    if (from < today) from = today;
    if (to > horizonEnd) to = horizonEnd;
    if (to < from) to = from;

    // An out-of-service trailer is busy for the entire horizon.
    let busy;
    if (trailer.status !== 'available') {
      busy = [{ start_at: from.toISOString(), end_at: to.toISOString(), reason: 'out_of_service' }];
    } else {
      busy = await getBusyRanges(trailer, from.toISOString(), to.toISOString());
    }

    res.json({
      slug: trailer.slug,
      status: trailer.status,
      from: toDateOnly(from),
      to: toDateOnly(to),
      horizon_days: HORIZON_DAYS,
      busy,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/quote — { trailer_id | slug, period_type, start_at?, end_at?,
//                     quantity?, extra_days?, tire_count? }
router.post('/quote', quoteLimiter, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { trailer_id: trailerId, slug } = body;

    let trailer = null;
    if (trailerId && UUID_RE.test(trailerId)) {
      trailer = await trailerSvc.getTrailerById(trailerId);
    } else if (slug) {
      trailer = await trailerSvc.getTrailerBySlug(slug);
    } else {
      return res.status(400).json({ error: 'A trailer_id or slug is required.' });
    }
    if (!trailer) return res.status(404).json({ error: 'Trailer not found' });

    const quote = await computeQuote(trailer, body);

    // Discount-aware pricing (single source shared with createBooking). The
    // delivery fee applies only to a trailer/dumpster delivery — bins are free.
    const isBins = trailer.type === 'bins';
    const deliveryFee = (!isBins && body.fulfillment === 'delivery') ? DELIVERY_FEE_CENTS : 0;

    // Validate an optional code without throwing; surface validity to the form.
    let couponDiscountCents = 0;
    let couponFreeDelivery = false;
    let couponInfo = null;
    if (body.coupon_code && String(body.coupon_code).trim()) {
      const v = await couponsSvc.validateCoupon({
        code: body.coupon_code, trailerId: trailer.id, baseAmountCents: quote.base_cents,
      });
      if (v.valid) {
        couponFreeDelivery = !!v.free_delivery;
        couponDiscountCents = couponFreeDelivery ? deliveryFee : (v.discount_applied_cents || 0);
        couponInfo = { valid: true, code: v.code, line_label: v.line_label, message: v.message };
      } else {
        couponInfo = { valid: false, message: v.message };
      }
    }

    // .edu student discount applies to bins only (matches createBooking).
    const email = String(body.customer_email || '').trim();
    const studentEligible = isBins && /\.edu$/i.test(email);

    const priced = priceWithDiscounts(quote, {
      studentEligible, couponDiscountCents, couponFreeDelivery, deliveryFeeCents: deliveryFee,
    });

    res.json({
      trailer: { id: trailer.id, slug: trailer.slug, name: trailer.name, type: trailer.type },
      ...quote,
      // Discounted, authoritative display numbers (override quote's pre-discount tax/total).
      delivery_fee_cents: deliveryFee,
      student_discount_applied: priced.student_discount_applied,
      discount_cents: priced.discount_total_cents,
      tax_cents: priced.tax_cents,
      total_cents: priced.total_cents,
      coupon: couponInfo,
      base_fmt: formatCents(quote.base_cents),
      discount_fmt: formatCents(priced.discount_total_cents),
      tax_fmt: formatCents(priced.tax_cents),
      total_fmt: formatCents(priced.total_cents),
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// POST /api/coupons/validate — { code, trailer_id?, base_amount_cents }.
// Returns the discount result (or { valid:false, message }). Rate-limited to
// deter brute-forcing codes.
router.post('/coupons/validate', quoteLimiter, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await couponsSvc.validateCoupon({
      code: body.code,
      trailerId: body.trailer_id || null,
      baseAmountCents: Math.max(0, parseInt(body.base_amount_cents, 10) || 0),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Absolute origin for Stripe redirects, honoring the proxy (trust proxy is set).
function originOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// POST /api/bookings — create a pending booking, return { id, ref_code }.
router.post('/bookings', bookingLimiter, async (req, res, next) => {
  try {
    // Capture the customer's IP at terms acceptance (dispute evidence). trust
    // proxy is set, so req.ip is the real client address behind Railway's proxy.
    const result = await bookingSvc.createBooking({ ...(req.body || {}), terms_ip: req.ip });
    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/bookings/:id/sign — capture the e-signature (typed name + optional
// drawn signature) with IP, user-agent, timestamp, and contract version.
router.post('/bookings/:id/sign', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.agree || !body.consent) {
      return res.status(400).json({ error: 'You must agree to the rental agreement and consent to sign electronically.' });
    }
    const booking = await bookingSvc.signBooking(req.params.id, {
      name: body.name,
      signatureImage: body.signature_image,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ ok: true, id: booking.id, ref_code: booking.ref_code, status: booking.status });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/bookings/:id/checkout — Stripe Checkout session for the full
// balance. Booking must be signed. Returns { url } or 503 if unconfigured.
router.post('/bookings/:id/checkout', async (req, res, next) => {
  try {
    const booking = await bookingSvc.getById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'paid' || booking.payment_status === 'paid') {
      return res.json({ already_paid: true, redirect: `/book/${booking.ref_code}` });
    }
    if (booking.status === 'expired' || booking.status === 'cancelled') {
      return res.status(409).json({ error: 'This booking has expired — please start a new booking.' });
    }
    // Must be signed first (status advances to 'pending_payment' on signature;
    // 'signed' is the legacy pre-fix value, still payable).
    if (!booking.contract_signed_at || !['pending_payment', 'signed'].includes(booking.status)) {
      return res.status(409).json({ error: 'Please sign the rental agreement before paying.' });
    }

    const origin = originOf(req);
    // Refundable security deposit, when the global toggle + this trailer call
    // for one. Added as a separate line item; the card is saved off-session.
    const depositsOn = await settingsSvc.depositsEnabled();
    const depositCents = chargesSvc.depositDueCents(booking, depositsOn);
    const session = await stripeSvc.createCheckoutSession(booking, {
      successUrl: `${origin}/book/${booking.ref_code}?paid=1`,
      cancelUrl: `${origin}/book/${booking.id}/contract`,
      depositCents,
    });
    await bookingSvc.attachCheckoutSession(booking.id, session.id);
    res.json({ url: session.url });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

// POST /api/bookings/:ref/cancel — customer self-service cancellation. The ref
// code is the secret (no auth). Refund per the 48-hour policy; deposit always
// refunded in full.
router.post('/bookings/:ref/cancel', bookingLimiter, async (req, res, next) => {
  try {
    const result = await chargesSvc.cancelBooking(req.params.ref);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/bookings/:ref — public booking lookup (limited fields).
router.get('/bookings/:ref', async (req, res, next) => {
  try {
    const b = await bookingSvc.getByRef(req.params.ref);
    if (!b) return res.status(404).json({ error: 'Booking not found' });

    // Cancellation eligibility + refund hint, mirroring services/charges.js
    // (the server re-checks authoritatively on cancel).
    const now = Date.now();
    const start = new Date(b.start_at).getTime();
    const cancellable = ['paid', 'confirmed'].includes(b.status) && now < start;
    let refundHint = null;
    if (cancellable) {
      refundHint = (start - now > 48 * 3600 * 1000)
        ? 'Cancel now for a full refund.'
        : 'Less than 48 hours to pickup — a 50% refund applies.';
    } else if (['paid', 'confirmed'].includes(b.status)) {
      refundHint = 'The rental window has started — cancellation isn’t available online.';
    }

    res.json({
      ref_code: b.ref_code,
      status: b.status,
      trailer: b.trailer_name,
      fulfillment: b.fulfillment,
      start_at: b.start_at,
      end_at: b.end_at,
      total_fmt: formatCents(b.total_cents),
      amount_paid_fmt: formatCents(b.amount_paid_cents),
      deposit_status: b.deposit_status,
      deposit_paid_fmt: formatCents(b.deposit_paid_cents),
      signed: !!b.contract_signed_at,
      cancellable,
      refund_hint: refundHint,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings/:ref/contract.pdf — the signed agreement, generated on
// demand from the immutable snapshot.
router.get('/bookings/:ref/contract.pdf', async (req, res, next) => {
  try {
    const b = await bookingSvc.getByRef(req.params.ref);
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (!b.contract_signed_at || !b.contract_snapshot) {
      return res.status(409).json({ error: 'This booking has not been signed yet.' });
    }
    const pdf = await generatePdf(b);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="rental-agreement-${b.ref_code}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
