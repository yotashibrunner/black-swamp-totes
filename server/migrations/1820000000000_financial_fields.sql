-- Up Migration
-- Financial / tax auditability fields on bookings, for clean Ohio sales-tax
-- remittance, a CPA handoff, and true net revenue.
--
--   tax_rate            the rate actually used on this booking (auditable if the
--                       rate later changes). NUMERIC(6,5): e.g. 0.07250.
--   tax_rate_estimated  true only for historical rows where the rate could not
--                       be derived and a fallback was used.
--   discount_total_cents one clean discount column (promo + student combined).
--   stripe_charge_id    the Stripe charge (ch_...) behind the payment.
--   stripe_fee_cents    the ACTUAL processing fee from Stripe's balance
--                       transaction (null = unknown → reporting estimates it).
--   payment_status      unpaid | paid | partially_refunded | refunded — an
--                       explicit money state, independent of the fulfilment
--                       lifecycle in `status`.
--   refunded_cents      rental amount refunded (cancellation), so revenue can be
--                       reported net of refunds. (Deposit refunds stay in
--                       deposit_refunded_cents.)
--   paid_at             when payment was captured (revenue recognition).

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6,5);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tax_rate_estimated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_total_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_charge_id VARCHAR;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_fee_cents INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR NOT NULL DEFAULT 'unpaid';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refunded_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- ── Backfill (best-effort; pre-launch the table is nearly empty) ─────────────

-- One clean discount column = promo + student.
UPDATE bookings
   SET discount_total_cents = COALESCE(discount_applied_cents, 0) + COALESCE(discount_cents, 0)
 WHERE discount_total_cents = 0;

-- tax_rate: derive the ACTUAL rate from tax_cents ÷ base_amount_cents (rounded
-- to 5dp to fit NUMERIC(6,5)); these are real rates, not estimates. Where the
-- base is missing/zero, fall back to the current configured rate and FLAG it.
UPDATE bookings
   SET tax_rate = round(tax_cents::numeric / base_amount_cents, 5),
       tax_rate_estimated = false
 WHERE tax_rate IS NULL
   AND base_amount_cents > 0
   AND tax_cents IS NOT NULL;

UPDATE bookings
   SET tax_rate = COALESCE(
         (SELECT (value #>> '{}')::numeric FROM settings WHERE key = 'tax_rate'),
         0.0725),
       tax_rate_estimated = true
 WHERE tax_rate IS NULL;

-- payment_status + paid_at from the existing lifecycle. A cancelled booking that
-- had collected money is treated as refunded; revenue reporting excludes
-- cancelled rows regardless.
UPDATE bookings
   SET payment_status = CASE
         WHEN status = 'cancelled' AND amount_paid_cents > 0 THEN 'refunded'
         WHEN amount_paid_cents > 0 THEN 'paid'
         ELSE 'unpaid' END,
       paid_at = CASE WHEN amount_paid_cents > 0 THEN COALESCE(paid_at, updated_at) ELSE paid_at END
 WHERE payment_status = 'unpaid';

CREATE INDEX IF NOT EXISTS idx_bookings_paid_at ON bookings(paid_at);

-- Down Migration

DROP INDEX IF EXISTS idx_bookings_paid_at;
ALTER TABLE bookings DROP COLUMN IF EXISTS paid_at;
ALTER TABLE bookings DROP COLUMN IF EXISTS refunded_cents;
ALTER TABLE bookings DROP COLUMN IF EXISTS payment_status;
ALTER TABLE bookings DROP COLUMN IF EXISTS stripe_fee_cents;
ALTER TABLE bookings DROP COLUMN IF EXISTS stripe_charge_id;
ALTER TABLE bookings DROP COLUMN IF EXISTS discount_total_cents;
ALTER TABLE bookings DROP COLUMN IF EXISTS tax_rate_estimated;
ALTER TABLE bookings DROP COLUMN IF EXISTS tax_rate;
