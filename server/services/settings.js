'use strict';

// Business settings, stored as JSONB rows in the `settings` table. The booking
// flow needs the sales-tax rate (plan §10: 7.25% Ohio state + Lucas County);
// the deposit + return-condition flows add a global deposit toggle and the
// tonnage-overage rate. Operators override any of these from the Settings
// screen without a code change.

const { query } = require('../db');

const DEFAULT_TAX_RATE = 0.0725;
const DEFAULT_DEPOSITS_ENABLED = true;
const DEFAULT_TONNAGE_RATE_CENTS = 7500; // $75/ton

// Read one JSONB setting by key, returning its parsed value or `fallback` when
// the row is missing or unreadable. Never throws.
async function getSetting(key, fallback) {
  try {
    const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
    if (rows.length && rows[0].value != null) return rows[0].value;
  } catch (err) {
    console.error(`[settings] ${key} lookup failed, using default`, err.message);
  }
  return fallback;
}

// Upsert one JSONB setting. `value` is any JSON-serializable value.
async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

async function getTaxRate() {
  const v0 = await getSetting('tax_rate', DEFAULT_TAX_RATE);
  const v = typeof v0 === 'number' ? v0 : Number(v0);
  if (Number.isFinite(v) && v >= 0 && v < 1) return v;
  return DEFAULT_TAX_RATE;
}

// Global "require security deposits" switch. Defaults ON.
async function depositsEnabled() {
  const v = await getSetting('deposits_enabled', DEFAULT_DEPOSITS_ENABLED);
  return v === true || v === 'true';
}

// Per-ton overage rate (integer cents). Defaults to $75/ton.
async function tonnageOverageRateCents() {
  const v0 = await getSetting('tonnage_overage_rate_cents', DEFAULT_TONNAGE_RATE_CENTS);
  const v = typeof v0 === 'number' ? v0 : Number(v0);
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_TONNAGE_RATE_CENTS;
}

// One round-trip for the Settings screen + checkout: every operator-tunable
// business setting in one object.
async function getBusinessSettings() {
  const [taxRate, deposits, tonnage] = await Promise.all([
    getTaxRate(), depositsEnabled(), tonnageOverageRateCents(),
  ]);
  return {
    tax_rate: taxRate,
    deposits_enabled: deposits,
    tonnage_overage_rate_cents: tonnage,
  };
}

module.exports = {
  getSetting, setSetting,
  getTaxRate, depositsEnabled, tonnageOverageRateCents, getBusinessSettings,
  DEFAULT_TAX_RATE, DEFAULT_TONNAGE_RATE_CENTS,
};
