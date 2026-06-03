# Rental Platform — White-Label Setup

This is a config-driven rental booking platform (booking + e-signed contract +
Stripe payment + operator PWA). One codebase serves many businesses: the brand,
contact details, colors, and rental terminology come from environment variables,
and the inventory comes from a seed script.

**Estimated setup time per new client: ~30 minutes.**

---

## 1. What you get

- Customer site: packages, availability, live quote, e-signed agreement, Stripe
  checkout, confirmation + receipt email, self-service "manage / cancel" page.
- Operator PWA (`/operator`): dashboard, schedule, calendar, inventory, deposits,
  extensions, post-rental charges, coupons, reports, audit log.
- SEO (`/sitemap.xml`, `/robots.txt`), GA4 + Meta Pixel (env-gated), branded 404/500.
- Everything optional (Stripe, email, SMS, push, analytics) is **env-gated** — the
  app boots and the booking flow works up to checkout even with nothing configured.

---

## 2. Environment variables

### Required

| Var | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://…` | Railway Postgres provides this automatically. |
| `JWT_SECRET` | (48+ random bytes) | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `BUSINESS_NAME` | `Toledo Totes` | Shown across the site, emails, and contract. |
| `BUSINESS_PHONE` | `(419) 555-0100` | Click-to-call + support number. |
| `BUSINESS_EMAIL` | `hello@toledototes.com` | Contact + privacy address. |
| `BUSINESS_ADDRESS` | `123 Main St, Toledo, OH 43604` | Pickup/return + legal address. |
| `SITE_URL` | `https://toledototes.com` | Canonical URL for sitemap/robots/links. |
| `BRAND_COLOR_PRIMARY` | `#22c55e` | Accent color (CTAs, links, highlights). |
| `BRAND_COLOR_DARK` | `#0a1a0a` | Dark background / primary text color. |

### Optional

| Var | Purpose |
|---|---|
| `BUSINESS_TAGLINE` | Short tagline under the logo. |
| `RENTAL_TYPE` | `bins` \| `trailers` \| `equipment` — selects inventory terminology. |
| `LOGO_SVG_URL` | URL to a logo/mark SVG. Falls back to a generic mark. |
| `DB_SSL` | `true` for Railway managed Postgres. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Live payments. Webhook → `/webhooks/stripe`, event `checkout.session.completed`. |
| `RESEND_API_KEY`, `FROM_EMAIL` | Transactional email (confirmations, receipts). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `OPERATOR_PHONE` | SMS. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL` | Web push to operators (`npm run generate-vapid`). |
| `OWNER_EMAIL` | Statement recipient + privacy contact. |
| `COMMISSION_RATE` | Operator commission on net revenue (default `0.15`). |
| `GOOGLE_ANALYTICS_ID`, `FACEBOOK_PIXEL_ID` | Analytics (silent if unset). |
| `GOOGLE_REVIEW_LINK` | Post-return Google review request link. |
| `SENTRY_DSN` | Error monitoring. |

See `.env.example` for the full annotated list.

---

## 3. Stand up a new client (step by step)

1. **Fork / clone** this repo into a new GitHub repo for the client.
2. **Create a Railway project** → "Deploy from GitHub repo" → select the repo.
3. **Add the Postgres plugin** in Railway (sets `DATABASE_URL` automatically).
   Set `DB_SSL=true`.
4. **Set the env vars** from §2 (at minimum the Required table) in Railway →
   your service → Variables.
5. **Deploy.** `railway.toml` runs `npm run migrate:up` then `npm start`. The
   health check is `GET /health` → `{ ok: true }`.
6. **Seed inventory** (see §4) and **create the first admin**:
   - In Railway, run a one-off command (or `railway run` locally):
     `node scripts/seed-trailers.js`
     `node scripts/create-admin.js --email you@client.com --name "Owner" --role admin`
7. **Wire Stripe** (when ready for live payments): set `STRIPE_SECRET_KEY`, add a
   webhook in the Stripe dashboard pointing at `https://<your-domain>/webhooks/stripe`
   for `checkout.session.completed`, and set `STRIPE_WEBHOOK_SECRET`.
8. **Wire email/SMS** (optional): set `RESEND_API_KEY` + verified `FROM_EMAIL`
   domain, and the `TWILIO_*` vars.
9. **Point the domain** (see §5).

---

## 4. Add custom inventory

Inventory lives in `scripts/seed-trailers.js` as a `PACKAGES` array. Each item:

```js
{
  slug: 'one-two-bedroom',     // URL-safe, unique
  name: '1–2 Bedroom',
  size_label: '35 units + 1 dolly',
  description: '…',
  weekly_rate: 12900,          // CENTS per week ($129.00)
  bin_count: 35, dolly_count: 1,
  is_custom: false,            // true = per-unit pricing; customer picks quantity (min 10)
  quantity_total: 10,          // how many of this package you own
  display_order: 2,
  specs: ['…', '…'],
}
```

Edit the array, then run `node scripts/seed-trailers.js` (idempotent on `slug`;
items removed from the array are deactivated, not deleted — booking history is
preserved). Operators can also adjust pricing/status/quantity live in the PWA
under **Inventory**.

Operator-tunable business settings (deposit toggle, tax rate, lost-unit fee,
extension rate) live in the `settings` table and the PWA **Settings** screen.

---

## 5. Custom domain

1. Railway → your service → **Settings → Networking → Custom Domain** → add the
   client's domain (e.g. `toledototes.com`).
2. At the client's DNS provider, add the CNAME Railway shows you.
3. Railway provisions SSL automatically.
4. Set `SITE_URL=https://toledototes.com` so sitemap/robots/links use it.

---

## 6. What is config-driven vs. still hard-coded

**Config-driven today:** business name, phone, email, address, brand colors,
rental type, logo URL (via `BUSINESS_*` / `BRAND_*` / `RENTAL_TYPE` /
`LOGO_SVG_URL`), all integrations, inventory (seed), and operator-tunable
settings. These are exposed to every page via `app.locals.business`.

**Productization backlog (templating still in progress):** the marketing
homepage copy (`public/index.html`) and a few section labels read the brand
from config but still contain example copy worth tailoring per client; the
rental agreement (`server/services/contract.js`) pulls the business name +
address from config but its clause language is written for moving-bin rentals —
adjust clauses for `trailers`/`equipment` clients. Track these when onboarding a
non-bin client.

---

## 7. Local development

```bash
cp .env.example .env      # fill in DATABASE_URL, JWT_SECRET, BUSINESS_* at minimum
npm install
npm run migrate:up
npm run seed
npm run create-admin -- --email you@example.com --name "You" --role admin
npm run dev               # http://localhost:3000  (operator at /operator)
```
