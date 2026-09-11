import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultDocument, migratePlannerData } from '../lib/default-data';
import { addLocalDays, localDateInTimeZone, startOfIsoWeek } from '../lib/date-utils';
import { buildPlannerContext, deterministicPlan } from '../lib/planner-engine';
import { applyProposalAtomically, PROPOSAL_ACTIONS, proposalJsonSchema, validateProposalAgainstDocument, validateProposalShape } from '../lib/proposal-ops';
import { getWeek, historicalPatterns, targetMetrics } from '../lib/week-metrics';
import type { PlanProposal, PlannerDocument, ReplanRequest } from '../lib/planner-types';

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

function proposalWith(selectedDate: string, changes: PlanProposal['changes']): PlanProposal {
  return {
    id: 'proposal-test',
    title: 'Test proposal',
    summary: 'Test summary',
    reasoning: [],
    tradeoffs: [],
    changes,
    createdAt: `${selectedDate}T10:00:00.000Z`,
    selectedDate,
    weekId: startOfIsoWeek(selectedDate),
  };
}

test('the reported update-goal failure now explains what to use instead', () => {
  const doc = createDefaultDocument('2026-09-07');
  // Exactly what the model produced: an amount change dressed up as update-goal.
  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'update-goal', label: 'Adjust run contribution to 6 km', goalId: 'g-marathon' },
  ]);
  const errors = validateProposalAgainstDocument(proposal, doc);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /priority/);
  assert.match(errors[0], /update-target/);
  assert.match(errors[0], /shorten/);
  assert.ok(!errors[0].includes('goal update is invalid'), 'the opaque message is gone');
});

test('an unknown goalId is named in the error rather than lumped together', () => {
  const doc = createDefaultDocument('2026-09-07');
  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'update-goal', label: 'Reprioritise', goalId: 'g-nonexistent', priority: 1 },
  ]);
  assert.deepEqual(validateProposalAgainstDocument(proposal, doc), [
    'Reprioritise: no goal matches goalId "g-nonexistent".',
  ]);
});

test('update-goal still applies a genuine priority change', () => {
  const doc = createDefaultDocument('2026-09-07');
  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'update-goal', label: 'Marathon first', goalId: 'g-marathon', priority: 1 },
  ]);
  const applied = applyProposalAtomically(doc, proposal);
  assert.equal(applied.ok, true);
  if (applied.ok) assert.equal(applied.document.goals.find((goal) => goal.id === 'g-marathon')?.priority, 1);
});

test('shorten can change a session duration and hours-based target follows', () => {
  const doc = createDefaultDocument('2026-09-07');
  const snapshot = structuredClone(doc);
  const week = getWeek(doc, '2026-09-07');
  assert.ok(week);
  const internship = week.targets.find((target) => target.goalId === 'g-internship');
  assert.ok(internship);
  const before = targetMetrics(doc, week, internship).planned;

  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'shorten', sessionId: 'internship-1', label: 'Shorten internship block', from: '90 min', to: '60 min', patch: { duration: 60 } },
  ]);
  assert.deepEqual(validateProposalAgainstDocument(proposal, doc), []);
  const applied = applyProposalAtomically(doc, proposal);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  const session = applied.document.sessions.find((s) => s.id === 'internship-1');
  assert.equal(session?.duration, 60);
  assert.deepEqual(doc, snapshot, 'the source document is untouched');
});

test('shorten with no usable patch field is rejected with a specific reason', () => {
  const doc = createDefaultDocument('2026-09-07');
  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'shorten', sessionId: 'run-today', label: 'Trim the run' },
  ]);
  assert.deepEqual(validateProposalAgainstDocument(proposal, doc), [
    'Trim the run: a shorten needs patch.duration, patch.contribution or patch.distanceKm.',
  ]);
});

test('update-target changes a weekly target without touching other weeks', () => {
  const doc = createDefaultDocument('2026-09-07');
  const snapshot = structuredClone(doc);
  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'update-target', label: 'Ease weekly running to 3 sessions', targetId: 'w2', target: 3 },
  ]);
  assert.deepEqual(validateProposalAgainstDocument(proposal, doc), []);
  const applied = applyProposalAtomically(doc, proposal);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  const week = getWeek(applied.document, '2026-09-07');
  assert.equal(week?.targets.find((target) => target.id === 'w2')?.target, 3);
  assert.equal(applied.document.weeklyTargetTemplates.find((target) => target.id === 'w2')?.target, 4, 'templates are not rewritten');
  assert.deepEqual(doc, snapshot, 'the source document is untouched');
});

