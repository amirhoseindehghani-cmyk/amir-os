import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { plannerEvents, plannerSnapshots, plannerState } from '@/db/schema';
import { DATE_RE, localDateInTimeZone } from '@/lib/date-utils';
import { createDefaultDocument, migratePlannerData } from '@/lib/default-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const USER_ID = 'amir';
const TIMEZONE = 'Europe/Amsterdam';
const SCHEMA_VERSION = 5;

function requestedLocalDate(request: Request) {
  const value = new URL(request.url).searchParams.get('localDate');
  return value && DATE_RE.test(value) ? value : localDateInTimeZone(TIMEZONE);
}

export async function GET(request: Request) {
  const localDate = requestedLocalDate(request);
  try {
    const rows = await db
      .select()
      .from(plannerState)
      .where(eq(plannerState.userId, USER_ID))
      .limit(1);

    if (rows.length && rows[0].document) {
      return Response.json({
        document: migratePlannerData(JSON.parse(rows[0].document), localDate),
        source: 'cloud',
      });
    }

    return Response.json({ document: createDefaultDocument(localDate), source: 'seed' });
  } catch (error) {
    console.error('[planner-state] load failed', {
      kind: error instanceof Error ? error.name : 'unknown',
    });
    return Response.json({ document: createDefaultDocument(localDate), source: 'seed' });
  }
}

export async function PUT(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: 'Invalid planner document' }, { status: 400 });
  }

  const candidate =
    input && typeof input === 'object' ? (input as { lastOpenedLocalDate?: unknown }) : {};
  const localDate =
    typeof candidate.lastOpenedLocalDate === 'string' && DATE_RE.test(candidate.lastOpenedLocalDate)
      ? candidate.lastOpenedLocalDate
      : localDateInTimeZone(TIMEZONE);

  const document = migratePlannerData(input, localDate);
  const now = new Date().toISOString();
  const docString = JSON.stringify(document);

  try {
    await db
      .insert(plannerState)
      .values({
        userId: USER_ID,
        schemaVersion: SCHEMA_VERSION,
        document: docString,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: plannerState.userId,
        set: { schemaVersion: SCHEMA_VERSION, document: docString, updatedAt: now },
      });

    await db.insert(plannerEvents).values({
      id: crypto.randomUUID(),
      userId: USER_ID,
      type: 'state_saved',
      payload: JSON.stringify({ version: SCHEMA_VERSION }),
      createdAt: now,
    });

    // One snapshot row per user per local day, refreshed on every save.
    await db
      .insert(plannerSnapshots)
      .values({
        id: `${USER_ID}-${localDate}`,
        userId: USER_ID,
        date: localDate,
        document: docString,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: plannerSnapshots.id,
        set: { document: docString, createdAt: now },
      });

    return Response.json({ ok: true, updatedAt: now, source: 'cloud' });
  } catch (error) {
    console.error('[planner-state] save failed', {
      kind: error instanceof Error ? error.name : 'unknown',
    });
    return Response.json({ error: 'Storage unavailable' }, { status: 503 });
  }
}
