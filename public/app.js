/* ==========================================================================
   Journal — views and wiring. The rules live in model.js (no DOM there).

   Everything is loaded in one round trip, kept in `state`, and the whole
   active view is re-rendered after any change. At the scale of a personal
   app that is far cheaper than the bookkeeping a finer-grained update needs.
   The one place that matters is the calendar: a click re-renders the grid,
   so the half that was clicked is found again by day and habit and given
   the focus back, rather than by position.
   ========================================================================== */

'use strict';

const VIEWS = ['habits'];

const state = {
  config: null,
  days: [],
  view: 'habits',
  // View state, not saved: the month on screen is a way of looking at the
  // days, not a property of them. It rides in the URL so a reload keeps it.
  month: null,
  // Halves with a save in flight, keyed `${id}:${habit}`. A second click
  // before the first answers would compute its toggle from a list the first
  // has not yet updated, send a stale version, and be refused with a 409 —
  // a conflict that is nobody's fault and should not be reported as one.
  pending: new Set(),
  sheetDirty: false,
  closeSheet: null,
};

// --- DOM helpers ------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

/** A labelled control, matching the markup `.entry-row` expects. */
function field(labelText, control, cls) {
  const label = el('label', cls || null);
  label.append(document.createTextNode(labelText), control);
  return label;
}
function input(type, value, attrs = {}) {
  const n = el('input');
  n.type = type;
  n.value = value == null ? '' : value;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// --- dates ------------------------------------------------------------------
// Presentation only; the arithmetic is in model.js. A day id is turned into a
// local Date by its parts, never by `new Date('YYYY-MM-DD')`, which parses as
// UTC midnight and prints as the previous evening anywhere west of Greenwich.

const asDate = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
const longDate = (day) => asDate(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
/* The year only when it is not this one. "Last use Aug 14, 2026" wraps in a
   streak tile on a phone; "Last use Aug 14" does not, and inside the current
   year the year says nothing. Once the streak passes a year it matters and
   comes back. */
const sinceDate = (day, now) => asDate(day).toLocaleDateString(undefined,
  day.slice(0, 4) === now.slice(0, 4) ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
const monthTitle = (ym) => asDate(`${ym}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const today = () => Model.dayOf(new Date());
const currentMonth = () => Model.monthOf(today());
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// --- notices and save status ------------------------------------------------

function notice(text) {
  const n = $('notice');
  if (!text) { n.hidden = true; return; }
  n.textContent = text;
  n.hidden = false;
}
let statusTimer = null;
function status(text) {
  $('save-status').textContent = text;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { $('save-status').textContent = ''; }, 1800);
}

// --- transport --------------------------------------------------------------
// Relative URLs throughout, so the app works under a proxy path prefix.

async function request(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

/** Pull everything fresh and redraw. Used after a version conflict: another
 *  device wrote first, so the safe move is to take their state, not merge. */
async function reloadState() {
  const payload = await request('api/state', 'GET');
  state.config = payload.config;
  state.days = payload.days || [];
  applyTheme(state.config.theme);
  render();
}

/** Save one record, keeping the local copy in step with the version the
 *  server assigned. Returns true on success. */
async function saveRecord(record) {
  status('saving…');
  try {
    const payload = await request(`api/days/${record.id}`, 'PUT', record);
    const list = state.days;
    const at = list.findIndex((x) => x.id === record.id);
    // Take the server's copy: it carries the version the next save must echo.
    if (at === -1) list.push(payload.record); else list[at] = payload.record;
    notice('');
    status('saved');
    return true;
  } catch (err) {
    status('');
    if (err.status === 409) {
      notice(`${err.message}. Reloaded — your last edit was not saved.`);
      await reloadState().catch(() => {});
    } else {
      notice(`Could not save: ${err.message}`);
    }
    return false;
  }
}

async function deleteRecord(record) {
  status('deleting…');
  try {
    await request(`api/days/${record.id}?version=${record.version || 0}`, 'DELETE');
    const list = state.days;
    const at = list.findIndex((x) => x.id === record.id);
    if (at !== -1) list.splice(at, 1);
    notice('');
    status('deleted');
    return true;
  } catch (err) {
    status('');
    if (err.status === 409) {
      notice(`${err.message}. Reloaded — nothing was deleted.`);
      await reloadState().catch(() => {});
    } else {
      notice(`Could not delete: ${err.message}`);
    }
    return false;
  }
}

/**
 * A click on one half of one day. The model says what the day becomes; this
 * decides whether that is a save or a delete. A day with nothing marked is
 * deleted rather than saved as a row of falses, so the store stays a list of
 * the days that broke a streak — see Model.toggle.
 */
async function toggleHalf(id, habit) {
  const key = `${id}:${habit}`;
  if (state.pending.has(key)) return;
  const { record, clean, stored } = Model.toggle(state.days, id, habit);
  state.pending.add(key);
  try {
    if (clean) { if (stored) await deleteRecord(record); }
    else await saveRecord(record);
  } finally {
    state.pending.delete(key);
  }
  render();
}

// --- theme ------------------------------------------------------------------

function tint(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return `rgba(168, 198, 108, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
function applyTheme(theme) {
  const root = document.documentElement.style;
  if (theme?.accent) {
    root.setProperty('--accent', theme.accent);
    root.setProperty('--accent-wash', tint(theme.accent, 0.16));
    root.setProperty('--accent-dim', tint(theme.accent, 0.55));
  }
  const app = state.config?.app;
  if (app?.title) {
    document.title = app.title;
    const h1 = clear($('masthead-title'));
    h1.append(document.createTextNode(app.title + ' '));
    if (app.emoji) {
      const g = el('span', 'masthead-emoji', app.emoji);
      g.setAttribute('role', 'img');
      h1.append(g);
    }
  }
}

// --- routing ----------------------------------------------------------------
// The view is a query parameter, so a link to a view is a real URL. So is the
// month: `?view=habits&month=2026-08` reloads to August. A month past the
// current one is ignored rather than shown — every day in it would be inert.

function viewFromUrl() {
  const asked = new URLSearchParams(location.search).get('view');
  return VIEWS.includes(asked) ? asked : VIEWS[0];
}
function monthFromUrl() {
  const asked = new URLSearchParams(location.search).get('month');
  const now = currentMonth();
  return asked && /^\d{4}-\d{2}$/.test(asked) && asked <= now ? asked : now;
}
const plainClick = (ev) => ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;

function setView(view, { push = true } = {}) {
  state.view = VIEWS.includes(view) ? view : VIEWS[0];
  state.month = monthFromUrl();
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.view === state.view;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== state.view;
  const url = new URL(location.href);
  url.searchParams.set('view', state.view);
  if (push) history.pushState({ view: state.view }, '', url);
  else history.replaceState({ view: state.view }, '', url);
  render();
}

/** Show another month. replaceState, not pushState: the back button should
 *  leave the page, not walk back through every month that was looked at. */
function setMonth(ym) {
  if (ym > currentMonth()) return;
  state.month = ym;
  const url = new URL(location.href);
  url.searchParams.set('month', ym);
  history.replaceState(history.state, '', url);
  render();
}

// --- sheet ------------------------------------------------------------------
// Unused by the Habits view, which edits in place; kept because the next
// view will need an editor and the overlay is already general.

function openSheet(build) {
  const scrim = $('scrim');
  const sheet = clear($('sheet'));
  const returnFocus = document.activeElement;
  state.sheetDirty = false;
  const close = ({ force = false } = {}) => {
    if (!force && state.sheetDirty && !confirm('Discard unsaved changes?')) return;
    scrim.hidden = true;
    state.closeSheet = null;
    clear(sheet);
    document.body.style.overflow = '';
    returnFocus?.focus?.();
  };
  state.closeSheet = close;
  build(sheet, close);
  sheet.addEventListener('input', () => { state.sheetDirty = true; });
  scrim.hidden = false;
  document.body.style.overflow = 'hidden';
  // A field before a button: the close control comes first in the DOM and
  // must not be what the keyboard lands on.
  (sheet.querySelector('input, select, textarea') || sheet.querySelector('button'))?.focus();
}

function sheetHead(sheet, titleText, subText, close) {
  const head = el('div', 'sheet-head');
  const left = el('div');
  const title = el('h2', 'sheet-title', titleText);
  title.id = 'sheet-title';
  left.append(title, el('p', 'sheet-sub', subText || ''));
  const x = el('button', 'sheet-close', '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', () => close());
  head.append(left, x);
  sheet.append(head);
}

// --- rendering --------------------------------------------------------------

function render() {
  if (state.view === 'habits') renderHabits();
}

function renderHabits() {
  const now = today();
  renderStreaks(now);
  renderCalendar(now);
}

/** One tile per habit: the count, its unit, and the day it counts from. */
function renderStreaks(now) {
  const box = clear($('streaks'));
  for (const h of Model.HABITS) {
    const n = Model.streak(state.days, h.key, now);
    const last = Model.lastUse(state.days, h.key, now);
    const tile = el('div', 'streak');
    const figure = el('div', 'streak-figure');
    const value = el('span', 'streak-value', n === null ? '—' : String(n));
    value.setAttribute('data-num', '');
    figure.append(value, el('span', 'streak-unit', n === 1 ? 'day' : 'days'));
    const since = el('div', 'streak-since', last ? `Last use ${sinceDate(last, now)}` : 'Nothing logged');
    tile.append(el('p', 'eyebrow', h.label), figure, since);
    box.append(tile);
  }
}

/**
 * The month grid. Every day has one half per habit; a half is a button so
 * it takes the keyboard and a screen reader reads its state. Days after
 * today are drawn neutral and disabled — there is nothing to say about a day
 * that has not happened — and days outside the month are blank, not the
 * neighbouring month's tail (see Model.monthGrid).
 *
 * The grid is rebuilt on every render, so the half that had the focus is
 * looked up again afterwards by day and habit, not by position: a click,
 * a save and a redraw must leave the keyboard where it was.
 */
function renderCalendar(now) {
  const ym = state.month;
  const focused = document.activeElement?.closest?.('.half');
  const keep = focused ? [focused.dataset.id, focused.dataset.habit] : null;

  $('month-title').textContent = monthTitle(ym);
  $('month-next').disabled = ym >= currentMonth();
  $('month-today').disabled = ym === currentMonth();

  const grid = clear($('calendar'));
  for (const name of WEEKDAYS) grid.append(el('div', 'weekday', name));
  for (const week of Model.monthGrid(ym)) {
    for (const id of week) {
      if (!id) { grid.append(el('div', 'day is-pad')); continue; }
      const day = el('div', 'day');
      if (id === now) day.classList.add('is-today');
      const future = id > now;
      if (future) day.classList.add('is-future');
      day.append(el('span', 'day-num', String(Number(id.slice(8)))));
      const halves = el('div', 'day-halves');
      for (const h of Model.HABITS) {
        const on = Model.used(state.days, id, h.key);
        const b = el('button', `half ${on ? 'is-used' : 'is-clean'}`);
        b.type = 'button';
        b.dataset.id = id;
        b.dataset.habit = h.key;
        b.disabled = future || state.pending.has(`${id}:${h.key}`);
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', `${h.label}, ${longDate(id)}`);
        b.title = `${h.label} · ${longDate(id)}`;
        halves.append(b);
      }
      day.append(halves);
      grid.append(day);
    }
  }
  if (keep) grid.querySelector(`.half[data-id="${keep[0]}"][data-habit="${keep[1]}"]`)?.focus();
}

// --- wiring -----------------------------------------------------------------

function wire() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', (ev) => {
      if (!plainClick(ev)) return;
      ev.preventDefault();
      setView(tab.dataset.view);
    });
  }
  window.addEventListener('popstate', () => setView(viewFromUrl(), { push: false }));
  $('month-prev').addEventListener('click', () => setMonth(Model.shiftMonth(state.month, -1)));
  $('month-next').addEventListener('click', () => setMonth(Model.shiftMonth(state.month, 1)));
  $('month-today').addEventListener('click', () => setMonth(currentMonth()));
  // One listener for the whole grid rather than one per half: the grid is
  // rebuilt on every render, and 60-odd listeners a redraw is waste.
  $('calendar').addEventListener('click', (ev) => {
    const half = ev.target.closest('.half');
    if (!half || half.disabled) return;
    toggleHalf(half.dataset.id, half.dataset.habit);
  });
  // A phone left open overnight comes back on a new day: redraw so today's
  // outline and the streak move without a reload.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.config) render(); });
  $('scrim').addEventListener('click', (ev) => { if (ev.target === $('scrim')) state.closeSheet?.(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('scrim').hidden) state.closeSheet?.();
  });
}

async function boot() {
  try {
    const payload = await request('api/state', 'GET');
    state.config = payload.config;
    state.days = payload.days || [];
    applyTheme(state.config.theme);
    wire();
    setView(viewFromUrl(), { push: false });
  } catch (err) {
    notice(`Could not load: ${err.message}`);
  }
}

boot();
