import type { CalendarEvent } from './planner-types';

function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function prop(block: string, name: string): string {
  const re = new RegExp(`^${name}[;:](.*)$`, 'im');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function propWithParams(block: string, name: string): { params: string; value: string } {
  const re = new RegExp(`^(${name}(?:;[^:]*)?):(.*)$`, 'im');
  const m = block.match(re);
  if (!m) return { params: '', value: '' };
  return { params: m[1], value: m[2].trim() };
}

function parseDt(raw: { params: string; value: string }, fallbackTz: string): { date: string; time: string; allDay: boolean } | null {
  const { params, value } = raw;
  if (!value) return null;

  const tzMatch = params.match(/TZID=([^;:]+)/i);
  const tz = tzMatch ? tzMatch[1] : null;
  const isUtc = value.endsWith('Z');
  const digits = value.replace(/[^0-9]/g, '');

  if (digits.length === 8) {
    return { date: `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`, time: '00:00', allDay: true };
  }

  if (digits.length >= 14) {
    const y = digits.slice(0, 4), mo = digits.slice(4, 6), d = digits.slice(6, 8);
    const h = digits.slice(8, 10), mi = digits.slice(10, 12);

    if (isUtc) {
      const utcDate = new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`);
      const localStr = utcDate.toLocaleString('en-CA', { timeZone: fallbackTz, hour12: false });
      const [datePart, timePart] = localStr.split(', ');
      return { date: datePart, time: timePart.slice(0, 5), allDay: false };
    }

    if (tz) {
      if (tz === fallbackTz) {
        return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}`, allDay: false };
      }
      try {
        // Find the UTC instant for this wall-clock time in the event's timezone,
        // then render that instant in the display timezone.
        const probe = new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`);
        const inTz = probe.toLocaleString('en-CA', { timeZone: tz, hour12: false });
        const [tzDate, tzTime] = inTz.split(', ');
        const tzH = parseInt(tzTime), probeH = parseInt(h);
        const offsetMs = (tzH - probeH) * 3600_000;
        const utcMs = probe.getTime() - offsetMs;
        const utcDate = new Date(utcMs);
        const localStr = utcDate.toLocaleString('en-CA', { timeZone: fallbackTz, hour12: false });
        const [datePart, timePart] = localStr.split(', ');
        return { date: datePart, time: timePart.slice(0, 5), allDay: false };
      } catch {
        return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}`, allDay: false };
      }
    }

    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}`, allDay: false };
  }

  return null;
}

function expandRrule(block: string, baseStart: ReturnType<typeof parseDt>, baseEnd: ReturnType<typeof parseDt>, rangeStart: string, rangeEnd: string): Array<{ startDate: string; startTime: string; endDate: string; endTime: string; allDay: boolean }> {
  const rruleLine = prop(block, 'RRULE');
  if (!rruleLine || !baseStart || !baseEnd) return [{ startDate: baseStart?.date ?? '', startTime: baseStart?.time ?? '', endDate: baseEnd?.date ?? '', endTime: baseEnd?.time ?? '', allDay: baseStart?.allDay ?? false }];

  const parts = Object.fromEntries(rruleLine.split(';').map(p => { const [k, v] = p.split('='); return [k, v]; }));
  const freq = parts.FREQ;
  const count = parts.COUNT ? parseInt(parts.COUNT) : undefined;
  const until = parts.UNTIL;
  const interval = parts.INTERVAL ? parseInt(parts.INTERVAL) : 1;
  const byDay = parts.BYDAY?.split(',') ?? [];

  if (!freq || !['DAILY', 'WEEKLY'].includes(freq)) {
    return [{ startDate: baseStart.date, startTime: baseStart.time, endDate: baseEnd.date, endTime: baseEnd.time, allDay: baseStart.allDay }];
  }

  const dayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const targetDays = byDay.length > 0 ? byDay.map(d => dayMap[d]).filter(d => d !== undefined) : [];

  const results: Array<{ startDate: string; startTime: string; endDate: string; endTime: string; allDay: boolean }> = [];
  const durationMs = new Date(`${baseEnd.date}T${baseEnd.time}:00`).getTime() - new Date(`${baseStart.date}T${baseStart.time}:00`).getTime();
  const cursor = new Date(`${baseStart.date}T12:00:00`);
  const limit = new Date(`${rangeEnd}T23:59:59`);
  const start = new Date(`${rangeStart}T00:00:00`);
  const untilDate = until ? new Date(until.length === 8 ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}T23:59:59Z` : until) : null;
  let generated = 0;
  const maxOccurrences = count ?? 365;

  while (cursor <= limit && generated < maxOccurrences) {
    if (untilDate && cursor > untilDate) break;

    const cursorDate = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    const cursorDow = cursor.getDay();

    let matches = true;
    if (freq === 'WEEKLY' && targetDays.length > 0) {
      matches = targetDays.includes(cursorDow);
    }

    if (matches) {
      generated++;
      if (cursor >= start) {
        const endMs = new Date(`${cursorDate}T${baseStart.time}:00`).getTime() + durationMs;
        const endDt = new Date(endMs);
        const endDate = `${endDt.getFullYear()}-${String(endDt.getMonth() + 1).padStart(2, '0')}-${String(endDt.getDate()).padStart(2, '0')}`;
        const endTime = `${String(endDt.getHours()).padStart(2, '0')}:${String(endDt.getMinutes()).padStart(2, '0')}`;
        results.push({ startDate: cursorDate, startTime: baseStart.time, endDate, endTime, allDay: baseStart.allDay });
      }
    }

    if (freq === 'DAILY') {
      cursor.setDate(cursor.getDate() + interval);
    } else if (freq === 'WEEKLY') {
      cursor.setDate(cursor.getDate() + 1);
      if (cursorDow === 6 && targetDays.length > 0) {
        cursor.setDate(cursor.getDate() + (interval - 1) * 7);
      }
    }
  }

  return results;
}

export function parseIcs(icsText: string, timezone: string, rangeStart: string, rangeEnd: string): CalendarEvent[] {
  const text = unfold(icsText);
  const blocks = text.split('BEGIN:VEVENT').slice(1).map(b => b.split('END:VEVENT')[0]);
  const events: CalendarEvent[] = [];

  for (const block of blocks) {
    const uid = prop(block, 'UID') || `ics-${events.length}`;
    const summary = prop(block, 'SUMMARY').replace(/\\,/g, ',').replace(/\\n/g, ' ').replace(/\\/g, '') || 'Untitled';
    const location = prop(block, 'LOCATION').replace(/\\,/g, ',').replace(/\\n/g, ' ').replace(/\\/g, '') || null;

    const dtStart = parseDt(propWithParams(block, 'DTSTART'), timezone);
    const dtEnd = parseDt(propWithParams(block, 'DTEND'), timezone);
    if (!dtStart) continue;

    const effectiveEnd = dtEnd ?? { date: dtStart.date, time: dtStart.allDay ? '23:59' : dtStart.time, allDay: dtStart.allDay };

    const occurrences = expandRrule(block, dtStart, effectiveEnd, rangeStart, rangeEnd);

    for (const occ of occurrences) {
      if (occ.startDate < rangeStart || occ.startDate > rangeEnd) continue;
      events.push({
        id: occurrences.length > 1 ? `${uid}-${occ.startDate}` : uid,
        title: summary,
        date: occ.startDate,
        startTime: occ.startTime,
        endTime: occ.endTime,
        location,
        allDay: occ.allDay,
        source: 'google-calendar',
      });
    }
  }

  return events;
}
