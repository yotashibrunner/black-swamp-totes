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
const { getTaxRate } = require('./settings');

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

// trailer: a row from the trailer service. input: { period_type, quantity?,
// start_at?, end_at?, extra_days?, tire_count? }.
// Weeks for a bin rental: derived from the delivery→pickup range (inclusive,
// rounded up), minimum one week; falls back to an explicit quantity.
function computeWeeks(input) {
  if (input.start_at && input.end_at) {
    const days = inclusiveDays(input.start_at, input.end_at);
    if (days == null) throw badRequest('Invalid date range.');
    return Math.max(1, Math.ceil(days / 7));
  }
  return clampInt(input.weeks ?? input.quantity ?? 1, 1);
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
    const weeks = computeWeeks(input);
    const binCount = trailer.is_custom
      ? Math.max(10, clampInt(input.bin_quantity ?? input.bin_count ?? 0, 10))
      : (trailer.bin_count || 0);
    const dollyCount = trailer.is_custom ? Math.max(1, Math.ceil(binCount / 25)) : (trailer.dolly_count || 0);
    const perWeek = trailer.is_custom ? trailer.weekly_rate * binCount : trailer.weekly_rate;
    baseCents = perWeek * weeks;

    lineItems.push({
      label: trailer.is_custom
        ? `${binCount} bins × ${weeks} week${weeks > 1 ? 's' : ''} @ $${(trailer.weekly_rate / 100).toFixed(2)}/bin/wk`
        : `${binCount} bins · ${weeks} week${weeks > 1 ? 's' : ''}`,
      amount_cents: baseCents,
    });

    const taxRate = await getTaxRate();
    const taxCents = calcTax(baseCents, taxRate);
    return {
      period_type: 'week', quantity: weeks, weeks, bin_count: binCount, dolly_count: dollyCount,
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

module.exports = { computeQuote, DELIVERY_FEE_CENTS };
