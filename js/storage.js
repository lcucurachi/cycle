// Local storage.
// Data lives only on this phone, in IndexedDB (the browser's built-in database).
// If IndexedDB isn't available, it falls back to localStorage.
// All names start with APP_ID (set in index.html) so other apps on the same address don't clash.

import { DEFAULT_CYCLE, DEFAULT_PERIOD } from './predict.js';
import { APP_ID } from './config.js';

const DB_NAME = `${APP_ID}:data`;
const STORE = 'kv';
const LS_PREFIX = `${APP_ID}:`;
const BACKUP_FORMAT = 'period-tracker'; // fixed, so backups still import if APP_ID changes

export const DEFAULT_SETTINGS = {
  onboarded: false,
  cycleLength: DEFAULT_CYCLE,
  periodLength: DEFAULT_PERIOD,
  showFertile: false,
  hideCalendarPrompt: false,
  eventTitle: '🌸',
  fertileTitle: '🌱',
  reminder: 2,            // -1 = none, 0 = on the day, N = N days before (at 9:00)
  calendarCount: 12,      // how many future periods to add to the calendar
  confirmedCycles: [],    // long cycles the user confirmed as real
  calendarExport: null,   // what was last added to the calendar { start, cycle, count, at }
  installId: null,        // random id for stable calendar event ids
};

// ---------- Validation ----------
// Everything loaded from storage or a backup file goes through these,
// so a tampered value can never reach the page as HTML or the calendar file as extra lines.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);
const intIn = (v, lo, hi, def) => (Number.isInteger(v) && v >= lo && v <= hi ? v : def);
const bool = (v, def) => (typeof v === 'boolean' ? v : def);
const text = (v, def, max = 40) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : def);
const newInstallId = () => Math.random().toString(36).slice(2, 10);

/** Keeps only known settings with the right type and range; anything else becomes the default */
export function cleanSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  const exp = r.calendarExport;
  const validExport = exp && typeof exp === 'object' && isDate(exp.start)
    && intIn(exp.cycle, 1, 90, 0) && intIn(exp.count, 1, 100, 0);
  return {
    onboarded: bool(r.onboarded, d.onboarded),
    cycleLength: intIn(r.cycleLength, 15, 60, d.cycleLength),
    periodLength: intIn(r.periodLength, 1, 12, d.periodLength),
    showFertile: bool(r.showFertile, d.showFertile),
    hideCalendarPrompt: bool(r.hideCalendarPrompt, d.hideCalendarPrompt),
    eventTitle: text(r.eventTitle, d.eventTitle),
    fertileTitle: text(r.fertileTitle, d.fertileTitle),
    reminder: intIn(r.reminder, -1, 3, d.reminder),
    calendarCount: [6, 12, 24].includes(r.calendarCount) ? r.calendarCount : d.calendarCount,
    confirmedCycles: Array.isArray(r.confirmedCycles) ? r.confirmedCycles.filter(isDate) : [],
    calendarExport: validExport
      ? { start: exp.start, cycle: exp.cycle, count: exp.count, at: isDate(exp.at) ? exp.at : null }
      : null,
    installId: typeof r.installId === 'string' && /^[a-z0-9]{1,20}$/i.test(r.installId) ? r.installId : newInstallId(),
  };
}

/** Keeps only periods with valid dates (end on or after start) */
export function cleanPeriods(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && isDate(p.start) && (p.end == null || (isDate(p.end) && p.end >= p.start)))
    .map((p) => ({ start: p.start, end: p.end ?? null, ...(p.estimatedEnd === true ? { estimatedEnd: true } : {}) }));
}

// ---------- IndexedDB ----------

let dbPromise = null;

function openDB() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('no indexedDB'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function get(key) {
  try {
    return await idbGet(key);
  } catch {
    try { return JSON.parse(localStorage.getItem(LS_PREFIX + key)); } catch { return undefined; }
  }
}

async function set(key, value) {
  try {
    await idbSet(key, value);
  } catch {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  }
}

// ---------- Public API ----------

export async function loadAll() {
  const storedSettings = await get('settings');
  const periods = cleanPeriods(await get('periods'));
  const settings = cleanSettings(storedSettings);
  if (storedSettings?.installId !== settings.installId) await set('settings', settings);
  return { periods, settings };
}

export const savePeriods = (periods) => set('periods', periods);
export const saveSettings = (settings) => set('settings', settings);

export async function clearAll() {
  await set('periods', []);
  await set('settings', cleanSettings({}));
}

/** Ask the browser not to auto-delete our data (important on iPhone) */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch {
    return false;
  }
}

// ---------- Backup ----------

export function makeBackup(periods, settings) {
  return JSON.stringify({ app: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), periods, settings }, null, 2);
}

/** Validates a backup file's text; returns { periods, settings } or throws */
export function parseBackup(text) {
  const data = JSON.parse(text);
  if (data?.app !== BACKUP_FORMAT || !Array.isArray(data.periods)) throw new Error('Not a backup from this app');
  return { periods: cleanPeriods(data.periods), settings: cleanSettings(data.settings) };
}
