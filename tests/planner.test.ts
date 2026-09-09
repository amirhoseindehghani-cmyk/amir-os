import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultDocument, migratePlannerData } from '../lib/default-data';
import { addLocalDays, localDateInTimeZone, startOfIsoWeek } from '../lib/date-utils';
import { deterministicPlan } from '../lib/planner-engine';
import { applyProposalAtomically } from '../lib/proposal-ops';
import { getWeek, targetMetrics } from '../lib/week-metrics';
import type { PlannerDocument, ReplanRequest } from '../lib/planner-types';

function request(document: PlannerDocument, selectedDate: string, message: string): ReplanRequest {
  return {
    trigger: 'conversation',
    message,
    document,
    now: `${selectedDate}T10:00:00.000Z`,
    currentLocalDate: selectedDate,
    selectedDate,
    currentWeekId: startOfIsoWeek(selectedDate),
    timezone: 'Europe/Amsterdam',
  };
}

test('A: a new ISO week gets independent progress while history remains', () => {
  const sunday = createDefaultDocument('2026-09-06');
  const oldTargets = sunday.weeklyTargetTemplates.map((target) => ({ ...target, done: target.category === 'dutch' ? 4.5 : 0, planned: target.target }));
  const v4 = { ...sunday, version: 4, weeklyTargets: oldTargets } as unknown as Record<string, unknown>;
  delete v4.weeks;
  delete v4.weeklyTargetTemplates;

  const migrated = migratePlannerData(v4, '2026-09-07');
  const previous = getWeek(migrated, '2026-08-31');
  const current = getWeek(migrated, '2026-09-07');
  assert.ok(previous, 'previous week is retained');
  assert.ok(current, 'new current week is created');
  const dutch = current.targets.find((target) => target.category === 'dutch');
  assert.ok(dutch);
  assert.equal(targetMetrics(migrated, current, dutch).done, 0);
  assert.ok(migrated.sessions.some((session) => session.date === '2026-09-06'), 'historical sessions remain accessible');
});

test('Netherlands local date does not use the UTC day boundary', () => {
  const justAfterMidnightAmsterdam = new Date('2026-09-06T22:30:00.000Z');
  assert.equal(localDateInTimeZone('Europe/Amsterdam', justAfterMidnightAmsterdam), '2026-09-07');
});

test('a previously migrated global bucket is repaired when Monday starts', () => {
  const doc = createDefaultDocument('2026-09-07');
  doc.weeks = [{ ...doc.weeks[0], source: 'migration', targets: doc.weeks[0].targets.map(target => ({ ...target, baselineDone: target.category === 'dutch' ? 4.5 : 2 })) }];
  const repaired = migratePlannerData(doc, '2026-09-07');
  const current = getWeek(repaired, '2026-09-07');
  const previous = getWeek(repaired, '2026-08-31');
  assert.ok(current && previous);
  assert.ok(current.targets.every(target => (target.baselineDone ?? 0) === 0));
  assert.equal(previous.targets.find(target => target.category === 'dutch')?.baselineDone, 4.5);
});

test('B: future-day lookup selects only that exact date', () => {
  const doc = createDefaultDocument('2026-09-07');
  const thursday = addLocalDays('2026-09-07', 3);
  const session = { ...doc.sessions[0], id: 'thursday-only', date: thursday };
  const next = { ...doc, sessions: [...doc.sessions, session] };
  const selected = next.sessions.filter((item) => item.date === thursday);
  assert.deepEqual(selected.map((item) => item.id), ['thursday-only']);
});

test('C/D/E: proposals and revisions do not mutate planner state before approval', () => {
  const doc = createDefaultDocument('2026-09-07');
  const snapshot = structuredClone(doc);
  const first = deterministicPlan(request(doc, '2026-09-07', "I don't want to run today"));
  assert.equal(first.selectedDate, '2026-09-07');
  assert.ok(first.changes.some((change) => change.label.toLowerCase().includes('run')));
  assert.deepEqual(doc, snapshot, 'generating a proposal changes nothing');

  const revised = deterministicPlan({
    ...request(doc, '2026-09-07', ''),
    trigger: 'modify',
    originalProposal: first,
    modification: 'Keep the run there and move Dutch instead.',
  });
  assert.ok(!revised.changes.some((change) => change.label.toLowerCase().includes('run')));
  assert.ok(revised.changes.some((change) => change.label.toLowerCase().includes('dutch')));
  assert.deepEqual(doc, snapshot, 'revising or rejecting a proposal changes nothing');
});

test('F: apply validates first and commits a full change set atomically', () => {
  const doc = createDefaultDocument('2026-09-07');
  const snapshot = structuredClone(doc);
  const proposal = deterministicPlan(request(doc, '2026-09-07', 'Please rebalance'));
  const applied = applyProposalAtomically(doc, proposal);
  assert.equal(applied.ok, true);
  assert.deepEqual(doc, snapshot, 'source state remains untouched');
  if (applied.ok && proposal.changes[0]?.sessionId) {
    const updated = applied.document.sessions.find((session) => session.id === proposal.changes[0].sessionId);
    assert.equal(updated?.duration, proposal.changes[0].patch?.duration);
    assert.equal(applied.document.proposals[0].id, proposal.id);
  }

  const fixed = doc.sessions.find((session) => session.kind === 'fixed');
  assert.ok(fixed);
  const unsafe = { ...proposal, changes: [{ id: 'unsafe', action: 'move' as const, sessionId: fixed.id, label: fixed.title, patch: { date: fixed.date, start: '09:00' } }] };
  const rejected = applyProposalAtomically(doc, unsafe);
  assert.equal(rejected.ok, false);
  assert.deepEqual(doc, snapshot, 'an invalid proposal creates no partial mutation');
});

test('new information becomes a fixed commitment proposal, not an immediate mutation', () => {
  const doc = createDefaultDocument('2026-09-07');
  const snapshot = structuredClone(doc);
  const proposal = deterministicPlan(request(doc, '2026-09-07', 'Tomorrow I have dinner from 19:00 to 22:00.'));
  const commitment = proposal.changes.find((change) => change.action === 'add-commitment');
  assert.equal(commitment?.session?.date, '2026-09-08');
  assert.equal(commitment?.session?.kind, 'fixed');
  assert.equal(commitment?.session?.start, '19:00');
  assert.equal(commitment?.session?.duration, 180);
  assert.deepEqual(doc, snapshot);
});
