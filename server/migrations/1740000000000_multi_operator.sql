-- Up Migration
--
-- Multi-operator account management: attribute booking status changes to the
-- operator who made them, attribute audit entries, and support soft-deleting
-- (deactivating) operator accounts.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS managed_by UUID REFERENCES admin_users(id);

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS action_by UUID REFERENCES admin_users(id);

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- Down Migration

ALTER TABLE bookings DROP COLUMN IF EXISTS managed_by;
ALTER TABLE audit_log DROP COLUMN IF EXISTS action_by;
ALTER TABLE admin_users DROP COLUMN IF EXISTS active;