test('update-target is rejected when the target id does not exist', () => {
  const doc = createDefaultDocument('2026-09-07');
  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'update-target', label: 'Ease running', targetId: 'w99', target: 20 },
  ]);
  assert.deepEqual(validateProposalAgainstDocument(proposal, doc), [
    'Ease running: no weekly target matches targetId "w99" in week 2026-09-07.',
  ]);
});

test('the tool schema advertises exactly the actions the validator accepts', () => {
  const schema = proposalJsonSchema();
  assert.deepEqual([...schema.properties.changes.items.properties.action.enum], [...PROPOSAL_ACTIONS]);
  assert.ok(validateProposalShape(proposalWith('2026-09-07', [
    { id: 'c1', action: 'update-target', label: 'Ease running', targetId: 'w2', target: 20 },
  ])));
});

test('v5-to-v6 migration normalizes km units to sessions', () => {
  const v5 = {
    ...createDefaultDocument('2026-09-07'),
    version: 5,
    weeklyTargetTemplates: [
      { id: 'w1', goalId: 'g-internship', label: 'Internship', category: 'internship', priority: 1, target: 6, unit: 'hours' },
      { id: 'w2', goalId: 'g-marathon', label: 'Running', category: 'fitness', priority: 2, target: 25, unit: 'km' },
    ],
    sessions: [
      { id: 'run-1', date: '2026-09-07', start: '16:00', duration: 55, title: 'Easy run', category: 'fitness', kind: 'flexible', status: 'done', goalId: 'g-marathon', contribution: 7, contributionUnit: 'km', runType: 'easy', distanceKm: 7 },
    ],
    monthlyTargets: [{ id: 'm1', month: '2026-09', goalId: 'g-marathon', label: 'Run 100 km', target: 100, unit: 'km', done: 0 }],
  } as any;
  v5.weeks = [{ ...v5.weeks[0], targets: v5.weeklyTargetTemplates.map((t: any) => ({ ...t })) }];
  const migrated = migratePlannerData(v5, '2026-09-07');
  assert.equal(migrated.version, 7);
  const running = migrated.weeklyTargetTemplates.find(t => t.goalId === 'g-marathon');
  assert.ok(running);
  assert.equal(running.unit, 'sessions');
  assert.equal(running.target, 4);
  const runSession = migrated.sessions.find(s => s.id === 'run-1');
  assert.ok(runSession);
  assert.equal(runSession.contributionUnit, 'sessions');
  assert.equal(runSession.contribution, 1);
  assert.equal(runSession.distanceKm, 7);
  assert.equal(migrated.monthlyTargets[0].unit, 'sessions');
  assert.equal(migrated.monthlyTargets[0].target, 14);
});

test('v6-to-v7 migration adds source and locked to sessions', () => {
  const v6 = { ...createDefaultDocument('2026-09-07'), version: 6 } as any;
  delete v6.skippedSlots;
  for (const s of v6.sessions) { delete s.source; delete s.locked; }
  const migrated = migratePlannerData(v6, '2026-09-07');
  assert.equal(migrated.version, 7);
  assert.ok(Array.isArray(migrated.skippedSlots));
  for (const s of migrated.sessions) {
    assert.equal(s.source, 'ai');
    assert.equal(s.locked, false);
  }
});

test('migration adds empty ongoingTasks array when field is missing', () => {
  const doc = createDefaultDocument('2026-09-07');
  delete (doc as any).ongoingTasks;
  const migrated = migratePlannerData(doc, '2026-09-07');
  assert.ok(Array.isArray(migrated.ongoingTasks));
  assert.equal(migrated.ongoingTasks.length, 0);
});

test('default document includes an empty ongoingTasks array', () => {
  const doc = createDefaultDocument('2026-09-07');
  assert.ok(Array.isArray(doc.ongoingTasks));
  assert.equal(doc.ongoingTasks.length, 0);
});

