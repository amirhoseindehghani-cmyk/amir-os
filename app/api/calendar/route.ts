import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { plannerState } from '@/db/schema';
import { localDateInTimeZone, addLocalDays } from '@/lib/date-utils';
import { migratePlannerData } from '@/lib/default-data';
import { parseIcs } from '@/lib/ics-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const USER_ID = 'amir';
const TIMEZONE = 'Europe/Amsterdam';
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function POST() {
  try {
    const rows = await db.select().from(plannerState).where(eq(plannerState.userId, USER_ID)).limit(1);
    if (!rows.length || !rows[0].document) {
      return Response.json({ error: 'No planner data found' }, { status: 404, headers: NO_STORE });
    }

    const localDate = localDateInTimeZone(TIMEZONE);
    const doc = migratePlannerData(JSON.parse(rows[0].document), localDate);
    const icsUrl = doc.profile.calendarIcsUrl;

    if (!icsUrl) {
      return Response.json({ error: 'No calendar URL configured. Add your Google Calendar ICS URL in Profile.' }, { status: 400, headers: NO_STORE });
    }

    let icsText: string;
    try {
      const res = await fetch(icsUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      icsText = await res.text();
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : 'unknown';
      return Response.json({ error: `Could not fetch calendar (${msg}). Check your ICS URL in Profile.` }, { status: 502, headers: NO_STORE });
    }

    if (!icsText.includes('BEGIN:VCALENDAR')) {
      return Response.json({ error: 'The URL did not return valid calendar data. Make sure you copied the secret iCal URL.' }, { status: 422, headers: NO_STORE });
    }

    const rangeStart = localDate;
    const rangeEnd = addLocalDays(localDate, 14);
    const events = parseIcs(icsText, doc.profile.timezone || TIMEZONE, rangeStart, rangeEnd);
    const now = new Date().toISOString();

    const updated = { ...doc, calendarEvents: events, profile: { ...doc.profile, calendarLastSync: now } };
    const docString = JSON.stringify(updated);

    await db.insert(plannerState).values({
      userId: USER_ID,
      schemaVersion: 5,
      document: docString,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: plannerState.userId,
      set: { schemaVersion: 5, document: docString, updatedAt: now },
    });

    return Response.json({ ok: true, count: events.length, updatedAt: now }, { headers: NO_STORE });
  } catch (error) {
    console.error('[calendar-sync] failed', error instanceof Error ? error.message : error);
    return Response.json({ error: 'Calendar sync failed' }, { status: 500, headers: NO_STORE });
  }
}
