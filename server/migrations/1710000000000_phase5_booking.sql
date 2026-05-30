-- Up Migration
--
-- Phase 5: booking + e-signed contract. The signed agreement is kept as an
-- immutable text snapshot on the booking row so the contract PDF can be
-- regenerated on demand (Railway's filesystem is ephemeral) and still reflect
-- the exact text the customer signed (E-SIGN / Ohio UETA record integrity).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS contract_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS contract_signed_user_agent VARCHAR;

-- Fast lookup of a customer's booking by the public ref code is already covered
-- by the UNIQUE constraint on ref_code; no extra index needed.

-- Down Migration

ALTER TABLE bookings
  DROP COLUMN IF EXISTS contract_snapshot,
  DROP COLUMN IF EXISTS contract_signed_user_agent;