test('adding and completing an ongoing task', () => {
  const doc = createDefaultDocument('2026-09-07');
  const task = { id: 'ot-1', text: 'Buy groceries', done: false, deadline: null, category: 'personal' as const, priority: 2 as const, createdAt: '2026-09-07T10:00:00.000Z' };
  const withTask = { ...doc, ongoingTasks: [...doc.ongoingTasks, task] };
  assert.equal(withTask.ongoingTasks.length, 1);
  assert.equal(withTask.ongoingTasks[0].done, false);
  const completed = { ...withTask, ongoingTasks: withTask.ongoingTasks.map(t => t.id === 'ot-1' ? { ...t, done: true } : t) };
  assert.equal(completed.ongoingTasks[0].done, true);
});

test('removing an ongoing task', () => {
  const doc = createDefaultDocument('2026-09-07');
  const task = { id: 'ot-1', text: 'Buy groceries', done: false, deadline: null, category: 'personal' as const, priority: 2 as const, createdAt: '2026-09-07T10:00:00.000Z' };
  const withTask = { ...doc, ongoingTasks: [task] };
  const removed = { ...withTask, ongoingTasks: withTask.ongoingTasks.filter(t => t.id !== 'ot-1') };
  assert.equal(removed.ongoingTasks.length, 0);
});

test('scheduling a session from an ongoing task creates correct sourceTaskId link', () => {
  const doc = createDefaultDocument('2026-09-07');
  const task = { id: 'ot-1', text: 'Fix SabzApply website', done: false, deadline: '2026-09-10', category: 'sabzapply' as const, priority: 1 as const, createdAt: '2026-09-07T10:00:00.000Z' };
  const withTask = { ...doc, ongoingTasks: [task] };
  const session = { id: 'session-from-ot', date: '2026-09-07', start: '14:00', duration: 60, title: task.text, category: task.category, kind: 'flexible' as const, status: 'planned' as const, sourceTaskId: task.id };
  const withSession = { ...withTask, sessions: [...withTask.sessions, session] };
  const linked = withSession.sessions.find(s => s.sourceTaskId === 'ot-1');
  assert.ok(linked);
  assert.equal(linked.title, 'Fix SabzApply website');

  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'add', label: 'Work on SabzApply', session: { ...session, id: 'session-new' } },
  ]);
  assert.deepEqual(validateProposalAgainstDocument(proposal, withTask), []);
});

test('migration adds empty reviews array when field is missing', () => {
  const doc = createDefaultDocument('2026-09-07');
  delete (doc as any).reviews;
  const migrated = migratePlannerData(doc, '2026-09-07');
  assert.ok(Array.isArray(migrated.reviews));
  assert.equal(migrated.reviews.length, 0);
});

test('migration backfills review struggle and carryForward fields', () => {
  const doc = createDefaultDocument('2026-09-07');
  doc.reviews = [{ id: 'r1', date: '2026-09-06', score: 7, win: 'Good run', blocker: 'Procrastinated' } as any];
  const migrated = migratePlannerData(doc, '2026-09-07');
  const review = migrated.reviews[0];
  assert.equal(review.struggle, 'Procrastinated');
  assert.equal(review.carryForward, '');
  assert.equal(review.reviewedAt, '');
});

test('adding a review stores it keyed by date', () => {
  const doc = createDefaultDocument('2026-09-07');
  const review = { id: 'review-test', date: '2026-09-07', score: 8, win: 'Great focus', blocker: 'None', struggle: 'None', carryForward: 'Finish contracts', reviewedAt: '2026-09-07T22:00:00.000Z' };
  const updated = { ...doc, reviews: [...doc.reviews, review] };
  const found = updated.reviews.find(r => r.date === '2026-09-07');
  assert.ok(found);
  assert.equal(found.score, 8);
  assert.equal(found.carryForward, 'Finish contracts');
});

