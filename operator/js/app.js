'use strict';

/*
 * Operator PWA controller. Tiny state machine — no router library. Views are
 * cloned from <template> elements in index.html:
 *   login  →  dashboard  →  inventory  →  trailer detail
 * Auth lives in api.js (JWT in localStorage, auto-refresh). Every operator
 * API call goes through api.apiFetch, which adds the bearer token.
 */

(function (GC) {
  const { api } = GC;
  const root = document.getElementById('app');

  function mount(templateId) {
    const tpl = document.getElementById(templateId);
    root.replaceChildren(tpl.content.cloneNode(true));
  }

  // If the session can't be recovered, drop back to login. Returns true when
  // it handled an auth failure so callers can stop.
  function handleAuth(err) {
    if (err instanceof api.AuthError) {
      const cached = api.auth.user;
      renderLogin(cached && cached.email);
      return true;
    }
    return false;
  }

  // ── Money helpers (DB stores integer cents) ─────────────────────────────
  function centsToInput(c) {
    if (c == null) return '';
    return Number.isInteger(c) && c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2);
  }
  function inputToCents(str) {
    const s = String(str).trim();
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }
  function fmtMoney(c) {
    if (c == null) return null;
    return c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`;
  }

  // Short pricing summary for list rows.
  function priceSummary(t) {
    if (t.type === 'dumpster') {
      const drop = fmtMoney(t.flat_drop_off_cents);
      return drop ? `${drop} drop-off` : '';
    }
    const daily = fmtMoney(t.daily_rate);
    return daily ? `${daily}/day` : '';
  }

  function statusLabel(s) {
    return s === 'out_of_service' ? 'Out of Service' : 'Available';
  }

  // Keep a badge + toggle button visually in sync with a trailer's status.
  function paintStatus(badgeEl, toggleEl, status) {
    const oos = status === 'out_of_service';
    badgeEl.textContent = statusLabel(status);
    badgeEl.classList.toggle('badge-oos', oos);
    badgeEl.classList.toggle('badge-ok', !oos);
    if (toggleEl) {
      toggleEl.textContent = oos ? 'Set Available' : 'Set Out of Service';
      toggleEl.classList.toggle('btn-restore', oos);
      toggleEl.classList.toggle('btn-danger', !oos);
    }
  }

  // Wire a status toggle. PATCHes the new status and updates in place — no
  // page reload. `errEl` shows transient failures; `onChange` lets the caller
  // refresh anything else bound to this trailer.
  function wireToggle(trailer, badgeEl, toggleEl, errEl, onChange) {
    paintStatus(badgeEl, toggleEl, trailer.status);
    toggleEl.addEventListener('click', async () => {
      const next = trailer.status === 'out_of_service' ? 'available' : 'out_of_service';
      toggleEl.disabled = true;
      if (errEl) errEl.hidden = true;
      try {
        const data = await api.apiFetch(`/api/operator/trailers/${trailer.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: next }),
        });
        Object.assign(trailer, data.trailer);
        paintStatus(badgeEl, toggleEl, trailer.status);
        if (onChange) onChange(trailer);
      } catch (err) {
        if (handleAuth(err)) return;
        if (errEl) {
          errEl.textContent = err.message || 'Could not update. Try again.';
          errEl.hidden = false;
        }
      } finally {
        toggleEl.disabled = false;
      }
    });
  }

  // ── Login ─────────────────────────────────────────────────────────────
  function renderLogin(prefillEmail) {
    mount('tpl-login');
    const form = root.querySelector('form');
    const errorEl = form.querySelector('[data-error]');
    const submitBtn = form.querySelector('[data-submit]');
    const emailEl = form.querySelector('#email');
    const passwordEl = form.querySelector('#password');

    if (prefillEmail) emailEl.value = prefillEmail;
    (prefillEmail ? passwordEl : emailEl).focus();

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = !msg;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const email = emailEl.value.trim();
      const password = passwordEl.value;
      if (!email || !password) {
        showError('Enter your email and password.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Logging in…';
      try {
        await api.login(email, password);
        renderDashboard();
      } catch (err) {
        showError(err.message || 'Login failed.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log in';
        passwordEl.select();
      }
    });
  }

  // ── Dashboard ──────────────────────────────────────────────────────────
  async function renderDashboard() {
    mount('tpl-dashboard');

    const welcome = root.querySelector('[data-welcome]');
    const logoutBtn = root.querySelector('[data-logout]');
    const inventoryNav = root.querySelector('[data-nav="inventory"]');

    logoutBtn.addEventListener('click', () => {
      api.logout();
      renderLogin();
    });
    inventoryNav.addEventListener('click', () => renderInventory());

    // Show whatever we already know immediately, then confirm with the API.
    const cached = api.auth.user;
    if (cached) welcome.textContent = `Signed in as ${cached.name || cached.email}.`;

    try {
      const data = await api.apiFetch('/api/operator/dashboard');
      const u = data.user || cached || {};
      welcome.textContent = `Signed in as ${u.name || u.email || 'operator'}.`;
    } catch (err) {
      if (handleAuth(err)) return;
      welcome.textContent = 'Could not reach the server. Pull to refresh when back online.';
    }
  }

  // ── Inventory ──────────────────────────────────────────────────────────
  async function renderInventory() {
    mount('tpl-inventory');

    root.querySelector('[data-back]').addEventListener('click', () => renderDashboard());
    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const listEl = root.querySelector('[data-list]');

    let trailers;
    try {
      const data = await api.apiFetch('/api/operator/trailers');
      trailers = data.trailers || [];
    } catch (err) {
      if (handleAuth(err)) return;
      loadingEl.hidden = true;
      errEl.textContent = err.message || 'Could not load the fleet.';
      errEl.hidden = false;
      return;
    }

    loadingEl.hidden = true;
    if (trailers.length === 0) {
      loadingEl.hidden = false;
      loadingEl.textContent = 'No trailers yet.';
      return;
    }

    const rowTpl = document.getElementById('tpl-trailer-row');
    for (const trailer of trailers) {
      const node = rowTpl.content.cloneNode(true);
      const thumb = node.querySelector('[data-thumb]');
      const nameEl = node.querySelector('[data-name]');
      const subEl = node.querySelector('[data-sub]');
      const badgeEl = node.querySelector('[data-badge]');
      const toggleEl = node.querySelector('[data-toggle]');
      const openEl = node.querySelector('[data-open]');

      if (trailer.photo_url) {
        thumb.src = trailer.photo_url;
        thumb.alt = trailer.name;
        thumb.addEventListener('error', () => thumb.classList.add('thumb-broken'));
      } else {
        thumb.classList.add('thumb-broken');
      }
      nameEl.textContent = trailer.name;
      subEl.textContent = [trailer.size_label, priceSummary(trailer)].filter(Boolean).join(' · ');

      wireToggle(trailer, badgeEl, toggleEl, errEl);
      openEl.addEventListener('click', () => renderTrailerDetail(trailer));

      listEl.appendChild(node);
    }
    listEl.hidden = false;
  }

  // ── Trailer detail ─────────────────────────────────────────────────────
  // Editable fields per trailer type. kind drives the input + conversion.
  const COMMON_FIELDS = [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'photo_url', label: 'Photo URL', kind: 'text' },
    { key: 'description', label: 'Description', kind: 'textarea' },
  ];
  const TRAILER_FIELDS = [
    { key: 'hourly_rate', label: 'Hourly rate ($)', kind: 'money' },
    { key: 'daily_rate', label: 'Daily rate ($)', kind: 'money' },
    { key: 'weekly_rate', label: 'Weekly rate ($)', kind: 'money' },
    { key: 'monthly_rate', label: 'Monthly rate ($)', kind: 'money' },
  ];
  const DUMPSTER_FIELDS = [
    { key: 'flat_drop_off_cents', label: 'Drop-off flat ($)', kind: 'money' },
    { key: 'flat_drop_off_days', label: 'Days included', kind: 'int' },
    { key: 'extra_day_cents', label: 'Extra day ($)', kind: 'money' },
    { key: 'per_tire_cents', label: 'Per tire ($)', kind: 'money' },
  ];

  function fieldsFor(type) {
    return COMMON_FIELDS.concat(type === 'dumpster' ? DUMPSTER_FIELDS : TRAILER_FIELDS);
  }

  function renderTrailerDetail(trailer) {
    mount('tpl-trailer-detail');

    root.querySelector('[data-back]').addEventListener('click', () => renderInventory());

    const photoEl = root.querySelector('[data-photo]');
    const titleEl = root.querySelector('[data-title]');
    const typeEl = root.querySelector('[data-typeline]');
    const badgeEl = root.querySelector('[data-badge]');
    const toggleEl = root.querySelector('[data-toggle]');
    const fieldsEl = root.querySelector('[data-fields]');
    const formEl = root.querySelector('[data-form]');
    const errEl = root.querySelector('[data-error]');
    const savedEl = root.querySelector('[data-saved]');
    const saveBtn = root.querySelector('[data-save]');

    function paintHead() {
      titleEl.textContent = trailer.name;
      const typeName = trailer.type === 'dumpster' ? 'Dumpster' : 'Trailer';
      typeEl.textContent = [typeName, trailer.size_label].filter(Boolean).join(' · ');
      if (trailer.photo_url) {
        photoEl.src = trailer.photo_url;
        photoEl.alt = trailer.name;
        photoEl.hidden = false;
        photoEl.addEventListener('error', () => { photoEl.hidden = true; }, { once: true });
      }
    }
    paintHead();

    wireToggle(trailer, badgeEl, toggleEl, errEl, paintHead);

    // Build the edit form from the field config.
    const fields = fieldsFor(trailer.type);
    const inputs = {};
    for (const f of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const label = document.createElement('label');
      label.textContent = f.label;
      const id = `f-${f.key}`;
      label.htmlFor = id;

      let input;
      if (f.kind === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
      } else {
        input = document.createElement('input');
        input.type = f.kind === 'text' ? 'text' : 'number';
        if (f.kind === 'money') { input.step = '0.01'; input.min = '0'; input.inputMode = 'decimal'; }
        if (f.kind === 'int') { input.step = '1'; input.min = '0'; input.inputMode = 'numeric'; }
      }
      input.id = id;
      input.value =
        f.kind === 'money' ? centsToInput(trailer[f.key]) :
        trailer[f.key] == null ? '' : String(trailer[f.key]);

      inputs[f.key] = input;
      wrap.append(label, input);
      fieldsEl.appendChild(wrap);
    }

    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      savedEl.hidden = true;

      const patch = {};
      for (const f of fields) {
        const raw = inputs[f.key].value;
        if (f.kind === 'money') patch[f.key] = inputToCents(raw);
        else if (f.kind === 'int') patch[f.key] = raw.trim() === '' ? null : parseInt(raw, 10);
        else patch[f.key] = raw.trim() === '' ? null : raw.trim();
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const data = await api.apiFetch(`/api/operator/trailers/${trailer.id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        Object.assign(trailer, data.trailer);
        paintHead();
        savedEl.hidden = false;
      } catch (err) {
        if (handleAuth(err)) return;
        errEl.textContent = err.message || 'Could not save.';
        errEl.hidden = false;
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save changes';
      }
    });
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  function start() {
    if (api.auth.isLoggedIn()) {
      renderDashboard();
    } else {
      renderLogin();
    }
  }

  // Register the service worker (PWA installability). Failure is non-fatal —
  // the app still works, it just isn't installable/offline.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/operator/service-worker.js', { scope: '/operator/' })
        .catch((err) => console.warn('SW registration failed:', err));
    });
  }

  start();
})(window.GC);
