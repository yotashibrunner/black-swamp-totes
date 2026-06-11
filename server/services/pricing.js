'use strict';

// Quote calculation — pickup only, no delivery in v1. All money is integer
// cents. Returns the base, the tax (rate from settings), the total, and a
// human-readable line-item breakdown for the live quote panel.
//
// Trailers price by period (hour/day/week/month). When a date range is given
// for a day rental, the day count is derived server-side from the dates rather
// than trusted from the client. Roll-off dumpsters use flat drop-off pricing
// plus optional extra days; per-tire fees are NOT charged up front (only if
// tires are found at return), so they're excluded from the quote total.

const { calcTax } = require('../utils/money');
const { inclusiveDays } = require('../utils/date');
const { getTaxRate, extensionRatePerBinCents } = require('./settings');

const PERIOD_COLUMN = {
  hour: 'hourly_rate',
  day: 'daily_rate',
  week: 'weekly_rate',
  month: 'monthly_rate',
};
const PERIOD_NOUN = { hour: 'hour', day: 'day', week: 'week', month: 'month' };

// Flat local-delivery fee (cents). Pickup is free. Added on top of base + tax
// when the customer chooses delivery.
const DELIVERY_FEE_CENTS = 6000; // $60

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function clampInt(value, min) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, n);
}

// Bin rental period from the delivery→pickup range (inclusive). Complete weeks
// bill at weekly_rate; days beyond the last full week bill at the per-bin
// extension rate (NOT rounded up to another full week). Minimum one week.
//   7 days  → 1 week, 0 extra      8 days  → 1 week, 1 extra day
//   14 days → 2 weeks, 0 extra     13 days → 1 week, 6 extra days
function computeBinPeriod(input) {
  if (input.start_at && input.end_at) {
    const days = inclusiveDays(input.start_at, input.end_at);
    if (days == null) throw badRequest('Invalid date range.');
    const weeks = Math.max(1, Math.floor(days / 7));
    const extraDays = Math.max(0, days - weeks * 7);
    return { weeks, extraDays };
  }
  return { weeks: clampInt(input.weeks ?? input.quantity ?? 1, 1), extraDays: 0 };
}

async function computeQuote(trailer, input) {
  const periodType = input.period_type;
  let baseCents;
  let quantity;
  const lineItems = [];

  // ── Reusable moving bins (Black Swamp Totes) ──────────────────────────────
  // Priced per week. Fixed packages charge weekly_rate; the custom package
  // charges weekly_rate (per-bin-per-week) × bin count. Delivery is always free.
  if (trailer.type === 'bins') {
    if (trailer.weekly_rate == null) throw badRequest('This package is not available.');
    const { weeks, extraDays } = computeBinPeriod(input);
    const binCount = trailer.is_custom
      ? Math.max(10, clampInt(input.bin_quantity ?? input.bin_count ?? 0, 10))
      : (trailer.bin_count || 0);
    const dollyCount = trailer.is_custom ? Math.max(1, Math.ceil(binCount / 25)) : (trailer.dolly_count || 0);
    const perWeek = trailer.is_custom ? trailer.weekly_rate * binCount : trailer.weekly_rate;
    const weekBase = perWeek * weeks;

    // Extra days beyond full weeks bill at the per-bin extension rate.
    const extRate = await extensionRatePerBinCents();
    const extensionCents = extraDays > 0 ? extRate * binCount * extraDays : 0;
    baseCents = weekBase + extensionCents;

    lineItems.push({
      label: trailer.is_custom
        ? `${binCount} bins × ${weeks} week${weeks > 1 ? 's' : ''} @ $${(trailer.weekly_rate / 100).toFixed(2)}/bin/wk`
        : `${binCount} bins · ${weeks} week${weeks > 1 ? 's' : ''}`,
      amount_cents: weekBase,
    });
    if (extraDays > 0) {
      lineItems.push({
        label: `${extraDays} extra day${extraDays > 1 ? 's' : ''} · ${binCount} bins @ $${(extRate / 100).toFixed(2)}/bin/day`,
        amount_cents: extensionCents,
      });
    }

    const taxRate = await getTaxRate();
    const taxCents = calcTax(baseCents, taxRate);
    return {
      period_type: 'week', quantity: weeks, weeks, extra_days: extraDays,
      bin_count: binCount, dolly_count: dollyCount, extension_rate_per_bin_cents: extRate,
      base_cents: baseCents, tax_rate: taxRate, tax_cents: taxCents,
      total_cents: baseCents + taxCents, line_items: lineItems,
    };
  }

  if (periodType === 'roll_off' || trailer.type === 'dumpster') {
    if (trailer.flat_drop_off_cents == null) {
      throw badRequest('This item is not offered as a drop-off rental.');
    }
    const extraDays = clampInt(input.extra_days ?? input.quantity ?? 0, 0);
    const dropCents = trailer.flat_drop_off_cents;
    const extraCents = (trailer.extra_day_cents || 0) * extraDays;
    baseCents = dropCents + extraCents;
    quantity = extraDays;

    lineItems.push({
      label: `Drop-off (${trailer.flat_drop_off_days ?? 0} days included)`,
      amount_cents: dropCents,
    });
    if (extraDays > 0) {
      lineItems.push({
        label: `${extraDays} extra day${extraDays > 1 ? 's' : ''}`,
        amount_cents: extraCents,
      });
    }
  } else {
    const column = PERIOD_COLUMN[periodType];
    if (!column) throw badRequest('Invalid rental period.');
    const rate = trailer[column];
    if (rate == null) {
      const noun = periodType === 'hour' ? 'hourly' : `by the ${PERIOD_NOUN[periodType]}`;
      throw badRequest(`This trailer is not offered ${noun}.`);
    }

    if (periodType === 'day' && input.start_at && input.end_at) {
      // Derive the day count from the selected calendar range (inclusive).
      const days = inclusiveDays(input.start_at, input.end_at);
      if (days == null) throw badRequest('Invalid date range.');
      quantity = days;
    } else {
      quantity = clampInt(input.quantity ?? 1, 1);
    }

    if (periodType === 'hour' && trailer.min_hours) {
      quantity = Math.max(quantity, trailer.min_hours);
    }

    baseCents = rate * quantity;
    lineItems.push({
      label: `${quantity} × ${PERIOD_NOUN[periodType]}${quantity > 1 ? 's' : ''} @ ${rate / 100 % 1 === 0 ? '$' + rate / 100 : '$' + (rate / 100).toFixed(2)}`,
      amount_cents: baseCents,
    });
  }

  const taxRate = await getTaxRate();
  const taxCents = calcTax(baseCents, taxRate);

  return {
    period_type: periodType === 'roll_off' || trailer.type === 'dumpster' ? 'roll_off' : periodType,
    quantity,
    base_cents: baseCents,
    tax_rate: taxRate,
    tax_cents: taxCents,
    total_cents: baseCents + taxCents,
    line_items: lineItems,
  };
}

