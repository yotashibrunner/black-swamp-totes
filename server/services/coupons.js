'use strict';

// Coupons / discount codes. Codes are case-insensitive. Discounts are computed
// server-side and never trusted from the client. use_count only increments when
// a booking is actually PAID (recordUse, called from the Stripe webhook), so an
// abandoned checkout doesn't burn a coupon.

const crypto = require('crypto');
const { pool, query } = require('../db');
const { formatCents } = require('../utils/money');

const DISCOUNT_TYPES = new Set(['percentage', 'flat', 'free_delivery']);

// Referral-partner channels. A coupon is a "partner" iff partner_type is set.
const PARTNER_TYPES = new Set(['apartment', 'mover', 'realtor']);
const PARTNER_TYPE_LABELS = { apartment: 'Apartment', mover: 'Mover', realtor: 'Realtor' };

// Booking statuses that represent committed (paid) revenue for a partner.
const REVENUE_STATUSES = ['paid', 'confirmed', 'out', 'returned'];

// The Referrals tab speaks 'percent'/'flat'; the coupons table stores
// 'percentage'/'flat'/'free_delivery'. Normalize the partner-facing alias.
function normalizeDiscountType(t) {
  const s = String(t || '').trim().toLowerCase();
  return s === 'percent' ? 'percentage' : s;
}

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Unambiguous code alphabet (no 0/O/1/I) for an auto-generated 6-char code.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// Discount in cents for a coupon against a given base subtotal. free_delivery
// applies only when the customer chose delivery (and equals the delivery fee).
function computeDiscount(coupon, baseCents, deliveryFeeCents = 0, fulfillment = 'pickup') {
  const base = Math.max(0, Number(baseCents) || 0);
  if (coupon.discount_type === 'percentage') {
    const pct = Math.max(0, Math.min(100, Number(coupon.discount_value) || 0));
    return Math.min(base, Math.round(base * pct / 100));
  }
  if (coupon.discount_type === 'flat') {
    return Math.min(base, Math.max(0, Number(coupon.discount_value) || 0));
  }
  if (coupon.discount_type === 'free_delivery') {
    return fulfillment === 'delivery' ? Math.max(0, Number(deliveryFeeCents) || 0) : 0;
  }
  return 0;
}

function couponByCode(code) {
  return query('SELECT * FROM coupons WHERE lower(code) = lower($1) LIMIT 1', [String(code || '').trim()])
    .then((r) => r.rows[0] || null);
}

// Validate a code for a (trailer, base subtotal). Returns a structured result
// with a clear message for each failure case. `valid` is false on any failure.
async function validateCoupon({ code, trailerId, baseAmountCents }) {
  const base = Math.max(0, Number(baseAmountCents) || 0);
  const fail = (message) => ({ valid: false, message });

  if (!code || !String(code).trim()) return fail('Enter a discount code.');
  const coupon = await couponByCode(code);
  if (!coupon) return fail('That code isn’t valid.');
  if (!coupon.active) return fail('That code is no longer active.');
  if (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) return fail('That code has expired.');
  if (coupon.max_uses != null && coupon.use_count >= coupon.max_uses) return fail('That code has reached its usage limit.');
  if (coupon.min_booking_cents && base < coupon.min_booking_cents) {
    return fail(`This code needs a minimum of ${formatCents(coupon.min_booking_cents)} before tax.`);
  }
  if (coupon.trailer_id && trailerId && coupon.trailer_id !== trailerId) {
    return fail('That code doesn’t apply to this trailer.');
  }

  const discountApplied = computeDiscount(coupon, base);
  const isFreeDelivery = coupon.discount_type === 'free_delivery';
  const message = isFreeDelivery
    ? 'Free delivery applied — choose delivery at the next step.'
    : `Discount applied: −${formatCents(discountApplied)}`;
  return {
    valid: true,
    coupon_id: coupon.id,
    code: coupon.code,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    discount_applied_cents: discountApplied,
    final_amount_cents: Math.max(0, base - discountApplied),
    free_delivery: isFreeDelivery,
    // Partner codes show as "Partner discount (CODE)" on the quote/receipt;
    // generic codes stay "Discount (CODE)".
    line_label: coupon.partner_type ? 'Partner discount' : 'Discount',
    message,
  };
}

// Server-side resolution used by createBooking. Throws a tagged error when the
// code is present but invalid, so the customer is told rather than silently
// charged full price. Returns { couponId, discountCents } (zeros when no code).
async function resolveForBooking({ code, trailerId, baseAmountCents, deliveryFeeCents, fulfillment }) {
  if (!code || !String(code).trim()) return { couponId: null, discountCents: 0, freeDelivery: false };
  const result = await validateCoupon({ code, trailerId, baseAmountCents });
  if (!result.valid) throw badRequest(result.message);
  const coupon = await couponByCode(code);
  const discountCents = computeDiscount(coupon, baseAmountCents, deliveryFeeCents, fulfillment);
  // free_delivery discounts the delivery fee, not the taxable base — the caller
  // needs to know so tax is computed on the right amount.
  return { couponId: coupon.id, discountCents, freeDelivery: coupon.discount_type === 'free_delivery' };
}