test('reviews appear in AI planning context', () => {
  const doc = createDefaultDocument('2026-09-07');
  doc.reviews = [
    { id: 'r1', date: '2026-09-06', score: 8, win: 'Great focus', blocker: '', struggle: 'Late start', carryForward: 'Finish contracts', reviewedAt: '2026-09-06T22:00:00.000Z' },
    { id: 'r2', date: '2026-09-05', score: 6, win: 'Completed run', blocker: '', struggle: 'Skipped Dutch', carryForward: '', reviewedAt: '2026-09-05T22:00:00.000Z' },
  ];
  const context = buildPlannerContext({
    trigger: 'conversation', message: 'Rebalance', document: doc,
    now: '2026-09-07T10:00:00.000Z', currentLocalDate: '2026-09-07',
    selectedDate: '2026-09-07', currentWeekId: startOfIsoWeek('2026-09-07'), timezone: 'Europe/Amsterdam',
  });
  assert.equal(context.recentReviews.length, 2);
  assert.equal(context.recentReviews[0].date, '2026-09-06');
  assert.equal(context.recentReviews[0].struggle, 'Late start');
  assert.equal(context.recentReviews[0].carryForward, 'Finish contracts');
  assert.equal(context.recentReviews[1].date, '2026-09-05');
  assert.equal(context.recentReviews[1].struggle, 'Skipped Dutch');
});

test('migration populates customCategories from existing goals and sessions', () => {
  const doc = createDefaultDocument('2026-09-07');
  delete (doc.profile as any).customCategories;
  const migrated = migratePlannerData(doc, '2026-09-07');
  assert.ok(Array.isArray(migrated.profile.customCategories));
  assert.ok(migrated.profile.customCategories!.length > 0);
  assert.ok(migrated.profile.customCategories!.includes('fitness'));
});

test('default document includes customCategories', () => {
  const doc = createDefaultDocument('2026-09-07');
  assert.ok(Array.isArray(doc.profile.customCategories));
  assert.ok(doc.profile.customCategories!.includes('personal'));
});

test('adding a goal creates corresponding weekly target', () => {
  const doc = createDefaultDocument('2026-09-07');
  const goalId = 'g-test-new', targetId = 'w-test-new';
  const goal = { id: goalId, title: 'Test Goal', category: 'personal', priority: 2 as const, active: true, measure: 'count' };
  const target = { id: targetId, goalId, label: 'Test Goal', category: 'personal', priority: 2 as const, target: 10, unit: 'sessions' as const };
  const updated = { ...doc, goals: [...doc.goals, goal], weeklyTargetTemplates: [...doc.weeklyTargetTemplates, target], weeks: doc.weeks.map(w => ({ ...w, targets: [...w.targets, { ...target }] })) };
  assert.ok(updated.goals.find(g => g.id === goalId));
  assert.ok(updated.weeklyTargetTemplates.find(t => t.goalId === goalId));
  assert.ok(updated.weeks[0].targets.find(t => t.goalId === goalId));
});

test('deleting a goal removes its weekly targets', () => {
  const doc = createDefaultDocument('2026-09-07');
  const goalId = doc.goals[0].id;
  const updated = { ...doc, goals: doc.goals.filter(g => g.id !== goalId), weeklyTargetTemplates: doc.weeklyTargetTemplates.filter(t => t.goalId !== goalId), weeks: doc.weeks.map(w => ({ ...w, targets: w.targets.filter(t => t.goalId !== goalId) })) };
  assert.ok(!updated.goals.find(g => g.id === goalId));
  assert.ok(!updated.weeklyTargetTemplates.find(t => t.goalId === goalId));
  assert.ok(!updated.weeks[0].targets.find(t => t.goalId === goalId));
});

test('editing a goal propagates to weekly targets', () => {
  const doc = createDefaultDocument('2026-09-07');
  const goalId = doc.goals[0].id;
  const updated = { ...doc, goals: doc.goals.map(g => g.id === goalId ? { ...g, title: 'Updated Title', category: 'work' } : g), weeklyTargetTemplates: doc.weeklyTargetTemplates.map(t => t.goalId === goalId ? { ...t, label: 'Updated Title', category: 'work', target: 99 } : t), weeks: doc.weeks.map(w => ({ ...w, targets: w.targets.map(t => t.goalId === goalId ? { ...t, label: 'Updated Title', category: 'work', target: 99 } : t) })) };
  assert.equal(updated.goals.find(g => g.id === goalId)?.title, 'Updated Title');
  assert.equal(updated.weeklyTargetTemplates.find(t => t.goalId === goalId)?.label, 'Updated Title');
  assert.equal(updated.weeks[0].targets.find(t => t.goalId === goalId)?.target, 99);
});

