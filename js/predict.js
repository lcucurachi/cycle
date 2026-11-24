// Cycle prediction.
//
// How it works (plain words):
//  1. A "cycle" = days from one period start to the next period start.
//  2. Cycles that are probably logging mistakes are left out:
//       - shorter than 15 days (likely a double tap / wrong date)
//       - roughly twice the usual length (likely a forgotten period, see Li et al. 2021)
//       - longer than 90 days (a gap in logging)
//  3. The typical cycle = median (middle value) of the last 6 good cycles,
//     blended with the user's "typical cycle" setting (default 29 days, Bull et al. 2019).
//     With few cycles logged the setting counts more; with many, the user's own data wins.
//  4. The forecast range (± days) comes from how much the user's cycles vary.
//  5. If the period is late, the forecast moves forward instead of staying in the past.
//  6. Fertile window (optional, rough): ovulation ≈ 13 days before the next period;
//     fertile = 5 days before ovulation to 1 day after.

import { toDay, fromDay } from './dates.js';

export const DEFAULT_CYCLE = 29;
export const DEFAULT_PERIOD = 5;
export const PRIOR_WEIGHT = 2;   // the typical-cycle setting counts like 2 logged cycles
export const RECENT = 6;         // how many recent cycles are used
export const MIN_CYCLE = 15;
export const MAX_CYCLE = 90;
export const PRIOR_SD = 4;       // assumed variation (days) before the user has data
export const LUTEAL_DAYS = 13;   // days from ovulation to next period (Apple's calendar method)
export const OPEN_PERIOD_MAX = 10; // a period with no end date counts as "ongoing" for this many days

export function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function stdev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (arr.length - 1));
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Blend the setting ("prior") with the user's own value, weighted by how much data there is */
export const blend = (prior, personal, n) => (PRIOR_WEIGHT * prior + n * personal) / (PRIOR_WEIGHT + n);

