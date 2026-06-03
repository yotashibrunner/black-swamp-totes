-- Up Migration
-- Customer-initiated pickup confirmation: timestamps for the READY request and
-- the two outbound nudges (24h-before-end reminder + post-end follow-up).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_requested_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_followup_sent_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE bookings DROP COLUMN IF EXISTS pickup_requested_at;
ALTER TABLE bookings DROP COLUMN IF EXISTS pickup_reminder_sent_at;
ALTER TABLE bookings DROP COLUMN IF EXISTS pickup_followup_sent_at;
