-- Up Migration
-- Unified Referral Partner system. Partners (apartments, movers, realtors) are
-- modeled as coupons carrying partner metadata, so the existing, validated
-- discount → checkout → webhook pipeline powers all three B2B channels with no
-- parallel code path. A coupon is a "partner" iff partner_type is set.
--
-- discount_type / discount_value already exist on coupons with the exact
-- semantics the referral system needs:
--   discount_type  'percentage' | 'flat' | 'free_delivery'
--   discount_value  percent (e.g. 15) for 'percentage', cents (e.g. 5000) for 'flat'
-- so they are NOT re-added here.
--
-- Which code a booking used is already recorded via bookings.coupon_id (added in
-- 1760000000000_coupons_and_reviews.sql), joined back to coupons.code — no
-- separate promo_code column is needed.

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS partner_name VARCHAR(120);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS partner_type VARCHAR(20);     -- 'apartment' | 'mover' | 'realtor'
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS partner_contact VARCHAR(120); -- PM name, owner, agent
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS partner_phone VARCHAR(20);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS partner_email VARCHAR(120);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS notes TEXT;

-- Fast lookup of the partner roster (the Referrals tab lists only partner codes).
CREATE INDEX IF NOT EXISTS idx_coupons_partner_type ON coupons(partner_type) WHERE partner_type IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_coupons_partner_type;
ALTER TABLE coupons DROP COLUMN IF EXISTS notes;
ALTER TABLE coupons DROP COLUMN IF EXISTS partner_email;
ALTER TABLE coupons DROP COLUMN IF EXISTS partner_phone;
ALTER TABLE coupons DROP COLUMN IF EXISTS partner_contact;
ALTER TABLE coupons DROP COLUMN IF EXISTS partner_type;
ALTER TABLE coupons DROP COLUMN IF EXISTS partner_name;
