'use strict';

// Seeds the Black Swamp Totes bin packages. Idempotent: re-running updates rows
// by slug. Any leftover (non-package) rows are deactivated so they drop off the
// public site without violating booking foreign keys.
//
// Run with: railway run --service black-swamp-totes node scripts/seed-trailers.js
// Or from the Railway dashboard: Shell tab > run command
//
// All prices are stored in CENTS. weekly_rate is per-week for the fixed
// packages; for the custom package it is the per-bin-per-week rate ($4.25).

require('./_db-guard')('seed-trailers.js');
const { pool } = require('../server/db');

const PACKAGES = [
  {
    slug: 'studio-dorm',
    name: 'Studio / Dorm',
    size_label: '15 bins + 1 dolly',
    description: 'Perfect for a studio apartment, single room, or dorm move. 15 large stackable bins and one hand dolly, delivered to your door.',
    weekly_rate: 9900,
    bin_count: 15, dolly_count: 1, is_custom: false,
    quantity_total: 4, display_order: 1,
    specs: ['15 heavy-duty stackable bins', '1 hand dolly included', 'Free delivery to your door', 'Free pickup when done', 'Bins sanitized before every rental'],
  },
  {
    slug: 'one-bedroom',
    name: '1 Bedroom',
    size_label: '25 bins + 1 dolly',
    description: 'Built for one bedroom apartments and condos. 25 heavy-duty bins and a dolly delivered to your door.',
    weekly_rate: 12900,
    bin_count: 25, dolly_count: 1, is_custom: false,
    quantity_total: 3, display_order: 2,
    specs: ['25 heavy-duty stackable bins', '1 hand dolly included', 'Free delivery to your door', 'Free pickup when done', 'Bins sanitized before every rental'],
  },
  {
    slug: 'two-bedroom',
    name: '2 Bedroom',
    size_label: '40 bins + 1 dolly',
    description: 'Built for two bedroom apartments and houses. 40 heavy-duty bins and a dolly delivered to your door.',
    weekly_rate: 15900,
    bin_count: 40, dolly_count: 1, is_custom: false,
    quantity_total: 2, display_order: 3,
    specs: ['40 heavy-duty stackable bins', '1 hand dolly included', 'Free delivery to your door', 'Free pickup when done', 'Bins sanitized before every rental'],
  },
  {
    slug: 'three-four-bedroom',
    name: '3–4 Bedroom',
    size_label: '55 bins + 2 dollies',
    description: 'Built for larger homes. 55 heavy-duty bins and 2 dollies — everything you need for a full house move.',
    weekly_rate: 19900,
    bin_count: 55, dolly_count: 2, is_custom: false,
    quantity_total: 1, display_order: 4,
    specs: ['55 heavy-duty stackable bins', '2 hand dollies included', 'Free delivery to your door', 'Free pickup when done', 'Bins sanitized before every rental'],
  },
  {
    slug: 'custom',
    name: 'Custom Order',
    size_label: 'You choose the quantity',
    description: 'Need an exact number of bins? Order precisely what you need at $4.25 per bin per week. Minimum 10 bins.',
    weekly_rate: 425, // per bin per week
    bin_count: 10, dolly_count: 1, is_custom: true,
    quantity_total: 5, display_order: 6,
    specs: ['$4.25 per bin per week', 'Minimum 10 bins', '1 dolly per 25 bins included', 'Free delivery to your door', 'Free pickup when done'],
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
