-- Up Migration
-- .edu student discount: a 20%-off-the-package-price discount applied at booking
-- when the customer's email is a .edu address (does not stack with promo codes).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS student_discount_applied BOOLEAN DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_cents INTEGER DEFAULT 0;

-- Down Migration
ALTER TABLE bookings DROP COLUMN IF EXISTS student_discount_applied;
ALTER TABLE bookings DROP COLUMN IF EXISTS discount_cents;