// Record a coupon use on payment (idempotent via the unique index on
// coupon_uses.booking_id). Increments use_count only on first insert.
async function recordUse(couponId, bookingId, discountCents) {
  if (!couponId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO coupon_uses (coupon_id, booking_id, discount_applied_cents)
       VALUES ($1,$2,$3) ON CONFLICT (booking_id) DO NOTHING RETURNING id`,
      [couponId, bookingId, Math.max(0, Number(discountCents) || 0)]
    );
    if (ins.rows.length) {
      await client.query('UPDATE coupons SET use_count = use_count + 1 WHERE id = $1', [couponId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[coupons] recordUse failed:', err.message);
  } finally {
    client.release();
  }
}

// ── Operator CRUD ───────────────────────────────────────────────────────────
function serialize(c) {
  return {
    ...c,
    value_fmt: c.discount_type === 'percentage' ? `${c.discount_value}%`
      : c.discount_type === 'free_delivery' ? 'Free delivery' : formatCents(c.discount_value),
    min_booking_fmt: formatCents(c.min_booking_cents || 0),
  };
}

async function listCoupons() {
  const { rows } = await query(
    `SELECT c.*, t.name AS trailer_name
       FROM coupons c LEFT JOIN trailers t ON t.id = c.trailer_id
      ORDER BY c.active DESC, c.created_at DESC`
  );
  return rows.map(serialize);
}

// Validate the optional partner block on a coupon body. Returns the resolved
// { partner_type, partner_name, partner_contact, partner_phone, partner_email,
// notes } (all null when no partner_type was given).
function resolvePartnerFields(body) {
  const partnerType = body.partner_type ? String(body.partner_type).trim().toLowerCase() : null;
  if (!partnerType) {
    return {
      partner_type: null, partner_name: null, partner_contact: null,
      partner_phone: null, partner_email: null, notes: null,
    };
  }
  if (!PARTNER_TYPES.has(partnerType)) {
    throw badRequest("partner_type must be 'apartment', 'mover', or 'realtor'.");
  }
  const name = (body.partner_name || '').trim();
  if (!name) throw badRequest('A partner name is required.');
  const email = (body.partner_email || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid partner email.');
  return {
    partner_type: partnerType,
    partner_name: name.slice(0, 120),
    partner_contact: (body.partner_contact || '').trim().slice(0, 120) || null,
    partner_phone: (body.partner_phone || '').trim().slice(0, 20) || null,
    partner_email: email.slice(0, 120) || null,
    notes: (body.notes || '').trim() || null,
  };
}

async function createCoupon(body, adminId) {
  const discountType = normalizeDiscountType(body.discount_type);
  if (!DISCOUNT_TYPES.has(discountType)) throw badRequest("discount_type must be 'percent', 'flat', or 'free_delivery'.");

  let discountValue = parseInt(body.discount_value, 10);
  if (discountType === 'free_delivery') discountValue = 0;
  else if (!Number.isInteger(discountValue) || discountValue <= 0) throw badRequest('A positive discount value is required.');
  else if (discountType === 'percentage' && discountValue > 100) throw badRequest('A percentage discount cannot exceed 100.');

  let code = String(body.code || '').trim().toUpperCase();
  if (!code) code = generateCode();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw badRequest('Code must be 3–32 letters, numbers, hyphen, or underscore.');

  const partner = resolvePartnerFields(body);
  const minBooking = Math.max(0, parseInt(body.min_booking_cents, 10) || 0);
  const maxUses = body.max_uses == null || body.max_uses === '' ? null : Math.max(1, parseInt(body.max_uses, 10) || 0) || null;
  const trailerId = body.trailer_id && /^[0-9a-f-]{36}$/i.test(body.trailer_id) ? body.trailer_id : null;
  const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw badRequest('Invalid expiry date.');

  // Default the description to the partner name so existing coupon listings stay
  // readable, when no explicit description was given.
  const description = (body.description || '').trim() || partner.partner_name || null;

  try {
    const { rows } = await query(
      `INSERT INTO coupons (code, description, discount_type, discount_value, min_booking_cents,
                            max_uses, trailer_id, expires_at, active, created_by,
                            partner_type, partner_name, partner_contact, partner_phone, partner_email, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [code, description, discountType, discountValue, minBooking,
        maxUses, trailerId, expiresAt ? expiresAt.toISOString() : null, adminId || null,
        partner.partner_type, partner.partner_name, partner.partner_contact,
        partner.partner_phone, partner.partner_email, partner.notes]
    );
    return serialize(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw badRequest('That code already exists.', 409);
    throw e;
  }
}

async function updateCoupon(id, patch) {
  const sets = [];
  const values = [];
  const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') throw badRequest('active must be true or false.');
    push('active', patch.active);
  }
  if (patch.description !== undefined) push('description', (patch.description || '').trim() || null);
  if (patch.expires_at !== undefined) {
    const d = patch.expires_at ? new Date(patch.expires_at) : null;
    if (d && Number.isNaN(d.getTime())) throw badRequest('Invalid expiry date.');
    push('expires_at', d ? d.toISOString() : null);
  }
  if (patch.max_uses !== undefined) {
    const m = patch.max_uses == null || patch.max_uses === '' ? null : Math.max(1, parseInt(patch.max_uses, 10) || 0) || null;
    push('max_uses', m);
  }
  // Partner metadata (editable from the partner detail screen).
  if (patch.partner_name !== undefined) {
    const n = (patch.partner_name || '').trim();
    if (!n) throw badRequest('Partner name cannot be empty.');
    push('partner_name', n.slice(0, 120));
  }
  if (patch.partner_contact !== undefined) push('partner_contact', (patch.partner_contact || '').trim().slice(0, 120) || null);
  if (patch.partner_phone !== undefined) push('partner_phone', (patch.partner_phone || '').trim().slice(0, 20) || null);
  if (patch.partner_email !== undefined) {
    const e = (patch.partner_email || '').trim();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw badRequest('Enter a valid partner email.');
    push('partner_email', e.slice(0, 120) || null);
  }
  if (patch.notes !== undefined) push('notes', (patch.notes || '').trim() || null);
  // Discount changes apply to future bookings only.
  if (patch.discount_type !== undefined || patch.discount_value !== undefined) {
    const dt = normalizeDiscountType(patch.discount_type);
    if (!DISCOUNT_TYPES.has(dt)) throw badRequest("discount_type must be 'percent', 'flat', or 'free_delivery'.");
    let dv = dt === 'free_delivery' ? 0 : parseInt(patch.discount_value, 10);
    if (dt !== 'free_delivery') {
      if (!Number.isInteger(dv) || dv <= 0) throw badRequest('A positive discount value is required.');
      if (dt === 'percentage' && dv > 100) throw badRequest('A percentage discount cannot exceed 100.');
    }
    push('discount_type', dt);
    push('discount_value', dv);
  }
  if (!sets.length) throw badRequest('No fields to update.');
  values.push(id);
  const { rows } = await query(`UPDATE coupons SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
  if (!rows.length) throw badRequest('Coupon not found.', 404);
  return serialize(rows[0]);
}

async function deleteCoupon(id) {
  const { rows } = await query('SELECT use_count FROM coupons WHERE id = $1', [id]);
  if (!rows.length) throw badRequest('Coupon not found.', 404);
  if (rows[0].use_count > 0) throw badRequest('This coupon has been used and cannot be deleted — deactivate it instead.', 409);
  await query('DELETE FROM coupons WHERE id = $1', [id]);
  return { ok: true };
}

// ── Referral partners ───────────────────────────────────────────────────────
// A partner is a coupon with partner_type set. The Referrals tab is a
// partner-oriented view over the same coupons table, aggregating each code's
// committed (paid) bookings + revenue.

function serializePartner(p) {
  const bookings = Number(p.bookings_count) || 0;
  const revenue = Number(p.revenue_cents) || 0;
  const discountFmt = p.discount_type === 'percentage' ? `${p.discount_value}%`
    : p.discount_type === 'free_delivery' ? 'Free delivery' : formatCents(p.discount_value);
  return {
    id: p.id,
    code: p.code,
    partner_type: p.partner_type,
    type_label: PARTNER_TYPE_LABELS[p.partner_type] || p.partner_type,
    partner_name: p.partner_name,
    partner_contact: p.partner_contact,
    partner_phone: p.partner_phone,
    partner_email: p.partner_email,
    notes: p.notes,
    discount_type: p.discount_type,
    discount_value: p.discount_value,
    discount_fmt: discountFmt,
    active: p.active,
    expires_at: p.expires_at,
    created_at: p.created_at,
    bookings_count: bookings,
    revenue_cents: revenue,
    revenue_fmt: formatCents(revenue),
    last_used: p.last_used || null,
  };
}

// All partners with their committed-booking count, revenue, and last-used date.
async function listPartners() {
  const { rows } = await query(
    `SELECT c.*,
            COALESCE(agg.bookings_count, 0) AS bookings_count,
            COALESCE(agg.revenue_cents, 0)  AS revenue_cents,
            agg.last_used
       FROM coupons c
       LEFT JOIN (
         SELECT coupon_id,
                COUNT(*)::int          AS bookings_count,
                SUM(total_cents)::bigint AS revenue_cents,
                MAX(created_at)        AS last_used
           FROM bookings
          WHERE coupon_id IS NOT NULL AND status = ANY($1)
          GROUP BY coupon_id
       ) agg ON agg.coupon_id = c.id
      WHERE c.partner_type IS NOT NULL
      ORDER BY c.partner_name NULLS LAST, c.created_at DESC`,
    [REVENUE_STATUSES]
  );
  return rows.map(serializePartner);
}

// Summary cards for the top of the Referrals tab. Pass an already-fetched
// partner list to avoid a second query.
async function partnerSummary(prefetched) {
  const partners = prefetched || await listPartners();
  const active = partners.filter((p) => p.bookings_count > 0);
  const revenue = partners.reduce((sum, p) => sum + p.revenue_cents, 0);
  const top = partners.reduce((best, p) => (p.revenue_cents > (best ? best.revenue_cents : -1) && p.revenue_cents > 0 ? p : best), null);
  return {
    total_partners: partners.length,
    active_partners: active.length,
    revenue_cents: revenue,
    revenue_fmt: formatCents(revenue),
    top_partner: top ? top.partner_name : null,
    top_partner_revenue_fmt: top ? top.revenue_fmt : null,
  };
}

// One partner with their full info and every committed booking that used their
// code (most recent first).
async function getPartner(id) {
  const { rows } = await query(
    `SELECT c.*,
            COALESCE(agg.bookings_count, 0) AS bookings_count,
            COALESCE(agg.revenue_cents, 0)  AS revenue_cents,
            agg.last_used
       FROM coupons c
       LEFT JOIN (
         SELECT coupon_id,
                COUNT(*)::int          AS bookings_count,
                SUM(total_cents)::bigint AS revenue_cents,
                MAX(created_at)        AS last_used
           FROM bookings
          WHERE coupon_id IS NOT NULL AND status = ANY($2)
          GROUP BY coupon_id
       ) agg ON agg.coupon_id = c.id
      WHERE c.id = $1 AND c.partner_type IS NOT NULL`,
    [id, REVENUE_STATUSES]
  );
  if (!rows.length) throw badRequest('Partner not found.', 404);
  const partner = serializePartner(rows[0]);

  const bk = await query(
    `SELECT b.ref_code, b.status, b.total_cents, b.discount_applied_cents, b.created_at,
            cu.name AS customer_name, t.name AS package_name
       FROM bookings b
       JOIN customers cu ON cu.id = b.customer_id
       JOIN trailers t  ON t.id = b.trailer_id
      WHERE b.coupon_id = $1 AND b.status = ANY($2)
      ORDER BY b.created_at DESC`,
    [id, REVENUE_STATUSES]
  );
  partner.bookings = bk.rows.map((b) => ({
    ref_code: b.ref_code,
    status: b.status,
    customer_name: b.customer_name,
    package_name: b.package_name,
    created_at: b.created_at,
    total_cents: b.total_cents,
    total_fmt: formatCents(b.total_cents),
    discount_applied_cents: b.discount_applied_cents,
    discount_fmt: formatCents(b.discount_applied_cents || 0),
  }));
  return partner;
}

// Create a partner = create a coupon with partner_type set. Reuses createCoupon
// so all validation, code rules, and uniqueness handling stay in one place.
async function createPartner(body, adminId) {
  const partnerType = body.partner_type ? String(body.partner_type).trim().toLowerCase() : '';
  if (!PARTNER_TYPES.has(partnerType)) throw badRequest("partner_type must be 'apartment', 'mover', or 'realtor'.");
  const coupon = await createCoupon(body, adminId);
  return getPartner(coupon.id);
}

// Stamp inactive every coupon whose expiry has passed (realtor voucher codes may
// carry a 90-day expiry; apartment/mover codes typically have none). Idempotent.
// Returns the number deactivated.
async function deactivateExpired() {
  const { rowCount } = await query(
    `UPDATE coupons SET active = false
      WHERE active = true AND expires_at IS NOT NULL AND expires_at <= NOW()`
  );
  return rowCount || 0;
}

module.exports = {
  validateCoupon, resolveForBooking, computeDiscount, recordUse, generateCode,
  listCoupons, createCoupon, updateCoupon, deleteCoupon,
  listPartners, partnerSummary, getPartner, createPartner, deactivateExpired,
  PARTNER_TYPES,
};