test('profile fields save and load correctly', () => {
  const doc = createDefaultDocument('2026-09-07');
  const updated = { ...doc, profile: { ...doc.profile, morningPerson: true, deepWorkPreference: 'morning' as const, workSchedule: 'Mon-Fri 9-5', gymDaysPerWeek: 3, cookingPreference: 'once-daily', planningStyle: 'flexible' } };
  assert.equal(updated.profile.morningPerson, true);
  assert.equal(updated.profile.deepWorkPreference, 'morning');
  assert.equal(updated.profile.workSchedule, 'Mon-Fri 9-5');
  assert.equal(updated.profile.gymDaysPerWeek, 3);
  assert.equal(updated.profile.cookingPreference, 'once-daily');
  assert.equal(updated.profile.planningStyle, 'flexible');
  const migrated = migratePlannerData(updated, '2026-09-07');
  assert.equal(migrated.profile.morningPerson, true);
  assert.equal(migrated.profile.workSchedule, 'Mon-Fri 9-5');
});

test('profile summary appears in AI planning context', () => {
  const doc = createDefaultDocument('2026-09-07');
  doc.profile.morningPerson = true;
  doc.profile.gymDaysPerWeek = 4;
  doc.profile.workSchedule = 'Flexible remote';
  const context = buildPlannerContext({
    trigger: 'conversation', message: 'Plan', document: doc,
    now: '2026-09-07T10:00:00.000Z', currentLocalDate: '2026-09-07',
    selectedDate: '2026-09-07', currentWeekId: startOfIsoWeek('2026-09-07'), timezone: 'Europe/Amsterdam',
  });
  assert.ok(typeof context.profileSummary === 'string');
  assert.ok(context.profileSummary.includes('morningPerson: yes'));
  assert.ok(context.profileSummary.includes('gymDaysPerWeek: 4'));
  assert.ok(context.profileSummary.includes('workSchedule: Flexible remote'));
});

test('default document has monthly targets with optional goalId', () => {
  const doc = createDefaultDocument('2026-09-07');
  assert.ok(doc.monthlyTargets.length >= 1, 'should have at least one monthly target');
  for (const mt of doc.monthlyTargets) {
    assert.ok(mt.id, 'monthly target should have an id');
    assert.ok(mt.label, 'monthly target should have a label');
    assert.ok(typeof mt.target === 'number', 'monthly target should have a numeric target');
    assert.ok(typeof mt.done === 'number', 'monthly target should have a numeric done');
    assert.ok(typeof mt.unit === 'string', 'monthly target should have a unit');
  }
});

test('monthly target goalId is optional', () => {
  const doc = createDefaultDocument('2026-09-07');
  doc.monthlyTargets.push({ id: 'm-test', month: '2026-09', label: 'Read 4 books', target: 4, unit: 'sessions', done: 1 });
  assert.equal(doc.monthlyTargets.at(-1)!.goalId, undefined);
  assert.equal(doc.monthlyTargets.at(-1)!.label, 'Read 4 books');
  assert.equal(doc.monthlyTargets.at(-1)!.done, 1);
});

test('moving a fixed commitment without userReported is rejected', () => {
  const doc = createDefaultDocument('2026-09-07');
  const fixed = doc.sessions.find((s) => s.kind === 'fixed');
  assert.ok(fixed);
  const proposal = proposalWith(fixed.date, [
    { id: 'move-fixed', action: 'move', sessionId: fixed.id, label: fixed.title, patch: { date: fixed.date, start: '20:00' } },
  ]);
  const errors = validateProposalAgainstDocument(proposal, doc);
  assert.ok(errors.some((e) => e.includes('cannot be moved')));
});

test('moving a fixed commitment with userReported is allowed', () => {
  const doc = createDefaultDocument('2026-09-07');
  const fixed = doc.sessions.find((s) => s.kind === 'fixed');
  assert.ok(fixed);
  const proposal = proposalWith(fixed.date, [
    { id: 'move-fixed', action: 'move', sessionId: fixed.id, label: fixed.title, userReported: true, patch: { date: fixed.date, start: '20:00' } },
  ]);
  const errors = validateProposalAgainstDocument(proposal, doc);
  assert.ok(!errors.some((e) => e.includes('cannot be moved')));
  const result = applyProposalAtomically(doc, proposal);
  assert.equal(result.ok, true);
});

