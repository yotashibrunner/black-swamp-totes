'use strict';

// Inventory seed — SaaS TEMPLATE. This ships with a single EXAMPLE package so a
// fresh deploy has something to show. Replace `PACKAGES` with the real inventory
// for your business (see SETUP.md → "Add custom inventory"). Idempotent on slug.
//
//   npm run seed
//
// All prices are stored in CENTS. weekly_rate is per-week; for a "custom"
// per-unit package, weekly_rate is the per-unit-per-week rate and is_custom=true.

const { pool } = require('../server/db');

// ⬇️ EXAMPLE DATA — replace with your own packages.
const PACKAGES = [
  {
    slug: 'example-package',
    name: 'Example Package',
    size_label: '20 units + 1 dolly',
    description: 'Example rental package. Edit scripts/seed-trailers.js to define your real inventory, then run `npm run seed`.',
    weekly_rate: 8900,           // $89.00 / week
    bin_count: 20, dolly_count: 1, is_custom: false,
    quantity_total: 10, display_order: 1,
    specs: ['20 units included', '1 dolly included', 'Free delivery & pickup'],
  },
];

const UPSERT = `
  INSERT INTO trailers (
    slug, name, type, size_label, description,
    weekly_rate, deposit_cents, deposit_enabled,
    bin_count, dolly_count, is_custom,
    quantity_total, display_order, specs, active
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, 0, false,
    $7, $8, $9,
    $10, $11, $12::jsonb, true
  )
  ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, type = EXCLUDED.type, size_label = EXCLUDED.size_label,
    description = EXCLUDED.description, weekly_rate = EXCLUDED.weekly_rate,
    deposit_cents = 0, deposit_enabled = false,
    bin_count = EXCLUDED.bin_count, dolly_count = EXCLUDED.dolly_count, is_custom = EXCLUDED.is_custom,
    quantity_total = EXCLUDED.quantity_total, display_order = EXCLUDED.display_order,
    specs = EXCLUDED.specs, active = true, updated_at = NOW()
`;

async function main() {
  const type = process.env.RENTAL_TYPE || 'bins';
  const slugs = PACKAGES.map((p) => p.slug);
  for (const p of PACKAGES) {
    await pool.query(UPSERT, [
      p.slug, p.name, type, p.size_label, p.description,
      p.weekly_rate, p.bin_count, p.dolly_count, p.is_custom,
      p.quantity_total, p.display_order, JSON.stringify(p.specs),
    ]);
    console.log(`  ✓ ${p.slug} — ${p.name}`);
  }
  // Retire anything not in the current set (deactivate, never delete — FK safe).
  await pool.query(
    `UPDATE trailers SET active = false, updated_at = NOW() WHERE slug <> ALL($1) AND active = true`,
    [slugs]
  );
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM trailers WHERE active = true');
  console.log(`Seeded inventory. ${rows[0].n} active item(s).`);
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error('Seed failed:', err); pool.end(); process.exit(1); });
