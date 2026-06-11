-- Up Migration
-- Explicit Rental Agreement / Liability Waiver acceptance captured at the
-- booking step (a required checkbox), separate from the later e-signature.
-- Versioned so that if the waiver language changes we know which version each
-- customer agreed to.
--
--   terms_accepted     did the customer tick the "I agree" box at booking?
--   terms_accepted_at  when (server timestamp at booking creation).
--   terms_version      which waiver version they saw, e.g. 'v1.0-2026-06'.
--   terms_accepted_ip  the customer's IP at acceptance (dispute evidence).

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS terms_accepted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS terms_version VARCHAR(40);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS terms_accepted_ip VARCHAR;

-- Backfill: any already-signed booking accepted the agreement at signing. Carry
-- that forward as the acceptance record (flagged 'legacy-esign' so it's clearly
-- the pre-checkbox path), using the signature's own timestamp + IP.
UPDATE bookings
   SET terms_accepted = true,
       terms_accepted_at = contract_signed_at,
       terms_accepted_ip = contract_signed_ip,
       terms_version = 'legacy-esign'
 WHERE contract_signed_at IS NOT NULL AND terms_accepted = false;

-- Down Migration

ALTER TABLE bookings DROP COLUMN IF EXISTS terms_accepted_ip;
ALTER TABLE bookings DROP COLUMN IF EXISTS terms_version;
ALTER TABLE bookings DROP COLUMN IF EXISTS terms_accepted_at;
ALTER TABLE bookings DROP COLUMN IF EXISTS terms_accepted;
