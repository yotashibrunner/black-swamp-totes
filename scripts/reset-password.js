'use strict';

// One-off: reset an operator's password. Uses the project's bcrypt lib
// (bcryptjs, same as services/auth.js) and the correct column (password_hash).
// NOT committed — run directly:  node scripts/reset-password.js

const bcrypt = require('bcryptjs');
const { pool } = require('../server/db'); // loads .env via config

const EMAIL = 'eb333659@gmail.com';
const PASSWORD = 'BlackSwamp2026!';

(async () => {
  const hash = await bcrypt.hash(PASSWORD, 12);
  const { rows } = await pool.query(
    'UPDATE admin_users SET password_hash = $2 WHERE email = $1 RETURNING id, email, role, active',
    [EMAIL, hash]
  );
  if (!rows.length) {
    console.error(`No admin_users row for ${EMAIL}`);
    process.exit(1);
  }
  console.log(`✓ Password reset for ${rows[0].email} (role ${rows[0].role}, active=${rows[0].active}).`);
  console.log(`  Log in at /operator with: ${EMAIL} / ${PASSWORD}`);
  await pool.end();
})().catch((e) => { console.error('reset-password failed:', e.message); process.exit(1); });