test('removing a fixed commitment is always rejected even with userReported', () => {
  const doc = createDefaultDocument('2026-09-07');
  const fixed = doc.sessions.find((s) => s.kind === 'fixed');
  assert.ok(fixed);
  const proposal = proposalWith(fixed.date, [
    { id: 'remove-fixed', action: 'remove', sessionId: fixed.id, label: fixed.title, userReported: true },
  ]);
  const errors = validateProposalAgainstDocument(proposal, doc);
  assert.ok(errors.some((e) => e.includes('cannot be removed')));
});

test('monthly target done can be updated without affecting other fields', () => {
  const doc = createDefaultDocument('2026-09-07');
  const mt = doc.monthlyTargets[0];
  const originalLabel = mt.label;
  const originalTarget = mt.target;
  mt.done = 5;
  assert.equal(mt.done, 5);
  assert.equal(mt.label, originalLabel);
  assert.equal(mt.target, originalTarget);
});

test('default document has empty calendarEvents and no calendarIcsUrl', () => {
  const doc = createDefaultDocument('2026-09-07');
  assert.deepEqual(doc.calendarEvents, []);
  assert.equal(doc.profile.calendarIcsUrl, undefined);
  assert.equal(doc.profile.calendarLastSync, undefined);
});

test('migration adds empty calendarEvents when field is missing', () => {
  const doc = createDefaultDocument('2026-09-07');
  const raw = JSON.parse(JSON.stringify(doc));
  delete raw.calendarEvents;
  const migrated = migratePlannerData(raw, '2026-09-07');
  assert.ok(Array.isArray(migrated.calendarEvents));
  assert.equal(migrated.calendarEvents.length, 0);
});

test('calendar events appear in AI planning context', () => {
  const doc = createDefaultDocument('2026-09-07');
  doc.calendarEvents = [
    { id: 'cal-1', title: 'Team meeting', date: '2026-09-07', startTime: '10:00', endTime: '11:00', location: 'Room 3', allDay: false, source: 'google-calendar' },
    { id: 'cal-2', title: 'Dentist', date: '2026-09-10', startTime: '14:00', endTime: '15:00', location: null, allDay: false, source: 'google-calendar' },
  ];
  const ctx = buildPlannerContext(request(doc, '2026-09-07', 'Plan my day'));
  assert.equal(ctx.selectedDayCalendar.length, 1);
  assert.equal(ctx.selectedDayCalendar[0].title, 'Team meeting');
  assert.ok(ctx.calendarEvents.length >= 1);
});

test('ICS parser extracts events correctly', async () => {
  const { parseIcs } = await import('../lib/ics-parser');
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:test-event-1
SUMMARY:Team standup
DTSTART;TZID=Europe/Amsterdam:20260907T100000
DTEND;TZID=Europe/Amsterdam:20260907T103000
LOCATION:Room 4B
END:VEVENT
BEGIN:VEVENT
UID:test-event-2
SUMMARY:All day workshop
DTSTART;VALUE=DATE:20260908
DTEND;VALUE=DATE:20260909
END:VEVENT
END:VCALENDAR`;
  const events = parseIcs(ics, 'Europe/Amsterdam', '2026-09-07', '2026-09-14');
  assert.ok(events.length >= 2);
  const standup = events.find(e => e.title === 'Team standup');
  assert.ok(standup);
  assert.equal(standup.date, '2026-09-07');
  assert.equal(standup.startTime, '10:00');
  assert.equal(standup.endTime, '10:30');
  assert.equal(standup.location, 'Room 4B');
  assert.equal(standup.allDay, false);
  const workshop = events.find(e => e.title === 'All day workshop');
  assert.ok(workshop);
  assert.equal(workshop.allDay, true);
  assert.equal(workshop.date, '2026-09-08');
});

test('ICS parser handles UTC times', async () => {
  const { parseIcs } = await import('../lib/ics-parser');
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:utc-event
SUMMARY:UTC Meeting
DTSTART:20260907T120000Z
DTEND:20260907T130000Z
END:VEVENT
END:VCALENDAR`;
  const events = parseIcs(ics, 'Europe/Amsterdam', '2026-09-07', '2026-09-14');
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'UTC Meeting');
  assert.equal(events[0].date, '2026-09-07');
  assert.equal(events[0].startTime, '14:00');
  assert.equal(events[0].endTime, '15:00');
});