export function sortPeriods(periods) {
  return [...periods].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** Cycles between consecutive period starts */
export function buildCycles(sorted) {
  const cycles = [];
  for (let i = 1; i < sorted.length; i++) {
    cycles.push({
      start: sorted[i - 1].start,
      nextStart: sorted[i].start,
      length: toDay(sorted[i].start) - toDay(sorted[i - 1].start),
    });
  }
  return cycles;
}

/**
 * Label each cycle:
 *  normal  – used for prediction
 *  short   – under 15 days, probably a logging mistake
 *  missed  – about twice the usual length, probably a forgotten period
 *  gap     – over 90 days, probably a gap in logging
 *  long    – confirmed by the user as real but over 90 days (kept out of the average)
 */
export function classifyCycles(cycles, refLength, confirmed = []) {
  return cycles.map((c) => {
    let kind = 'normal';
    if (c.length < MIN_CYCLE) kind = 'short';
    else if (confirmed.includes(c.start)) kind = c.length > MAX_CYCLE ? 'long' : 'normal';
    else if (c.length > MAX_CYCLE) kind = 'gap';
    else if (c.length >= 1.6 * refLength && Math.abs(c.length / 2 - refLength) <= Math.max(5, 0.2 * refLength)) kind = 'missed';
    return { ...c, kind };
  });
}

/**
 * Main entry point.
 * @param periods  [{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' | null }]
 * @param settings { cycleLength, periodLength, confirmedCycles }
 * @param today    'YYYY-MM-DD'
 * @param count    how many future periods to forecast
 */
export function analyze(periods, settings = {}, today, count = 12) {
  const priorCycle = settings.cycleLength || DEFAULT_CYCLE;
  const priorPeriod = settings.periodLength || DEFAULT_PERIOD;
  const sorted = sortPeriods(periods);
  if (!sorted.length) return { status: 'empty', cycles: [], prompts: [], forecast: [] };

  const todayN = toDay(today);

  // --- Cycle length ---
  const rawCycles = buildCycles(sorted);
  const plausible = rawCycles.map((c) => c.length).filter((l) => l >= MIN_CYCLE && l <= MAX_CYCLE);
  const refLength = plausible.length >= 3 ? median(plausible) : priorCycle;
  const cycles = classifyCycles(rawCycles, refLength, settings.confirmedCycles || []);
  const used = cycles.filter((c) => c.kind === 'normal').slice(-RECENT).map((c) => c.length);
  const n = used.length;
  const cycleExact = n ? blend(priorCycle, median(used), n) : priorCycle;
  const cycleLength = Math.round(cycleExact);
  const sd = n >= 2 ? stdev(used) : null;
  const sdEff = sd === null ? PRIOR_SD : blend(PRIOR_SD, sd, n);
  const spread = clamp(Math.round(sdEff), 1, 10);

  // --- Period length (only periods with a real, user-logged end date) ---
  const pLens = sorted
    .filter((p) => p.end && !p.estimatedEnd)
    .map((p) => toDay(p.end) - toDay(p.start) + 1)
    .filter((l) => l >= 1 && l <= 15)
    .slice(-RECENT);
  const periodLength = clamp(
    Math.round(pLens.length ? blend(priorPeriod, median(pLens), pLens.length) : priorPeriod), 1, 12);

  // --- Where are we now? ---
  const last = sorted[sorted.length - 1];
  const lastStartN = toDay(last.start);
  const cycleDay = todayN - lastStartN + 1;
  const ongoing = !last.end && cycleDay >= 1 && cycleDay <= OPEN_PERIOD_MAX;
  const lastEndN = last.end ? toDay(last.end) : ongoing ? todayN : lastStartN + periodLength - 1;
  const inPeriod = todayN >= lastStartN && todayN <= lastEndN;

  let nextN = lastStartN + cycleLength;
  let lowN = nextN - spread;
  let highN = nextN + spread;
  let status = 'normal';
  let daysLate = 0;

  if (inPeriod) status = 'period';
  else if (todayN > highN) {
    // Late: move the forecast forward from today instead of keeping a date in the past
    status = 'late';
    daysLate = todayN - nextN;
    lowN = todayN + 1;
    nextN = todayN + Math.max(1, Math.round(spread / 2));
    highN = todayN + 2 * spread;
  } else if (todayN >= lowN) status = 'due';

  // --- Future periods (+ fertile window) ---
  const forecast = [];
  for (let i = 0; i < count; i++) {
    const s = nextN + i * cycleLength;
    const ov = s - LUTEAL_DAYS;
    forecast.push({
      start: fromDay(s),
      end: fromDay(s + periodLength - 1),
      ovulation: fromDay(ov),
      fertileStart: fromDay(ov - 5),
      fertileEnd: fromDay(ov + 1),
    });
  }

  const prompts = cycles
    .filter((c) => c.kind === 'missed' || c.kind === 'gap')
    .map((c) => ({ ...c, guess: fromDay(toDay(c.start) + Math.round(c.length / Math.max(2, Math.round(c.length / refLength)))) }));

  return {
    status,
    today,
    cycleDay,
    daysLate,
    ongoing,
    lastStart: last.start,
    lastEnd: fromDay(lastEndN),
    daysUntil: nextN - todayN,
    next: { start: fromDay(nextN), low: fromDay(lowN), high: fromDay(highN) },
    cycleLength,
    cycleExact,
    periodLength,
    spread,
    sd,
    basedOn: n,
    cycles,
    prompts,
    forecast,
  };
}

/**
 * Every period day to draw on the calendar for logged periods.
 * Periods without an end date are drawn up to today (if ongoing) or for the typical length.
 */
export function loggedDays(periods, periodLength, today) {
  const days = new Set();
  const todayN = toDay(today);
  for (const p of periods) {
    const s = toDay(p.start);
    let e;
    if (p.end) e = toDay(p.end);
    else if (todayN - s + 1 <= OPEN_PERIOD_MAX && todayN >= s) e = todayN;
    else e = s + periodLength - 1;
    for (let d = s; d <= e; d++) days.add(fromDay(d));
  }
  return days;
}