// Apply the single applicable discount to a base quote and compute the
// post-discount tax + total. THE one source of truth for discounted pricing,
// used by both the live quote (/api/quote, for display) and createBooking (the
// booking-time authority) so the summary the customer sees always equals what
// is charged and stored.
//
// Rules (must match the booking flow):
//   - The .edu student discount (20% of base) and a promo/partner code do NOT
//     stack; whichever is greater wins. Ties go to the code.
//   - A percentage/flat code reduces the taxable base; a free_delivery code
//     reduces the (untaxed) delivery fee instead.
//   - Tax is charged on the POST-discount taxable base (Ohio).
//
// `quote` is the output of computeQuote (needs base_cents + tax_rate). Returns a
// reconciled breakdown the callers map straight onto the stored columns.
function priceWithDiscounts(quote, opts = {}) {
  const base = Math.max(0, Number(quote.base_cents) || 0);
  const taxRate = Number(quote.tax_rate) || 0;
  const deliveryFeeCents = Math.max(0, Number(opts.deliveryFeeCents) || 0);
  const couponDisc = Math.max(0, Number(opts.couponDiscountCents) || 0);
  const couponFreeDelivery = !!opts.couponFreeDelivery;
  const studentCandidate = opts.studentEligible ? Math.round(base * 0.20) : 0;

  // Greater wins; tie → code. Student only applies when it strictly beats the code.
  const studentApplied = studentCandidate > 0 && studentCandidate > couponDisc;
  const couponApplied = !studentApplied && couponDisc > 0;

  const studentDiscountCents = studentApplied ? studentCandidate : 0;
  const couponDiscountCents = couponApplied ? couponDisc : 0;
  const appliedDiscount = studentApplied ? studentDiscountCents : couponDiscountCents;

  // free_delivery (a coupon kind) discounts delivery, never the taxable base.
  const discountOnDelivery = couponApplied && couponFreeDelivery;
  const baseDiscount = discountOnDelivery ? 0 : appliedDiscount;
  const deliveryDiscount = discountOnDelivery ? Math.min(deliveryFeeCents, appliedDiscount) : 0;

  const taxableBaseCents = Math.max(0, base - baseDiscount);
  const taxCents = calcTax(taxableBaseCents, taxRate);
  const totalCents = Math.max(0, taxableBaseCents + taxCents + (deliveryFeeCents - deliveryDiscount));

  return {
    base_cents: base,
    student_discount_applied: studentApplied,
    student_discount_cents: studentDiscountCents,   // → bookings.discount_cents
    coupon_discount_cents: couponDiscountCents,      // → bookings.discount_applied_cents
    discount_total_cents: appliedDiscount,           // → bookings.discount_total_cents
    base_discount_cents: baseDiscount,
    delivery_discount_cents: deliveryDiscount,
    tax_rate: taxRate,
    tax_cents: taxCents,
    delivery_fee_cents: deliveryFeeCents,
    total_cents: totalCents,
  };
}

module.exports = { computeQuote, priceWithDiscounts, DELIVERY_FEE_CENTS };
