'use strict';

// Operator/admin account management (admin-only at the route layer). Passwords
// are bcrypt-hashed via the auth service; hashes are never returned to clients.
// Every change writes an audit_log entry attributed to the acting admin.

const { pool, query } = require('../db');
const { hashPassword } = require('./auth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = new Set(['admin', 'operator']);

// Fields safe to expose — never the password hash.
const PUBLIC = `id, name, email, phone, role, active, last_login_at, created_at`;

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function audit(client, adminUserId, action, entityId, details) {
  await client.query(
    `INSERT INTO audit_log (admin_user_id, action_by, action, entity_type, entity_id, details)
     VALUES ($1, $1, $2, 'admin_user', $3, $4)`,
    [adminUserId || null, action, entityId, JSON.stringify(details || {})]
  );
}

async function listAccounts() {
  const { rows } = await query(`SELECT ${PUBLIC} FROM admin_users ORDER BY active DESC, role, name`);
  return rows;
}

async function getAccount(id) {
  if (!UUID_RE.test(id)) throw badRequest('Invalid account id.');
  const { rows } = await query(`SELECT ${PUBLIC} FROM admin_users WHERE id = $1`, [id]);
  return rows[0] || null;
}

function validateRole(role) {
  if (!ROLES.has(role)) throw badRequest("role must be 'admin' or 'operator'.");
  return role;
}

async function createAccount(input, byId) {
  const name = (input.name || '').trim();
  const email = (input.email || '').trim().toLowerCase();
  const phone = (input.phone || '').trim() || null;
  const role = validateRole(input.role);
  const password = String(input.password || '');

  if (!name) throw badRequest('Name is required.');
  if (!EMAIL_RE.test(email)) throw badRequest('A valid email is required.');
  if (password.length < 8) throw badRequest('Temporary password must be at least 8 characters.');

  const exists = await query('SELECT 1 FROM admin_users WHERE lower(email) = $1', [email]);
  if (exists.rows.length) throw badRequest('An account with that email already exists.', 409);

  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO admin_users (name, email, phone, role, password_hash, active)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING ${PUBLIC}`,
      [name, email, phone, role, passwordHash]
    );
    await audit(client, byId, 'account.create', ins.rows[0].id, { email, role });
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Update name / phone / role / active, and optionally reset the password.
async function updateAccount(id, input, byId) {
  if (!UUID_RE.test(id)) throw badRequest('Invalid account id.');

  const sets = [];
  const values = [];
  const changed = [];

  if (input.name !== undefined) {
    const name = (input.name || '').trim();
    if (!name) throw badRequest('Name cannot be empty.');
    values.push(name); sets.push(`name = $${values.length}`); changed.push('name');
  }
  if (input.phone !== undefined) {
    values.push((input.phone || '').trim() || null); sets.push(`phone = $${values.length}`); changed.push('phone');
  }
  if (input.role !== undefined) {
    values.push(validateRole(input.role)); sets.push(`role = $${values.length}`); changed.push('role');
  }
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw badRequest('active must be true or false.');
    values.push(input.active); sets.push(`active = $${values.length}`); changed.push('active');
  }
  if (input.password !== undefined && input.password !== '') {
    if (String(input.password).length < 8) throw badRequest('New password must be at least 8 characters.');
    values.push(await hashPassword(String(input.password)));
    sets.push(`password_hash = $${values.length}`); changed.push('password');
  }

  if (!sets.length) throw badRequest('No fields to update.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    values.push(id);
    const upd = await client.query(
      `UPDATE admin_users SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${PUBLIC}`,
      values
    );
    if (!upd.rows.length) { await client.query('ROLLBACK'); throw badRequest('Account not found.', 404); }
    await audit(client, byId, 'account.update', id, { fields: changed });
    await client.query('COMMIT');
    return upd.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Soft delete — deactivate. Callers must prevent self-deactivation.
async function deactivateAccount(id, byId) {
  if (!UUID_RE.test(id)) throw badRequest('Invalid account id.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE admin_users SET active = false WHERE id = $1 RETURNING ${PUBLIC}`, [id]
    );
    if (!upd.rows.length) { await client.query('ROLLBACK'); throw badRequest('Account not found.', 404); }
    await audit(client, byId, 'account.deactivate', id, {});
    await client.query('COMMIT');
    return upd.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { listAccounts, getAccount, createAccount, updateAccount, deactivateAccount };
