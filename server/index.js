'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const monitoring = require('./services/monitoring');

// Initialize error monitoring as early as possible (no-op without SENTRY_DSN).
monitoring.init();
const { reportError } = monitoring;

const app = express();

// Railway terminates TLS at its edge proxy; trust it so req.ip / secure
// cookies behave correctly behind the proxy.
app.set('trust proxy', 1);

// Don't advertise the framework/version to attackers.
app.disable('x-powered-by');

// Security headers (helmet): CSP, HSTS, X-Content-Type-Options, frameguard,
// Referrer-Policy, etc. The CSP allow-lists the third parties the site actually
// loads — Stripe, Google Fonts, unpkg (AOS), and (when enabled) GA4 + Pixel.
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com', 'https://unpkg.com',
        'https://www.googletagmanager.com', 'https://connect.facebook.net', 'https://*.google-analytics.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      frameSrc: ['https://js.stripe.com', 'https://hooks.stripe.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api.stripe.com', 'https://www.googletagmanager.com',
        'https://*.google-analytics.com', 'https://connect.facebook.net', 'https://www.facebook.com'],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  crossOriginEmbedderPolicy: false, // let cross-origin fonts / AOS / Stripe load
}));

// CORS — the API is same-origin, so only the production hostnames may call it
// from a browser (blocks other sites from using the API with credentials).
const cors = require('cors');
app.use(cors({
  origin: ['https://blackswamptotes.com', 'https://www.blackswamptotes.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

// EJS server-rendered pages live in server/views.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Marketing analytics tags (GA4 + Pixel), env-gated. Exposed to every EJS view
// via app.locals so each <head> can include them; empty string when unset.
const analytics = require('./services/analytics');
app.locals.analyticsHead = analytics.headTags();
app.locals.facebookPixelId = analytics.PIXEL_ID;
app.locals.siteUrl = config.siteUrl;

// Stripe webhook needs the raw request body to verify the signature, so it is
// registered before the JSON body parser. Use type: '*/*' so the raw body is
// captured regardless of the Content-Type Stripe sends.
const webhookRoutes = require('./routes/webhooks');
app.use('/webhooks', express.raw({ type: '*/*' }), webhookRoutes);

app.use(express.json({ limit: '1mb' })); // headroom for base64 signature images
app.use(express.urlencoded({ extended: true }));

// Input hardening — runs after the body parsers (so it sees parsed input) and
// after the raw Stripe webhook mount above (so it never touches the raw body).
// hpp drops duplicated query/body params; xss-clean escapes <>-style HTML in
// string inputs (leaves base64 signatures, &, #, apostrophes untouched).
const hpp = require('hpp');
const xssClean = require('xss-clean');
app.use(hpp());
app.use(xssClean());

// Rate limiting (per client IP via trust-proxy). Strict on login to deter brute
// force, an hourly cap on booking creation, and a general ceiling on the API.
const rateLimit = require('express-rate-limit');
const limiterOpts = { standardHeaders: true, legacyHeaders: false };
const loginLimiter = rateLimit({
  ...limiterOpts, windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});
const bookingLimiter = rateLimit({
  ...limiterOpts, windowMs: 60 * 60 * 1000, max: 10,
  message: { error: 'Too many booking attempts — please try again later.' },
});
const apiLimiter = rateLimit({
  ...limiterOpts, windowMs: 15 * 60 * 1000, max: 200,
  message: { error: 'Too many requests — please slow down.' },
});
app.use('/api/auth/login', loginLimiter);
// Only the booking-creation POST (not the sign/checkout/lookup sub-paths).
app.use('/api/bookings', (req, res, next) =>
  (req.method === 'POST' && (req.path === '/' || req.path === '')) ? bookingLimiter(req, res, next) : next());
app.use('/api/', apiLimiter);

const authRoutes = require('./routes/auth');
const operatorRoutes = require('./routes/api-operator');
const apiPublicRoutes = require('./routes/api-public');
const publicPageRoutes = require('./routes/public');
const { requireAuth } = require('./middleware/auth');

// --- Health check (Phase 0 acceptance) ---
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// --- JSON API ---
// Auth endpoints are public (login/refresh); everything under /api/operator
// requires a valid access token.
app.use('/api/auth', authRoutes);
app.use('/api/operator', requireAuth, operatorRoutes);
// Automated reminders for an external scheduler (cron-job.org). Guarded by its
// own CRON_SECRET bearer token, so it's mounted before the public /api router.
const cronRoutes = require('./routes/cron');
app.use('/api/cron', cronRoutes);
// Public customer API (trailers, availability, quote). No auth.
app.use('/api', apiPublicRoutes);

// --- Operator PWA (Phase 2) ---
// Single-page app served from operator/. Mounted before the static marketing
// site so /operator/* resolves here. express.static serves index.html for both
// /operator and /operator/. The service worker must be served with no-cache so
// clients pick up new versions immediately, and its scope is the /operator/
// subtree (it lives at the root of that path).
const operatorDir = path.join(__dirname, '..', 'operator');
app.use(
  '/operator',
  express.static(operatorDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('service-worker.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/operator/');
      }
    },
  })
);

// --- Blog / SEO content pages ---
const blogRoutes = require('./routes/blog');
app.use('/blog', blogRoutes);

// --- Server-rendered booking pages (Phase 4) ---
// Trailer detail + availability calendar at /fleet/:slug and the dedicated
// roll-off flow at /book/dumpster. Unknown slugs fall through to the 404.
app.use('/', publicPageRoutes);

// --- Static marketing site, served at / ---
// Placed after explicit routes so /health and /fleet/* win. index.html is the
// directory index, so GET / serves the existing marketing page unchanged.
const publicDir = path.join(__dirname, '..', 'public');

// The marketing homepage is a static file, so it can't read env vars to gate
// analytics. When analytics is configured, inject the tags into <head> once at
// boot and serve that cached HTML for GET / (otherwise express.static serves
// the file untouched).
if (app.locals.analyticsHead) {
  try {
    const homepageHtml = require('fs')
      .readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace('</head>', `${app.locals.analyticsHead}\n</head>`);
    app.get('/', (req, res) => res.type('html').send(homepageHtml));
  } catch (e) {
    console.error('[analytics] homepage injection skipped:', e.message);
  }
}

// Explicit routes for the critical SEO files so they always serve with the
// correct Content-Type regardless of static-middleware ordering. express.static
// already serves them; this is belt-and-suspenders for sitemap.xml / robots.txt.
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').sendFile(path.join(publicDir, 'sitemap.xml'));
});
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(publicDir, 'robots.txt'));
});