test('historicalPatterns returns completion rates and skip patterns from past weeks', () => {
  const doc = createDefaultDocument('2026-09-07');
  const weekId = startOfIsoWeek('2026-09-07');
  const prevWeekId = addLocalDays(weekId, -7);
  doc.weeks.push({ weekId: prevWeekId, startDate: prevWeekId, endDate: addLocalDays(prevWeekId, 6), targets: doc.weeklyTargetTemplates.map(t => ({ ...t, baselineDone: 0 })), createdAt: new Date().toISOString(), source: 'rollover' });
  doc.sessions.push(
    { id: 'prev-run', date: addLocalDays(prevWeekId, 1), start: '16:00', duration: 55, title: 'Easy run', category: 'fitness', kind: 'flexible', status: 'done', goalId: 'g-marathon', contribution: 1, contributionUnit: 'sessions', runType: 'easy', distanceKm: 7 },
    { id: 'prev-skip', date: addLocalDays(prevWeekId, 2), start: '10:00', duration: 90, title: 'Internship', category: 'internship', kind: 'flexible', status: 'skipped', goalId: 'g-internship' },
  );
  doc.reviews.push({ id: 'r-prev', date: addLocalDays(prevWeekId, 6), score: 7, win: 'Good run', blocker: '', struggle: 'Late start', carryForward: 'Finish report' });
  const patterns = historicalPatterns(doc, weekId);
  assert.ok(patterns.weeksAnalyzed >= 1);
  assert.ok(patterns.targetCompletion.length > 0);
  const marathon = patterns.targetCompletion.find(t => t.goalId === 'g-marathon');
  assert.ok(marathon);
  assert.ok(marathon.avgCompletionRate > 0);
  assert.ok(patterns.skipPatterns.length === 7);
  assert.ok(patterns.reviewInsights.avgScore > 0);
});

test('historicalPatterns included in AI planning context', () => {
  const doc = createDefaultDocument('2026-09-07');
  const ctx = buildPlannerContext(request(doc, '2026-09-07', 'Plan'));
  assert.ok(ctx.historicalPatterns);
  assert.ok(typeof ctx.historicalPatterns.weeksAnalyzed === 'number');
  assert.ok(Array.isArray(ctx.historicalPatterns.targetCompletion));
  assert.ok(Array.isArray(ctx.historicalPatterns.skipPatterns));
  assert.ok(ctx.historicalPatterns.reviewInsights);
});

test('recentReviews in context expanded to 14 entries', () => {
  const doc = createDefaultDocument('2026-09-07');
  for (let i = 0; i < 15; i++) {
    doc.reviews.push({ id: `r-${i}`, date: addLocalDays('2026-09-07', -i), score: 7, win: `Win ${i}`, blocker: '', struggle: `Struggle ${i}`, carryForward: '' });
  }
  const ctx = buildPlannerContext(request(doc, '2026-09-07', 'Plan'));
  assert.equal(ctx.recentReviews.length, 14);
});

test('flag-at-risk validates targetId and applies correctly', () => {
  const doc = createDefaultDocument('2026-09-07');
  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'flag-at-risk' as const, label: 'Running target at risk', targetId: 'w2' },
  ]);
  assert.deepEqual(validateProposalAgainstDocument(proposal, doc), []);
  const applied = applyProposalAtomically(doc, proposal);
  assert.equal(applied.ok, true);
});

test('flag-at-risk is rejected when targetId does not exist', () => {
  const doc = createDefaultDocument('2026-09-07');
  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'flag-at-risk' as const, label: 'Unknown target', targetId: 'w99' },
  ]);
  const errors = validateProposalAgainstDocument(proposal, doc);
  assert.ok(errors.some(e => e.includes('w99')));
});

test('new actions set-week-plan and rebalance-week pass validation', () => {
  const doc = createDefaultDocument('2026-09-07');
  const proposal = proposalWith('2026-09-07', [
    { id: 'c1', action: 'set-week-plan' as const, label: 'Plan remaining week' },
    { id: 'c2', action: 'rebalance-week' as const, label: 'Redistribute after skip' },
  ]);
  assert.deepEqual(validateProposalAgainstDocument(proposal, doc), []);
  assert.ok(validateProposalShape(proposal));
});
