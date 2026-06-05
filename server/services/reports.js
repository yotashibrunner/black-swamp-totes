'use strict';

// Owner business reporting for Black Swamp Totes. This is a sole owner/operator
// business — there is no commission and no revenue split. All revenue is owner
// revenue. Revenue is recognized on a booking's created_at (the sale date;
// online bookings are paid within minutes of creation) and only bookings that
// actually collected money (amount_paid_cents > 0) count.
//
// Money model (all integer cents):
//   gross      = total charged
//   stripe fee = estimated 2.9% + $0.30 per paid booking
//   net        = gross - stripe fees

const { query } = require('../db');
const { formatCents } = require('../utils/money');

// Estimated Stripe processing fee for a charge (2.9% + 30¢).
function stripeFee(totalCents) {
  return totalCents > 0 ? Math.round(totalCents * 0.029) + 30 : 0;
}

// UTC month window [from, to). month is 1-12.
function monthRange(month, year) {
  const m = Math.min(12, Math.max(1, parseInt(month, 10)));
  const y = parseInt(year, 10);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const label = from.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { from: from.toISOString(), to: to.toISOString(), label, month: m, year: y };
}

// Paid bookings (money collected) created within [from, to).
async function paidBookingsInRange(from, to) {
  const { rows } = await query(
    `SELECT b.ref_code, b.created_at, b.start_at, b.end_at, b.status, b.fulfillment,
            b.total_cents, b.amount_paid_cents, b.bin_count,
            t.name AS package_name, t.slug AS package_slug,
            c.name AS customer_name, c.phone AS customer_phone
       FROM bookings b
       JOIN trailers t ON t.id = b.trailer_id
       JOIN customers c ON c.id = b.customer_id
      WHERE b.amount_paid_cents > 0 AND b.created_at >= $1 AND b.created_at < $2
      ORDER BY b.created_at`,
    [from, to]
  );
  return rows;
}

// Revenue summary: gross, estimated Stripe fees, net, booking count, average.
function summarize(rows) {
  let gross = 0; let fees = 0;
  for (const b of rows) { gross += b.total_cents; fees += stripeFee(b.total_cents); }
  const net = gross - fees;
  const count = rows.length;
  const avg = count ? Math.round(gross / count) : 0;
  return {
    booking_count: count,
    gross_cents: gross, stripe_fees_cents: fees, net_cents: net, avg_booking_cents: avg,
    gross_fmt: formatCents(gross), stripe_fees_fmt: formatCents(fees),
    net_fmt: formatCents(net), avg_booking_fmt: formatCents(avg),
  };
}

async function summary(from, to) {
  return summarize(await paidBookingsInRange(from, to));
}

// Revenue by package: name, # bookings, gross, % of total gross.
async function byPackage(from, to) {
  const rows = await paidBookingsInRange(from, to);
  const total = rows.reduce((s, b) => s + b.total_cents, 0) || 1;
  const map = new Map();
  for (const b of rows) {
    const key = b.package_slug;
    const e = map.get(key) || { package: b.package_name, slug: key, count: 0, gross_cents: 0 };
    e.count += 1; e.gross_cents += b.total_cents;
    map.set(key, e);
  }
  return [...map.values()]
    .sort((a, b) => b.gross_cents - a.gross_cents)
    .map((e) => ({ ...e, gross_fmt: formatCents(e.gross_cents), pct: Math.round((e.gross_cents / total) * 1000) / 10 }));
}

// Revenue by period: one row per calendar month in range, most recent first.
async function byPeriod(from, to) {
  const rows = await paidBookingsInRange(from, to);
  const map = new Map();
  for (const b of rows) {
    const d = new Date(b.created_at);
    const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1;
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const e = map.get(key) || {
      key, year: y, month: m,
      label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      count: 0, gross_cents: 0, fees_cents: 0,
    };
    e.count += 1; e.gross_cents += b.total_cents; e.fees_cents += stripeFee(b.total_cents);
    map.set(key, e);
  }
  return [...map.values()]
    .sort((a, b) => (a.key < b.key ? 1 : (a.key > b.key ? -1 : 0)))
    .map((e) => ({
      key: e.key, label: e.label, year: e.year, month: e.month, count: e.count,
      gross_cents: e.gross_cents, net_cents: e.gross_cents - e.fees_cents,
      gross_fmt: formatCents(e.gross_cents), net_fmt: formatCents(e.gross_cents - e.fees_cents),
    }));
}

// Current operations snapshot (point-in-time, not period-bound).
async function currentOps() {
  const { rows } = await query(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'out')::int AS active_rentals,
        COALESCE(SUM(bin_count) FILTER (WHERE status = 'out'), 0)::int AS bins_out,
        COALESCE(SUM(bin_count * GREATEST(0, (end_at::date - start_at::date)))
                 FILTER (WHERE status = 'out'), 0)::int AS bin_days_out,
        COUNT(*) FILTER (WHERE status = 'paid')::int AS pending_deliveries,
        COUNT(*) FILTER (WHERE status = 'out' AND end_at <= NOW())::int AS pending_pickups,
        COUNT(*) FILTER (WHERE status = 'out' AND pickup_requested_at IS NOT NULL)::int AS pickup_requested
       FROM bookings`
  );
  return rows[0];
}

// Per-booking breakdown (gross / fee / net) for CSV export and the statement.
async function bookingsBreakdown(from, to) {
  const rows = await paidBookingsInRange(from, to);
  return rows.map((b) => {
    const fee = stripeFee(b.total_cents);
    const net = b.total_cents - fee;
    return {
      ref_code: b.ref_code, date: b.created_at,
      customer_name: b.customer_name, customer_phone: b.customer_phone,
      package_name: b.package_name,
      start_at: b.start_at, end_at: b.end_at,
      status: b.status, fulfillment: b.fulfillment,
      gross_cents: b.total_cents, stripe_fee_cents: fee, net_cents: net,
      gross_fmt: formatCents(b.total_cents), stripe_fee_fmt: formatCents(fee), net_fmt: formatCents(net),
    };
  });
}

// Monthly business summary (used by the auto-emailed PDF). Owner revenue only.
async function statement(month, year) {
  const range = monthRange(month, year);
  const rows = await paidBookingsInRange(range.from, range.to);
  return {
    label: range.label, month: range.month, year: range.year,
    from: range.from, to: range.to,
    totals: summarize(rows),
    items: await bookingsBreakdown(range.from, range.to),
  };
}

// CSV export of the per-booking breakdown.
function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dollars = (c) => (c / 100).toFixed(2);
  const dateOnly = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
  const header = ['ref_code', 'date', 'customer_name', 'phone', 'package', 'start', 'end',
    'gross', 'stripe_fee', 'net', 'status', 'fulfillment'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.ref_code, dateOnly(r.date), r.customer_name, r.customer_phone, r.package_name,
      dateOnly(r.start_at), dateOnly(r.end_at),
      dollars(r.gross_cents), dollars(r.stripe_fee_cents), dollars(r.net_cents),
      r.status, r.fulfillment,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

module.exports = {
  stripeFee, monthRange,
  summary, byPackage, byPeriod, currentOps, bookingsBreakdown, statement, toCsv,
};
