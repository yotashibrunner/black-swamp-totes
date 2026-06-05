-- Up Migration
-- Boolean "sent" flags for the hourly cron reminder endpoint
-- (POST|GET /api/cron/reminders): the 24h-before pickup reminder, the overdue
-- follow-up, and the post-return review request. Each guards its job so re-runs
-- are idempotent.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_reminder_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS overdue_notice_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_request_sent BOOLEAN DEFAULT FALSE;

-- Down Migration
ALTER TABLE bookings DROP COLUMN IF EXISTS pickup_reminder_sent;
ALTER TABLE bookings DROP COLUMN IF EXISTS overdue_notice_sent;
ALTER TABLE bookings DROP COLUMN IF EXISTS review_request_sent;
