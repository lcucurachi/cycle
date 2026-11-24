// User interface: screens, buttons and logging.

import { todayStr, toDay, fromDay, diffDays, addDays, fmt, fmtRange, fmtMonth, weekdayNames } from './dates.js';
import { analyze, loggedDays, sortPeriods, OPEN_PERIOD_MAX, MIN_CYCLE } from './predict.js';
import { loadAll, savePeriods, saveSettings, clearAll, requestPersistence, makeBackup, parseBackup } from './storage.js';
import * as cal from './calendar.js';

import { APP_ID, APP_VERSION as VERSION } from './config.js'; // set in index.html

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');

const state = {
  periods: [],
  settings: null,
  tab: 'today',
  month: null,          // 'YYYY-MM' shown in the calendar
  today: null,
  pred: null,           // result of analyze()
  logged: new Set(),    // every logged period day
};

// ---------- Helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const longDate = (d) => `${fmt(d, { weekday: 'long' })} ${fmt(d)}`;
const periodLen = () => state.pred?.periodLength || state.settings.periodLength;

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
}

function openSheet(html) {
  $sheet.innerHTML = html;
  if (!$sheet.open) $sheet.showModal();
}
function closeSheet() {
  if ($sheet.open) $sheet.close();
}
// Tap outside the sheet closes it
$sheet.addEventListener('click', (e) => { if (e.target === $sheet) closeSheet(); });

/**
 * Date field that always displays dd/mm/yyyy.
 * The phone's own date input sits invisibly on top, so tapping opens the native picker
 * (always correct dates), while the visible text is written by the app.
 */
function dateField(name, value = '', { required = false } = {}) {
  return `<span class="date-field">
      <span class="date-display${value ? '' : ' placeholder'}" aria-hidden="true">${value ? fmt(value) : 'Select a date'}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>
      <input type="date" name="${name}" max="${state.today}" value="${value}" ${required ? 'required' : ''}>
    </span>`;
}

function updateDateField(input) {
  const display = input.parentElement.querySelector('.date-display');
  display.textContent = input.value ? fmt(input.value) : 'Select a date';
  display.classList.toggle('placeholder', !input.value);
}

/** First and last day drawn for a logged period (same rules as the calendar) */
function periodRange(p) {
  if (p.end) return [p.start, p.end];
  const dayNo = diffDays(p.start, state.today) + 1;
  if (dayNo >= 1 && dayNo <= OPEN_PERIOD_MAX) return [p.start, state.today];
  return [p.start, addDays(p.start, periodLen() - 1)];
}
const periodContaining = (d) => state.periods.find((p) => { const [s, e] = periodRange(p); return d >= s && d <= e; });

// ---------- Render ----------

function recompute() {
  state.today = todayStr();
  const count = Math.max(12, state.settings.calendarCount || 12);
  state.pred = analyze(state.periods, state.settings, state.today, count);
  state.logged = loggedDays(state.periods, periodLen(), state.today);
}

function render() {
  recompute();
  if (!state.settings.onboarded) {
    $tabs.hidden = true;
    $app.innerHTML = viewOnboarding();
    return;
  }
  $tabs.hidden = false;
  for (const b of $tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === state.tab);
  const views = { today: viewToday, calendar: viewCalendar, history: viewHistory, settings: viewSettings };
  $app.innerHTML = views[state.tab]();
}

// ---------- Onboarding ----------

function viewOnboarding() {
  return `
    <h1>Welcome to Cycle</h1>
    <div class="card soft"><p style="margin:0"><b>Private by design.</b> Everything stays on this phone: no account, no server, no tracking.</p></div>
    <form id="onboard" class="card">
      <label class="field"><span>When did your last period start?</span>
        ${dateField('last')}</label>
      <p class="muted small">Leave empty if you don't remember. You can log the next one when it starts.</p>
      <label class="field"><span>How long is your cycle usually? (days)</span>
        <input type="number" name="cycle" min="15" max="60" value="29" inputmode="numeric" required></label>
      <p class="muted small">From the first day of one period to the first day of the next. Not sure? Keep 29, the average.</p>
      <label class="field"><span>How many days does your period usually last?</span>
        <input type="number" name="period" min="1" max="12" value="5" inputmode="numeric" required></label>
      <button class="btn-primary btn-block" type="submit">Start</button>
    </form>
    <p class="muted small center">Estimates only. Not a medical device and not contraception.</p>`;
}