app.use(express.static(publicDir));

// API/webhook requests get JSON; browser page requests get a rendered HTML page.
function wantsJson(req) {
  return req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')
    || (req.get('accept') || '').includes('application/json');
}

// --- 404 ---
app.use((req, res) => {
  if (wantsJson(req)) {
    return res.status(404).json({ error: 'Not Found' });
  }
  res.status(404).render('errors/404');
});

// --- Centralized error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  reportError(err, req);
  const status = err.status || 500;
  if (wantsJson(req)) {
    return res.status(status).json({ error: status === 500 ? 'Internal Server Error' : (err.message || 'Error') });
  }
  res.status(status).render(status === 404 ? 'errors/404' : 'errors/500');
});

const server = app.listen(config.port, () => {
  console.log(`Black Swamp Totes Rentals listening on :${config.port} (${config.env})`);
  // One-line integration readiness check — handy for diagnosing why an
  // email/SMS/push didn't fire after a deploy.
  const on = (v) => (v ? 'on' : 'OFF');
  console.log(
    '[integrations] '
    + `stripe=${on(config.stripeSecretKey)} webhook_secret=${on(config.stripeWebhookSecret)} `
    + `resend=${on(config.resendApiKey)} push=${on(config.vapidPublicKey && config.vapidPrivateKey)} `
    + `twilio=${on(config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber)} `
    + `operator_phone=${on(config.operatorPhone)}`
  );

  // Schema readiness check — turns an opaque "internal error" into a clear log
  // line when the release-phase `migrate:up` didn't run (e.g. operator + fleet
  // pages 500 because new columns are missing). Best-effort, non-blocking.
  require('./db').query(
    "SELECT 1 FROM information_schema.columns WHERE table_name='trailers' AND column_name='bin_count'"
  ).then((r) => {
    if (!r.rows.length) {
      console.error('[schema] ⚠ migrations NOT applied (trailers.bin_count missing). '
        + 'DB-backed routes will 500. Run: npm run migrate:up');
    } else {
      console.log('[schema] up to date');
    }
  }).catch((e) => console.error('[schema] readiness check failed:', e.message));
});

// Graceful shutdown so Railway redeploys don't drop in-flight requests.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
