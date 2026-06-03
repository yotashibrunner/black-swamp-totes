-- Up Migration
-- Black Swamp Totes rebrand: reusable moving bins instead of trailers.

-- type already exists from init (trailer|dumpster); ensure a default for new
-- bin rows. Existing rows keep their values.
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS type VARCHAR NOT NULL DEFAULT 'bins';

-- Per-package bin/dolly counts + a custom (per-bin pricing) flag. For the custom
-- package, bin_count is the minimum and the booked count comes from the customer.
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS bin_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS dolly_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT false;

-- Bin + dolly counts on each booking (set from the chosen package), plus a
-- separate pickup address (bins are delivered to one place, collected from
-- another — e.g. the customer's new home).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bin_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dolly_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_address TEXT;

-- Lost/damaged bin fee + per-bin extension rate (cents). Operator-tunable.
INSERT INTO settings (key, value) VALUES ('lost_bin_fee_cents', '3500'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('extension_rate_per_bin_cents', '30'::jsonb)
  ON CONFLICT (key) DO NOTHING;

-- Down Migration

ALTER TABLE bookings DROP COLUMN IF EXISTS bin_count;
ALTER TABLE bookings DROP COLUMN IF EXISTS dolly_count;
ALTER TABLE bookings DROP COLUMN IF EXISTS pickup_address;
ALTER TABLE trailers DROP COLUMN IF EXISTS bin_count;
ALTER TABLE trailers DROP COLUMN IF EXISTS dolly_count;
ALTER TABLE trailers DROP COLUMN IF EXISTS is_custom;
DELETE FROM settings WHERE key IN ('lost_bin_fee_cents', 'extension_rate_per_bin_cents');