async function finishOnboarding(form) {
  const f = new FormData(form);
  const s = state.settings;
  // The iPhone date wheel ignores the "max" limit, so check for future dates here
  if (f.get('last') && f.get('last') > state.today) return toast('The date can\'t be in the future.');
  s.cycleLength = Math.min(60, Math.max(15, Number(f.get('cycle')) || 29));
  s.periodLength = Math.min(12, Math.max(1, Number(f.get('period')) || 5));
  s.onboarded = true;
  const last = f.get('last');
  if (last && last <= state.today) {
    const period = { start: last, end: null };
    // If the period is surely over, store an estimated end (not used for statistics)
    if (diffDays(last, state.today) + 1 > s.periodLength) {
      period.end = addDays(last, s.periodLength - 1);
      period.estimatedEnd = true;
    }
    state.periods = [period];
    await savePeriods(state.periods);
  }
  await saveSettings(s);
  requestPersistence();
  render();
}

// ---------- Today ----------

function viewToday() {
  const p = state.pred;
  const s = state.settings;
  let big, label, sub = '', progress = 0, chip = '';

  if (p.status === 'empty') {
    big = '–'; label = 'no period logged yet';
    sub = 'Log the first day of your next period to start predictions.';
  } else {
    progress = Math.min(100, Math.max(0, (p.cycleDay / p.cycleLength) * 100));
    const likely = fmtRange(p.next.low, p.next.high);
    chip = `Cycle day ${p.cycleDay}`;
    if (p.status === 'period') {
      big = `Day ${p.cycleDay}`; label = 'of your period';
      sub = `Next period expected around ${fmt(p.next.start)}`; chip = '';
    } else if (p.status === 'late') {
      progress = 100;
      big = String(p.daysLate); label = `${p.daysLate === 1 ? 'day' : 'days'} late`;
      sub = `Now likely ${likely}`;
    } else if (p.status === 'due') {
      big = 'Due'; label = 'period expected now';
      sub = `Most likely ${likely}`;
    } else {
      big = String(p.daysUntil); label = `${p.daysUntil === 1 ? 'day' : 'days'} until next period`;
      sub = `Expected ${fmt(p.next.start, { weekday: 'short' })} ${fmt(p.next.start)} · likely ${likely}`;
    }
  }

  let actions;
  if (p.status === 'period' && p.ongoing) {
    actions = `<button class="btn-primary btn-block" data-action="end-today">Period ended today</button>
      <button class="btn-link btn-block" data-action="pick" data-mode="end">Ended on another day</button>`;
  } else if (p.status === 'period') {
    actions = `<button class="btn-link btn-block" data-action="goto" data-tab="calendar">Edit in calendar</button>`;
  } else {
    actions = `<button class="btn-primary btn-block" data-action="start-today">Period started today</button>
      <button class="btn-link btn-block" data-action="pick" data-mode="start">Started on another day</button>`;
  }

  let basis = '';
  if (p.status !== 'empty') {
    basis = p.basedOn === 0
      ? `Based on your typical cycle setting (${s.cycleLength} days). Predictions become personal once you've logged 2 periods.`
      : `Based on your last ${plural(p.basedOn, 'cycle')} · typical cycle ${p.cycleLength} days ±${p.spread}.`;
    if (p.status === 'late' && p.daysLate > 45) basis += ' If you had periods you didn\'t log, add them in the calendar.';
  }

  return `
    <section class="hero">
      <div class="ring" style="--p:${progress.toFixed(1)}">
        <div class="ring-inner"><div class="ring-big">${big}</div><div class="ring-label">${label}</div></div>
      </div>
      <p class="hero-sub">${sub}</p>
      ${chip ? `<p class="muted small">${chip}</p>` : ''}
    </section>
    <div class="stack" style="margin-bottom:18px">${actions}</div>
    ${promptsCard()}
    ${fertileCard()}
    ${calendarCard()}
    ${basis ? `<p class="muted small center">${basis}</p>` : ''}`;
}

function promptsCard() {
  const n = state.pred.prompts.length;
  if (!n) return '';
  const text = n === 1
    ? 'One cycle in your history looks unusual, maybe a forgotten period. It\'s left out of predictions.'
    : `${n} cycles in your history look unusual, maybe forgotten periods. They're left out of predictions.`;
  return `<div class="card warn"><p>${text}</p>
    <button class="btn-link" data-action="goto" data-tab="history">Review</button></div>`;
}

