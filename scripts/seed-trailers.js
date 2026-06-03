'use strict';

// Seeds the Black Swamp Totes bin packages. Idempotent: re-running updates rows
// by slug. Any leftover (non-package) rows are deactivated so they drop off the
// public site without violating booking foreign keys.
//
// Run with: railway run --service black-swamp-totes node scripts/seed-trailers.js
// Or from the Railway dashboard: Shell tab > run command
//
// All prices are stored in CENTS. weekly_rate is per-week for the fixed
// packages; for the custom package it is the per-bin-per-week rate ($3.50).

require('./_db-guard')('seed-trailers.js');
const { pool } = require('../server/db');

const PACKAGES = [
  {
    slug: 'studio-dorm',
    name: 'Studio / Dorm',
    size_label: '20 bins + 1 dolly',
    description: 'Perfect for a studio apartment, single room, or dorm move. 20 large stackable bins and one hand dolly, delivered to your door. No cardboard, no tape, no waste.',
    weekly_rate: 10500,
    bin_count: 20, dolly_count: 1, is_custom: false,
    quantity_total: 10, display_order: 1,
    specs: ['20 large stackable bins', '1 hand dolly included', 'Free delivery to your door', 'Free pickup when you are done', 'Bins sanitized before every rental'],
  },
  {
    slug: 'one-two-bedroom',
    name: '1–2 Bedroom',
    size_label: '35 bins + 1 dolly',
    description: 'Our most popular package. Built for 1 and 2 bedroom apartments and houses. 35 large stackable bins and a dolly delivered to your door — everything you need without the cardboard waste.',
    weekly_rate: 14900,
    bin_count: 35, dolly_count: 1, is_custom: false,
    quantity_total: 10, display_order: 2,
    specs: ['35 large stackable bins', '1 hand dolly included', 'Free delivery to your door', 'Free pickup when you are done', 'Bins sanitized before every rental'],
  },
  {
    slug: 'three-four-bedroom',
    name: '3–4 Bedroom',
    size_label: '50 bins + 2 dollies',
    description: 'Built for larger homes. 50 bins and 2 dollies cover a full house move without a single cardboard box. Delivered, picked up, and sanitized — all handled for you.',
    weekly_rate: 20500,
    bin_count: 50, dolly_count: 2, is_custom: false,
    quantity_total: 5, display_order: 3,
    specs: ['50 large stackable bins', '2 hand dollies included', 'Free delivery to your door', 'Free pickup when you are done', 'Bins sanitized before every rental'],
  },
  {
    slug: 'student-special',
    name: 'Student Special',
    size_label: '15 bins + 1 dolly · 2 weeks',
    description: 'Built for BGSU and UT Toledo students. 15 bins and a dolly for two full weeks — plenty of time for move-in or move-out. Delivered anywhere in Toledo or Bowling Green.',
    weekly_rate: 4950, // 2-week rental = $99 (weekly_rate x 2 weeks)
    bin_count: 15, dolly_count: 1, is_custom: false,
    quantity_total: 10, display_order: 4,
    specs: ['15 large stackable bins', '1 hand dolly included', '2-week rental included', 'Free delivery to your door', 'Free pickup when you are done', 'Perfect for BGSU and UT Toledo students'],
  },
  {
    slug: 'custom',
    name: 'Custom Order',
    size_label: 'You choose the quantity',
    description: 'Need an exact number of bins? Order precisely what you need at $4.00 per bin per week. Includes delivery, pickup, and one hand dolly per 25 bins. Minimum 10 bins.',
    weekly_rate: 400, // per bin per week
    bin_count: 10, dolly_count: 1, is_custom: true,
    quantity_total: 50, display_order: 5,
    specs: ['$4.00 per bin per week', 'Minimum 10 bins', '1 dolly per 25 bins included', 'Free delivery to your door', 'Free pickup when you are done'],
  },
];

const UPSERT = `
  INSERT INTO trailers (
    slug, name, type, size_label, description,
    weekly_rate, deposit_cents, deposit_enabled,
    bin_count, dolly_count, is_custom,
    quantity_total, display_order, specs, active
  ) VALUES (
    $1, $2, 'bins', $3, $4,
    $5, 0, false,
    $6, $7, $8,
    $9, $10, $11::jsonb, true
  )
  ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    type = 'bins',
    size_label = EXCLUDED.size_label,
    description = EXCLUDED.description,
    weekly_rate = EXCLUDED.weekly_rate,
    deposit_cents = 0,
    deposit_enabled = false,
    bin_count = EXCLUDED.bin_count,
    dolly_count = EXCLUDED.dolly_count,
    is_custom = EXCLUDED.is_custom,
    quantity_total = EXCLUDED.quantity_total,
    display_order = EXCLUDED.display_order,
    specs = EXCLUDED.specs,
    active = true,
    updated_at = NOW()
`;

async function main() {
  const slugs = PACKAGES.map((p) => p.slug);
  for (const p of PACKAGES) {
    await pool.query(UPSERT, [
      p.slug, p.name, p.size_label, p.description,
      p.weekly_rate, p.bin_count, p.dolly_count, p.is_custom,
      p.quantity_total, p.display_order, JSON.stringify(p.specs),
    ]);
    console.log(`  ✓ ${p.slug} — ${p.name}`);
  }

  // Retire any old (pre-rebrand) inventory so it disappears from the public
  // site. We deactivate rather than delete to respect booking foreign keys.
  const { rowCount } = await pool.query(
    `UPDATE trailers SET active = false, updated_at = NOW()
      WHERE slug <> ALL($1) AND active = true`,
    [slugs]
  );
  if (rowCount) console.log(`  · deactivated ${rowCount} legacy item(s)`);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM trailers WHERE active = true');
  console.log(`Seeded packages. ${rows[0].n} active item(s).`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seed failed:', err);
    pool.end();
    process.exit(1);
  });
