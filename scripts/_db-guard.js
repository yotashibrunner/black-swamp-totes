'use strict';

// Guard for CLI scripts (seed, create-admin, …) that connect to Postgres.
//
// Railway's DATABASE_URL points at `postgres.railway.internal`, which ONLY
// resolves inside Railway's private network — not from `railway run` on your
// laptop. Running a script locally against it fails with a confusing ENOTFOUND.
//
// This guard, called BEFORE requiring ../server/db:
//   - If DATABASE_PUBLIC_URL is set (Railway's public TCP proxy), use it and
//     enable SSL, so the script can run from your machine.
//   - Otherwise, if DATABASE_URL is the internal host, print a clear message
//     telling you the correct way to run it, and exit 1.
//   - Otherwise (a normal/public URL), do nothing and let db.js connect (with
//     SSL when DB_SSL=true).
//
// Pass the script's filename so the message shows the exact command.
module.exports = function dbGuard(scriptName) {
  // Prefer the public proxy URL when provided — lets the script run locally.
  if (process.env.DATABASE_PUBLIC_URL) {
    process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
    if (!process.env.DB_SSL) process.env.DB_SSL = 'true';
  }

  const url = process.env.DATABASE_URL || '';
  if (url.includes('postgres.railway.internal')) {
    console.error(
      '\nThis script must be run with the web service env vars, not Postgres.\n' +
      `Run: railway run --service black-swamp-totes node scripts/${scriptName}\n` +
      'Or from the Railway dashboard: Shell tab > run command.\n' +
      '(To run from your own machine instead, set DATABASE_PUBLIC_URL to the\n' +
      ' Postgres public proxy URL from the Railway dashboard.)\n'
    );
    process.exit(1);
  }
};