function fertileCard() {
  const p = state.pred;
  if (!state.settings.showFertile || p.status === 'empty') return '';
  const f = p.forecast.find((x) => x.fertileEnd >= state.today);
  if (!f) return '';
  return `<div class="card fertile"><p style="margin:0"><b>Fertile window</b> (rough estimate): ${fmtRange(f.fertileStart, f.fertileEnd)}</p>
    <p class="small muted" style="margin:4px 0 0">Calendar estimates are not reliable for avoiding pregnancy.</p></div>`;
}

function calendarCard() {
  const p = state.pred;
  if (p.status === 'empty') return '';
  const s = state.settings;
  const st = cal.calendarState(s.calendarExport, p);
  if (st === 'ok' || (st === 'never' && s.hideCalendarPrompt)) return '';
  const title = esc(s.eventTitle);
  const body = {
    never: `<h2>Add to your calendar</h2><p class="muted">Put the forecast in your phone's calendar as a repeating ${title} event${s.reminder >= 0 ? ', with a reminder' : ''}.</p>`,
    changed: `<h2>Your forecast moved</h2><p>It changed since you added it to your calendar. Delete the old ${title} event (choose <i>all future events</i>), then add it again.</p>`,
    expired: `<h2>Calendar forecast ran out</h2><p>Add it again to keep seeing upcoming periods.</p>`,
  }[st];
  return `<div class="card ${st === 'never' ? '' : 'warn'}">${body}
    <div class="btn-row"><button class="btn-primary" data-action="cal" data-method="auto">Add to calendar</button>
    ${st === 'never' ? '<button data-action="hide-cal-prompt">Not now</button>' : ''}</div></div>`;
}

// ---------- Calendar ----------

function forecastSets() {
  const predicted = new Set(), fertile = new Set(), ovulation = new Set();
  for (const f of state.pred.forecast) {
    for (let d = toDay(f.start); d <= toDay(f.end); d++) predicted.add(fromDay(d));
    if (state.settings.showFertile) {
      for (let d = toDay(f.fertileStart); d <= toDay(f.fertileEnd); d++) fertile.add(fromDay(d));
      ovulation.add(f.ovulation);
    }
  }
  return { predicted, fertile, ovulation };
}

function viewCalendar() {
  const ym = state.month || state.today.slice(0, 7);
  const first = `${ym}-01`;
  const firstN = toDay(first);
  const offset = (new Date(firstN * 86400000).getUTCDay() + 6) % 7; // Monday = 0
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const { predicted, fertile, ovulation } = forecastSets();

  const cells = weekdayNames().map((w) => `<div class="cal-wd">${w}</div>`);
  for (let i = 0; i < offset; i++) cells.push('<span class="cal-day other"></span>');
  for (let i = 0; i < daysInMonth; i++) {
    const d = fromDay(firstN + i);
    const cls = [];
    let desc = '';
    if (state.logged.has(d)) { cls.push('logged'); desc = ', period'; }
    else if (predicted.has(d)) { cls.push('predicted'); desc = ', predicted period'; }
    else if (fertile.has(d)) { cls.push('fertile'); desc = ', fertile window estimate'; }
    if (ovulation.has(d) && !state.logged.has(d)) cls.push('ovulation');
    if (d === state.today) { cls.push('today'); desc += ', today'; }
    if (d > state.today) cls.push('future');
    cells.push(`<button class="cal-day ${cls.join(' ')}" data-action="day" data-date="${d}" aria-label="${esc(longDate(d) + desc)}">${i + 1}</button>`);
  }

  return `
    <div class="cal-head">
      <h1>${fmtMonth(ym)}</h1>
      <div class="cal-nav">
        <button data-action="month" data-delta="-1" aria-label="Previous month">‹</button>
        <button data-action="month" data-delta="0">Today</button>
        <button data-action="month" data-delta="1" aria-label="Next month">›</button>
      </div>
    </div>
    <div class="card"><div class="cal-grid">${cells.join('')}</div>
      <div class="legend">
        <span><i class="l-logged"></i>Period</span>
        <span><i class="l-predicted"></i>Predicted</span>
        ${state.settings.showFertile ? '<span><i class="l-fertile"></i>Fertile (estimate)</span>' : ''}
      </div>
    </div>
    <p class="muted small center">Tap a day to log or edit a period.</p>`;
}

