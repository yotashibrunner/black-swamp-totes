-- Up Migration

-- ── Security deposits (per-trailer) ─────────────────────────────────────────
-- deposit_cents was never a column; the original spec assumed it existed. Add
-- both the amount and the per-trailer enable flag. A deposit only applies when
-- the global toggle is on AND the trailer is enabled AND deposit_cents > 0.
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS deposit_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS deposit_enabled BOOLEAN NOT NULL DEFAULT true;

-- ── Deposit state + saved payment method on bookings ────────────────────────
-- The Stripe customer + payment method are stored when the booking is paid
-- (Checkout with setup_future_usage), so we can refund the deposit or charge
-- the card on file for return-time overages.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_method_id VARCHAR;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_refunded_cents INTEGER NOT NULL DEFAULT 0;
-- deposit_status: 'none' | 'held' | 'refunded' | 'partially_kept' | 'kept'
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_status VARCHAR NOT NULL DEFAULT 'none';

-- ── Rental extensions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rental_extensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  original_end_at TIMESTAMPTZ NOT NULL,
  new_end_at TIMESTAMPTZ NOT NULL,
  days_extended INTEGER NOT NULL,
  extension_fee_cents INTEGER NOT NULL,
  stripe_payment_link VARCHAR,
  stripe_session_id VARCHAR,
  stripe_payment_intent_id VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'pending',   -- 'pending' | 'paid' | 'cancelled'
  paid_at TIMESTAMPTZ,
  created_by UUID REFERENCES admin_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rental_extensions_booking ON rental_extensions(booking_id);
CREATE INDEX IF NOT EXISTS idx_rental_extensions_session ON rental_extensions(stripe_session_id);

-- ── Post-rental additional charges ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS additional_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  -- 'damage' | 'tonnage_overage' | 'prohibited_items' | 'tires' | 'late_return'
  -- | 'deposit_deduction' | 'other'
  charge_type VARCHAR NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  weight_tons DECIMAL(5,2),
  -- 'payment_link' (customer pays online) | 'card_on_file' (charged immediately)
  -- | 'deposit' (deducted from a held deposit, no separate charge)
  billing_method VARCHAR NOT NULL DEFAULT 'payment_link',
  stripe_payment_link VARCHAR,
  stripe_session_id VARCHAR,
  stripe_payment_intent_id VARCHAR,
  -- 'pending' | 'paid' | 'waived' | 'disputed'
  status VARCHAR NOT NULL DEFAULT 'pending',
  notified_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID REFERENCES admin_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_additional_charges_booking ON additional_charges(booking_id);
CREATE INDEX IF NOT EXISTS idx_additional_charges_session ON additional_charges(stripe_session_id);

-- ── Settings seeds ──────────────────────────────────────────────────────────
-- Global deposit toggle (deposits on site-wide) + the tonnage overage rate used
-- by the return-condition and add-charge auto-calculations. Stored as JSONB.
INSERT INTO settings (key, value) VALUES ('deposits_enabled', 'true'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('tonnage_overage_rate_cents', '7500'::jsonb)
  ON CONFLICT (key) DO NOTHING;

-- Down Migration

DROP TABLE IF EXISTS additional_charges;
DROP TABLE IF EXISTS rental_extensions;

ALTER TABLE bookings DROP COLUMN IF EXISTS deposit_status;
ALTER TABLE bookings DROP COLUMN IF EXISTS deposit_refunded_cents;
ALTER TABLE bookings DROP COLUMN IF EXISTS deposit_paid_cents;
ALTER TABLE bookings DROP COLUMN IF EXISTS stripe_payment_method_id;
ALTER TABLE bookings DROP COLUMN IF EXISTS stripe_customer_id;

ALTER TABLE trailers DROP COLUMN IF EXISTS deposit_enabled;
ALTER TABLE trailers DROP COLUMN IF EXISTS deposit_cents;

DELETE FROM settings WHERE key IN ('deposits_enabled', 'tonnage_overage_rate_cents');
