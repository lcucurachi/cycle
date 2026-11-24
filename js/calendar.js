// "Add to calendar" without any server.
//
//  iPhone  : an .ics calendar file is opened in Safari -> "Add to Calendar" screen.
//  Android : an "intent:" link opens the phone's calendar app on a pre-filled new event.
//            If no app accepts it, Chrome falls back to a Google Calendar link.
//  Other   : the .ics file is downloaded.
//
// Every option adds ONE repeating event (e.g. every 29 days, 12 times),
// so the user only re-adds it when the forecast changes noticeably.

import { addDays, compact, localMidnightMs, toDay } from './dates.js';

export function detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

const DESCRIPTION = 'Forecast from your tracker (estimate).';
const FERTILE_DESCRIPTION = 'Fertile window – rough estimate, not contraception.';

function rrule(pred, count) {
  return `FREQ=DAILY;INTERVAL=${pred.cycleLength};COUNT=${count}`;
}

/** The events to add: the period, plus the fertile window if enabled */
function events(pred, settings) {
  const f = pred.forecast[0];
  const list = [{
    key: 'period', title: settings.eventTitle || '🌸', description: DESCRIPTION,
    start: f.start, days: pred.periodLength,
  }];
  if (settings.showFertile) {
    list.push({
      key: 'fertile', title: settings.fertileTitle || '🌱', description: FERTILE_DESCRIPTION,
      start: f.fertileStart, days: toDay(f.fertileEnd) - toDay(f.fertileStart) + 1,
    });
  }
  return list;
}

// ---------- .ics file ----------

const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** .ics lines must be folded at 75 bytes */
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    const limit = out.length ? 74 : 75; // continuation lines start with a space
    if (enc.encode(cur + ch).length > limit) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function alarm(reminder) {
  if (reminder == null || reminder < 0) return [];
  // All-day events start at midnight; aim for 9:00 in the morning
  const trigger = reminder === 0 ? 'PT9H' : `-PT${reminder * 24 - 9}H`;
  return ['BEGIN:VALARM', `TRIGGER:${trigger}`, 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM'];
}

export function buildICS(pred, settings) {
  const count = settings.calendarCount || 12;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cycle//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const ev of events(pred, settings)) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${settings.installId}-${ev.key}@period-tracker`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(ev.start)}`,
      `DTEND;VALUE=DATE:${compact(addDays(ev.start, ev.days))}`,
      `RRULE:${rrule(pred, count)}`,
      `SUMMARY:${escapeText(ev.title)}`,
      `DESCRIPTION:${escapeText(ev.description)}`,
      'TRANSP:TRANSPARENT', // don't show as "busy"
      ...(ev.key === 'period' ? alarm(settings.reminder) : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- Links ----------

/** Google Calendar "new event" page with everything pre-filled (no sign-in setup needed) */
export function googleCalendarUrl(pred, settings) {
  const ev = events(pred, settings)[0];
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${compact(ev.start)}/${compact(addDays(ev.start, ev.days))}`,
    details: ev.description,
    recur: `RRULE:${rrule(pred, settings.calendarCount || 12)}`,
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

/** Android: opens the default calendar app's "new event" screen */
export function androidIntentUrl(pred, settings) {
  const ev = events(pred, settings)[0];
  const e = encodeURIComponent;
  return 'intent:#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.item/event;'
    + `S.title=${e(ev.title)};S.description=${e(ev.description)};B.allDay=true;`
    + `l.beginTime=${localMidnightMs(ev.start)};l.endTime=${localMidnightMs(addDays(ev.start, ev.days))};`
    + `S.rrule=${e(rrule(pred, settings.calendarCount || 12))};`
    + `S.browser_fallback_url=${e(googleCalendarUrl(pred, settings))};end`;
}

// ---------- Delivery methods ----------

/** Save the .ics file to the phone/computer */
export function downloadICS(ics) {
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'cycle-forecast.ics' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Open the .ics file directly (iPhone Safari shows "Add to Calendar") */
export function openICS(ics) {
  window.location.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
}

/** Share the .ics file through the phone's share sheet */
export async function shareICS(ics) {
  const file = new File([ics], 'cycle-forecast.ics', { type: 'text/calendar' });
  if (!navigator.canShare?.({ files: [file] })) throw new Error('Sharing files is not supported here');
  await navigator.share({ files: [file] });
}

/** True when the app runs from the home screen (no browser buttons, no "back") */
export const isStandalone = () =>
  navigator.standalone === true || globalThis.matchMedia?.('(display-mode: standalone)').matches === true;

/** The best method for this phone. Rejects with AbortError if the user cancels the share sheet. */
export async function addToCalendar(pred, settings, platform = detectPlatform()) {
  if (platform === 'ios') {
    const ics = buildICS(pred, settings);
    // From the home screen, leaving the page could strand the user (no back button): use the share sheet
    if (!isStandalone()) return openICS(ics);
    try {
      await shareICS(ics);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      downloadICS(ics);
    }
  } else if (platform === 'android') window.location.href = androidIntentUrl(pred, settings);
  else downloadICS(buildICS(pred, settings));
}

/**
 * Has the forecast moved since the user last added it to the calendar?
 * Returns 'never' | 'changed' | 'expired' | 'ok'
 */
export function calendarState(exp, pred) {
  if (!exp) return 'never';
  // While late, the forecast moves every day by design: don't ask to re-add the event
  if (pred.status === 'late') return 'ok';
  const next = toDay(pred.next.start);
  const k = Math.round((next - toDay(exp.start)) / exp.cycle);
  if (k < 0) return 'changed';
  if (k >= exp.count) return 'expired';
  const expected = toDay(exp.start) + k * exp.cycle;
  if (Math.abs(next - expected) > 2 || Math.abs(exp.cycle - pred.cycleLength) >= 2) return 'changed';
  return 'ok';
}