function shiftMonth(delta) {
  if (delta === 0) { state.month = null; return; }
  const [y, m] = (state.month || state.today.slice(0, 7)).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  state.month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function openDaySheet(d) {
  const { predicted, fertile } = forecastSets();
  const P = periodContaining(d);
  let info = '';
  if (!P && predicted.has(d)) info = '<p class="muted">Predicted period day.</p>';
  else if (!P && fertile.has(d)) info = '<p class="muted">Fertile window (rough estimate).</p>';

  let buttons = '';
  if (d > state.today) {
    buttons = '<p class="muted">You can log days up to today.</p>';
  } else if (P) {
    info = `<p class="muted">Period logged ${fmtRange(...periodRange(P))}${P.end && !P.estimatedEnd ? '' : ' (end not logged)'}.</p>`;
    if (P.start !== d) buttons += `<button class="btn-block" data-action="set-start" data-start="${P.start}" data-date="${d}">Period started this day</button>`;
    if (P.end !== d || P.estimatedEnd) buttons += `<button class="btn-block" data-action="end" data-start="${P.start}" data-date="${d}">Period ended this day</button>`;
    buttons += `<button class="btn-danger btn-block" data-action="delete" data-start="${P.start}">Remove this period</button>`;
  } else {
    buttons += `<button class="btn-primary btn-block" data-action="start" data-date="${d}">Period started this day</button>`;
    const prev = sortPeriods(state.periods).filter((p) => p.start < d && diffDays(p.start, d) <= 14).pop();
    if (prev) buttons += `<button class="btn-block" data-action="end" data-start="${prev.start}" data-date="${d}">Period ended this day</button>`;
  }

  openSheet(`<h2>${longDate(d)}</h2>${info}<div class="stack">${buttons}
    <button class="btn-link btn-block" data-action="close">Close</button></div>`);
}

function openPickSheet(mode) {
  openSheet(`<h2>${mode === 'start' ? 'When did it start?' : 'When did it end?'}</h2>
    <form id="pick" data-mode="${mode}">
      <label class="field"><span>Date</span>${dateField('date', state.today, { required: true })}</label>
      <div class="btn-row"><button type="button" data-action="close">Cancel</button><button class="btn-primary" type="submit">Save</button></div>
    </form>`);
}

// ---------- Logging ----------

async function commit(msg) {
  state.periods = sortPeriods(state.periods);
  await savePeriods(state.periods);
  requestPersistence();
  closeSheet();
  render();
  if (msg) toast(msg);
}

async function startPeriod(d) {
  if (d > state.today) return toast('You can log days up to today.');
  if (periodContaining(d)) return toast('That day is already part of a logged period.');
  // A period that starts a few days later: the user is correcting its start
  const later = state.periods.find((p) => p.start > d && diffDays(d, p.start) <= 7);
  if (later) {
    later.start = d;
    return commit(`Start moved to ${fmt(d)}`);
  }
  const close = state.periods.find((p) => Math.abs(diffDays(p.start, d)) < MIN_CYCLE);
  if (close) return toast(`Too close to the period that started ${fmt(close.start)}. Edit that one instead.`);
  state.periods.push({ start: d, end: null });
  return commit(`Period start logged: ${fmt(d)}`);
}

async function endPeriod(d, start) {
  const P = start
    ? state.periods.find((p) => p.start === start)
    : sortPeriods(state.periods).filter((p) => p.start <= d).pop();
  if (d > state.today) return toast('You can log days up to today.');
  if (!P) return toast('No period found before this day.');
  if (d < P.start) return toast('The end can\'t be before the start.');
  if (diffDays(P.start, d) > 14) return toast('That\'s more than 14 days after the period started.');
  if (state.periods.some((p) => p.start > P.start && p.start <= d)) return toast('That would overlap the next period.');
  P.end = d;
  delete P.estimatedEnd;
  return commit(`Period end logged: ${fmt(d)}`);
}

async function setStart(oldStart, d) {
  const P = state.periods.find((p) => p.start === oldStart);
  if (!P) return;
  P.start = d;
  if (P.end && P.end < d) { P.end = null; delete P.estimatedEnd; }
  return commit(`Start moved to ${fmt(d)}`);
}

async function deletePeriod(start) {
  if (!confirm(`Remove the period that started ${fmt(start)}?`)) return;
  state.periods = state.periods.filter((p) => p.start !== start);
  return commit('Period removed');
}

// ---------- History ----------

const KIND_LABEL = {
  short: 'Not counted: under 15 days',
  missed: 'Not counted: missed log?',
  gap: 'Not counted: gap in logging',
  long: 'Not counted: very long',
};

function viewHistory() {
  const p = state.pred;
  if (p.status === 'empty') return '<h1>History</h1><div class="card"><p class="muted" style="margin:0">Nothing logged yet.</p></div>';

  const prompts = p.prompts.map((c) => {
    const q = c.kind === 'missed'
      ? `The cycle starting ${fmt(c.start)} lasted ${c.length} days, about twice your usual. Did you forget to log a period around ${fmt(c.guess)}?`
      : `No periods logged between ${fmt(c.start)} and ${fmt(c.nextStart)} (${c.length} days). Did you forget some?`;
    return `<div class="card warn"><p>${q}</p><div class="btn-row">
      <button class="btn-primary" data-action="prompt-log" data-date="${c.guess}">Log it</button>
      <button data-action="prompt-real" data-start="${c.start}">No, it was real</button></div></div>`;
  }).join('');

  const byStart = new Map(state.periods.map((x) => [x.start, x]));
  const periodText = (start) => {
    const x = byStart.get(start);
    return x?.end && !x.estimatedEnd ? ` · period ${diffDays(x.start, x.end) + 1} days` : '';
  };
  const maxLen = Math.max(35, ...p.cycles.map((c) => Math.min(c.length, 90)));
  const rows = [...p.cycles].reverse().map((c) => `
    <li><div style="flex:1">
        <div>${fmtRange(c.start, addDays(c.nextStart, -1))}</div>
        <div class="muted small">${c.length} days${periodText(c.start)}</div>
        <div class="bar" style="width:${(Math.min(c.length, 90) / maxLen) * 100}%"></div>
      </div>
      ${c.kind !== 'normal' ? `<span class="badge">${KIND_LABEL[c.kind]}</span>` : ''}</li>`).join('');

  return `
    <h1>History</h1>
    ${prompts}
    <div class="stats">
      <div class="stat"><b>${p.cycleLength} days</b><span>Typical cycle</span></div>
      <div class="stat"><b>±${plural(p.spread, 'day')}</b><span>Usual variation</span></div>
      <div class="stat"><b>${p.periodLength} days</b><span>Typical period</span></div>
      <div class="stat"><b>${p.basedOn}</b><span>Cycles used</span></div>
    </div>
    <div class="card">
      <h2>Cycles</h2>
      <ul class="list">
        <li><div><div>Current · started ${fmt(p.lastStart)}</div><div class="muted small">Day ${p.cycleDay}${periodText(p.lastStart)}</div></div></li>
        ${rows}
      </ul>
    </div>
    <p class="muted small">Predictions use the median of your last 6 cycles, blended with your typical-cycle setting while few cycles are logged. Cycles that look like logging mistakes are left out.</p>`;
}

// ---------- Settings ----------

function viewSettings() {
  const s = state.settings;
  const empty = state.pred.status === 'empty';
  const opt = (v, label, cur) => `<option value="${v}" ${Number(cur) === v ? 'selected' : ''}>${label}</option>`;
  return `
    <h1>Settings</h1>

    <div class="card">
      <h2>Calendar</h2>
      <p class="muted small">Adds one repeating event with your forecast to your phone's calendar. When the forecast changes, delete the old event (<i>all future events</i>) and add it again.</p>
      <label class="field"><span>Event title</span><input type="text" data-setting="eventTitle" value="${esc(s.eventTitle)}" maxlength="40"></label>
      <label class="field"><span>Reminder</span><select data-setting="reminder">
        ${opt(-1, 'None', s.reminder)}${opt(0, 'On the day (9:00)', s.reminder)}${opt(1, '1 day before', s.reminder)}${opt(2, '2 days before', s.reminder)}${opt(3, '3 days before', s.reminder)}
      </select></label>
      <label class="field"><span>How many periods ahead</span><select data-setting="calendarCount">
        ${opt(6, '6', s.calendarCount)}${opt(12, '12', s.calendarCount)}${opt(24, '24', s.calendarCount)}
      </select></label>
      <button class="btn-primary btn-block" data-action="cal" data-method="auto" ${empty ? 'disabled' : ''}>Add to calendar</button>
      ${empty ? '<p class="muted small">Log a period first.</p>' : ''}
      <details style="margin-top:12px">
        <summary>Other ways to add</summary>
        <p class="muted small">If the button above doesn't work on your phone, try these. Reminders and the fertile window are only included with the .ics file options.</p>
        <div class="stack">
          <button class="btn-block" data-action="cal" data-method="open-ics" ${empty ? 'disabled' : ''}>Open calendar file (iPhone)</button>
          <button class="btn-block" data-action="cal" data-method="download-ics" ${empty ? 'disabled' : ''}>Download .ics file</button>
          <button class="btn-block" data-action="cal" data-method="share-ics" ${empty ? 'disabled' : ''}>Share .ics file</button>
          <button class="btn-block" data-action="cal" data-method="android" ${empty ? 'disabled' : ''}>Android calendar app</button>
          <button class="btn-block" data-action="cal" data-method="google" ${empty ? 'disabled' : ''}>Google Calendar link</button>
        </div>
      </details>
    </div>

    <div class="card">
      <h2>Prediction</h2>
      <label class="field"><span>Typical cycle length (days)</span><input type="number" min="15" max="60" inputmode="numeric" data-setting="cycleLength" value="${s.cycleLength}"></label>
      <label class="field"><span>Typical period length (days)</span><input type="number" min="1" max="12" inputmode="numeric" data-setting="periodLength" value="${s.periodLength}"></label>
      <p class="muted small">Used while you have few cycles logged. Your own data gradually takes over.</p>
      <label class="switch"><span><b>Show fertile window</b><br><span class="muted small">Rough calendar estimate. Not reliable as contraception.</span></span>
        <input type="checkbox" data-setting="showFertile" ${s.showFertile ? 'checked' : ''}></label>
    </div>

    <div class="card">
      <h2>Your data</h2>
      <p class="muted small">Your data is stored only in this browser on this phone. Export a backup now and then, especially before changing phones or clearing browser data.</p>
      <div class="stack">
        <button class="btn-block" data-action="export">Export backup</button>
        <label class="btn btn-block center" style="display:block">Import backup<input type="file" id="import-file" accept=".json,application/json" hidden></label>
        <button class="btn-danger btn-block" data-action="delete-all">Delete all data</button>
      </div>
    </div>

    <div class="card">
      <h2>About</h2>
      <p class="small">Predictions follow the approach used by Apple's Cycle Tracking and recent research: the median of your recent cycles, a range based on how much they vary, and detection of forgotten logs
        (<a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC6710244" target="_blank" rel="noopener">Bull et al. 2019</a>,
        <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC8714275" target="_blank" rel="noopener">Li et al. 2021</a>).</p>
      <p class="small muted" style="margin:0">Estimates only. Not a medical device and not contraception. Version ${VERSION}.</p>
    </div>`;
}

const SETTING_LIMITS = { cycleLength: [15, 60, 29], periodLength: [1, 12, 5] };

async function changeSetting(el) {
  const key = el.dataset.setting;
  let value;
  if (el.type === 'checkbox') value = el.checked;
  else if (el.type === 'number' || el.tagName === 'SELECT') value = Number(el.value);
  else value = el.value.trim() || '🌸';
  if (SETTING_LIMITS[key]) {
    const [lo, hi, def] = SETTING_LIMITS[key];
    value = Number.isFinite(value) && value > 0 ? Math.min(hi, Math.max(lo, Math.round(value))) : def;
  }
  state.settings[key] = value;
  await saveSettings(state.settings);
  render();
  toast('Saved');
}

// ---------- Calendar export ----------

async function addToCalendar(method) {
  const p = state.pred;
  const s = state.settings;
  if (p.status === 'empty') return toast('Log a period first.');
  const previous = s.calendarExport;
  // Save before opening, because some methods leave the page
  s.calendarExport = { start: p.next.start, cycle: p.cycleLength, count: s.calendarCount || 12, at: state.today };
  await saveSettings(s);
  try {
    if (method === 'auto') cal.addToCalendar(p, s);
    else if (method === 'open-ics') cal.openICS(cal.buildICS(p, s));
    else if (method === 'download-ics') cal.downloadICS(cal.buildICS(p, s));
    else if (method === 'share-ics') await cal.shareICS(cal.buildICS(p, s));
    else if (method === 'android') window.location.href = cal.androidIntentUrl(p, s);
    else if (method === 'google') window.open(cal.googleCalendarUrl(p, s), '_blank', 'noopener');
  } catch (err) {
    s.calendarExport = previous;
    await saveSettings(s);
    if (err.name !== 'AbortError') toast(err.message);
    return;
  }
  setTimeout(render, 300);
}

// ---------- Backup ----------

function exportBackup() {
  const blob = new Blob([makeBackup(state.periods, state.settings)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `cycle-backup-${state.today}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function importBackup(file) {
  try {
    const data = parseBackup(await file.text());
    if (!confirm(`Replace the data on this phone with this backup (${plural(data.periods.length, 'period')})?`)) return;
    state.periods = sortPeriods(data.periods);
    state.settings = { ...data.settings, onboarded: true };
    await savePeriods(state.periods);
    await saveSettings(state.settings);
    render();
    toast('Backup imported');
  } catch (err) {
    toast(`Couldn't import: ${err.message}`);
  }
}

async function deleteAll() {
  if (!confirm('Delete all your data from this phone? This can\'t be undone. Export a backup first if you want to keep it.')) return;
  await clearAll();
  Object.assign(state, await loadAll(), { tab: 'today', month: null });
  render();
  toast('All data deleted');
}

// ---------- Events ----------

document.addEventListener('click', (e) => {
  // Desktop browsers only open the picker from the small icon; open it from anywhere in the field
  if (e.target.matches('.date-field input')) {
    try { e.target.showPicker?.(); } catch { /* already open or not allowed */ }
    return;
  }
  const tab = e.target.closest('#tabs button');
  if (tab) {
    state.tab = tab.dataset.tab;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, date, start, mode, method } = el.dataset;
  switch (action) {
    case 'start-today': return startPeriod(state.today);
    case 'end-today': return endPeriod(state.today);
    case 'pick': return openPickSheet(mode);
    case 'start': return startPeriod(date);
    case 'end': return endPeriod(date, start);
    case 'set-start': return setStart(start, date);
    case 'delete': return deletePeriod(start);
    case 'day': return openDaySheet(date);
    case 'close': return closeSheet();
    case 'month': shiftMonth(Number(el.dataset.delta)); return render();
    case 'goto': state.tab = el.dataset.tab; render(); return window.scrollTo(0, 0);
    case 'cal': return addToCalendar(method);
    case 'hide-cal-prompt': state.settings.hideCalendarPrompt = true; saveSettings(state.settings); return render();
    case 'prompt-log':
      state.tab = 'calendar';
      state.month = date.slice(0, 7);
      render();
      return openDaySheet(date);
    case 'prompt-real':
      state.settings.confirmedCycles = [...(state.settings.confirmedCycles || []), start];
      saveSettings(state.settings);
      render();
      return toast('Got it, that cycle now counts');
    case 'export': return exportBackup();
    case 'delete-all': return deleteAll();
  }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'onboard') finishOnboarding(e.target);
  if (e.target.id === 'pick') {
    const d = new FormData(e.target).get('date');
    if (!d) return;
    if (e.target.dataset.mode === 'start') startPeriod(d);
    else endPeriod(d);
  }
});

// Keep the dd/mm/yyyy text in sync with the hidden date input
document.addEventListener('input', (e) => {
  if (e.target.matches('.date-field input')) updateDateField(e.target);
});

document.addEventListener('change', (e) => {
  if (e.target.matches('.date-field input')) return updateDateField(e.target);
  if (e.target.dataset?.setting) changeSetting(e.target);
  if (e.target.id === 'import-file' && e.target.files[0]) importBackup(e.target.files[0]);
});

// Re-render when the app is reopened on a new day
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.settings && todayStr() !== state.today) render();
});

// ---------- Start ----------

async function init() {
  Object.assign(state, await loadAll());
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // App id + version in the address give the offline copy its name (see sw.js)
    const params = new URLSearchParams({ app: APP_ID, v: VERSION });
    navigator.serviceWorker.register(`sw.js?${params}`).catch(() => {});
  }
}

init();
