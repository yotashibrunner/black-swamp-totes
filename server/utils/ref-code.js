'use strict';

// Customer-facing booking reference, e.g. "GCT-7F3Q". Uses a Crockford-ish
// base32 alphabet (no I/L/O/U / 0/1) so codes are easy to read aloud over the
// phone. Uniqueness is enforced by the UNIQUE constraint on bookings.ref_code;
// callers retry on the rare collision.

const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

// 6 chars (~729M combos) so the ref doubles as an unguessable capability token
// for the public booking lookup + signed-contract PDF.
function refCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `GCT-${out}`;
}

module.exports = { refCode };
