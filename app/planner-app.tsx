'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Activity, ArrowRight, ArrowUp, Brain, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock, Download, Flag, Gauge, ListTodo, MoreHorizontal, Play, Plus, RefreshCw, Settings2, Sparkles, Target, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import type { Category, OngoingTask, PlanProposal, PlannerApiResponse, PlannerDocument, Priority, ProposalChange, Session, WeekRecord, WeeklyTarget } from '@/lib/planner-types';
import { createDefaultDocument, migratePlannerData } from '@/lib/default-data';
import { addLocalDays, endOfIsoWeek, formatDateLong, formatWeekRange, localDateInTimeZone, parseLocalDate, startOfIsoWeek } from '@/lib/date-utils';
import { applyProposalAtomically } from '@/lib/proposal-ops';
import { ensureWeekForDate, getWeek, targetMetrics } from '@/lib/week-metrics';

const CACHE = 'amir-planner-v5';
const TIMEZONE = 'Europe/Amsterdam';
const mins = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const fmtMinutes = (value: number) => value >= 60 ? `${Math.floor(value / 60)}h${value % 60 ? ` ${value % 60}m` : ''}` : `${value}m`;
const cat: Record<string, { dot: string; pale: string; label: string }> = {
  internship: { dot: '#c05b46', pale: '#f9ece8', label: 'Internship' }, dutch: { dot: '#4e76b2', pale: '#eaf0f8', label: 'Dutch' },
  sabzapply: { dot: '#4b856c', pale: '#e8f2ed', label: 'SabzApply' }, fitness: { dot: '#d47a3d', pale: '#f9eee5', label: 'Fitness' },
  learning: { dot: '#8467a7', pale: '#f1ecf7', label: 'Learning' }, routine: { dot: '#8b8b82', pale: '#f0f0ed', label: 'Routine' },
  cooking: { dot: '#b48542', pale: '#f7f0e5', label: 'Cooking' }, free: { dot: '#718079', pale: '#edf0ee', label: 'Recovery' },
  personal: { dot: '#77716c', pale: '#f0eeec', label: 'Personal' }, work: { dot: '#b64e57', pale: '#f8e9eb', label: 'Work' },
};
type AiStatus = 'idle' | 'planning' | 'updating' | 'applying';
type RetryRequest = { trigger: 'morning' | 'conversation' | 'manual' | 'modify'; message?: string; originalProposal?: PlanProposal; modification?: string };

function endTime(start: string, duration: number) { const total = mins(start) + duration; return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; }
function statusFor(metrics: ReturnType<typeof targetMetrics>) { if (metrics.done >= metrics.target) return ['Achieved', 'good'] as const; if (metrics.coverage >= metrics.target) return ['On track', 'good'] as const; if (metrics.coverage >= metrics.target * .6) return ['At risk', 'warn'] as const; return ['Needs reallocation', 'bad'] as const; }
function relativeDayLabel(date: string, today: string) { if (date === today) return 'Today'; if (date === addLocalDays(today, 1)) return 'Tomorrow'; if (date === addLocalDays(today, -1)) return 'Yesterday'; return parseLocalDate(date).toLocaleDateString('en-GB', { weekday: 'long' }); }

export function PlannerApp() {
  const localToday = useMemo(() => localDateInTimeZone(TIMEZONE), []);
  const currentWeekId = startOfIsoWeek(localToday);
  const initialDoc = useMemo(() => createDefaultDocument(localToday), [localToday]);
  const [doc, setDoc] = useState<PlannerDocument>(initialDoc);
  const [loaded, setLoaded] = useState(false), [sync, setSync] = useState<'saved' | 'saving' | 'offline'>('saving');
  // cloudReady gates every write: a device that could not read the cloud must never
  // push its (possibly default) document over the stored one.
  const [cloudReady, setCloudReady] = useState(false), [syncError, setSyncError] = useState(''), [signedOut, setSignedOut] = useState(false), [offlineEdits, setOfflineEdits] = useState(false);
  const baselineDoc = useRef<PlannerDocument | null>(null), offlineEditsRef = useRef(false);
  const markOfflineEdits = (value: boolean) => { offlineEditsRef.current = value; setOfflineEdits(value); };
  const [view, setView] = useState<'day' | 'week' | 'goals' | 'tasks' | 'month' | 'settings'>('day');
  const [selectedDate, setSelectedDate] = useState(localToday), [weekCursor, setWeekCursor] = useState(currentWeekId);
  const [morning, setMorning] = useState(false), [proposal, setProposal] = useState<PlanProposal | null>(null);
  const [proposalProvider, setProposalProvider] = useState(''), [modifyMode, setModifyMode] = useState(false), [modifyText, setModifyText] = useState('');
  const [wake, setWake] = useState(new Date().toTimeString().slice(0, 5)), [energy, setEnergy] = useState<'low' | 'normal' | 'high'>('normal'), [unusual, setUnusual] = useState('');
  const [message, setMessage] = useState(''), [aiStatus, setAiStatus] = useState<AiStatus>('idle'), [aiError, setAiError] = useState('');
  const [retryRequest, setRetryRequest] = useState<RetryRequest | null>(null), [reasoning, setReasoning] = useState(false), [addOpen, setAddOpen] = useState(false);
  const [newTitle, setNewTitle] = useState(''), [newTime, setNewTime] = useState('14:00'), [newFixed, setNewFixed] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const loadFromCloud = useCallback(async () => {
    setSync('saving'); setSyncError('');
    try {
      const response = await fetch(`/api/state?localDate=${localToday}`, { cache: 'no-store', credentials: 'same-origin' });
      if (response.status === 401) { setSignedOut(true); setCloudReady(false); setSync('offline'); return false; }
      if (!response.ok) throw new Error(response.status === 503 ? 'Cloud storage is unavailable right now, so this device is not syncing.' : `The planner could not be loaded from the cloud (HTTP ${response.status}).`);
      const payload = await response.json() as { document: unknown };
      setSignedOut(false); setCloudReady(true);
      // Edits made while offline are the newest intent, so keep them and let autosave push them up.
      if (!offlineEditsRef.current) { const next = migratePlannerData(payload.document, localToday); baselineDoc.current = next; setDoc(next); setSync('saved'); }
      return true;
    } catch (error) {
      setSync('offline');
      setSyncError(error instanceof Error && error.message ? error.message : 'The planner could not reach cloud storage.');
      return false;
    }
  }, [localToday]);

  useEffect(() => { (async () => {
    const ok = await loadFromCloud();
    if (!ok) {
      const raw = localStorage.getItem(CACHE) || localStorage.getItem('amir-planner-v4') || localStorage.getItem('planner-data');
      let restored: PlannerDocument | null = null;
      if (raw) { try { restored = migratePlannerData(JSON.parse(raw), localToday); } catch { /* a corrupt cache must not block startup */ } }
      if (restored) setDoc(restored);
      // Record what we actually started from, so a later edit is recognisable as an
      // offline edit and a successful retry does not silently discard it.
      baselineDoc.current = restored ?? initialDoc;
    }
    setLoaded(true);
  })(); }, [localToday, loadFromCloud, initialDoc]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(CACHE, JSON.stringify(doc));
    const edited = baselineDoc.current !== null && doc !== baselineDoc.current;
    const timer = setTimeout(async () => {
      if (!cloudReady) { if (edited) markOfflineEdits(true); return; }
      setSync('saving');
      try {
        const response = await fetch('/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(doc) });
        if (response.status === 401) { setSignedOut(true); setCloudReady(false); markOfflineEdits(true); setSync('offline'); return; }
        if (!response.ok) throw new Error(response.status === 503 ? 'Cloud storage is unavailable, so this change is only on this device.' : `This change could not be saved to the cloud (HTTP ${response.status}).`);
        baselineDoc.current = doc; markOfflineEdits(false); setSyncError(''); setSync('saved');
      } catch (error) {
        markOfflineEdits(true); setSync('offline');
        setSyncError(error instanceof Error && error.message ? error.message : 'This change is saved on this device only.');
      }
    }, 650);
    return () => clearTimeout(timer);
  }, [doc, loaded, cloudReady]);

  const syncState = sync === 'saving' ? 'saving' : cloudReady ? sync : 'offline';
  const openDate = (date: string) => { setDoc(current => ensureWeekForDate(current, date)); setSelectedDate(date); setWeekCursor(startOfIsoWeek(date)); setView('day'); };
  const openWeek = (weekId: string) => { const targetWeek = startOfIsoWeek(weekId); setDoc(current => ensureWeekForDate(current, targetWeek)); setWeekCursor(targetWeek); if (startOfIsoWeek(selectedDate) !== targetWeek) setSelectedDate(targetWeek); setView('week'); };
  const selectedSessions = useMemo(() => doc.sessions.filter(session => session.date === selectedDate && session.status !== 'skipped').sort((a, b) => mins(a.start) - mins(b.start)), [doc.sessions, selectedDate]);
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const activeIndex = selectedDate === localToday ? selectedSessions.findIndex(session => mins(session.start) + session.duration > nowMinutes) : selectedSessions.findIndex(session => session.status === 'planned');
  const firstIndex = activeIndex < 0 ? Math.max(0, selectedSessions.length - 1) : activeIndex, active = selectedSessions[firstIndex], next = selectedSessions[firstIndex + 1];
  const focusMinutes = selectedSessions.filter(session => session.kind === 'flexible').reduce((total, session) => total + session.duration, 0);
  const fixedMinutes = selectedSessions.filter(session => session.kind === 'fixed' || session.kind === 'routine').reduce((total, session) => total + session.duration, 0);

  async function requestPlan(args: RetryRequest) {
    const planningDocument = ensureWeekForDate(doc, selectedDate);
    setDoc(planningDocument); setAiStatus(args.trigger === 'modify' ? 'updating' : 'planning'); setAiError(''); setRetryRequest(args);
    try {
      const response = await fetch('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ trigger: args.trigger, message: args.message, modification: args.modification, originalProposal: args.originalProposal, checkIn: args.trigger === 'morning' ? { wakeTime: wake, energy, unusual } : undefined, document: planningDocument, now: new Date().toISOString(), currentLocalDate: localToday, selectedDate, currentWeekId, timezone: TIMEZONE }) });
      let payload: PlannerApiResponse; try { payload = await response.json() as PlannerApiResponse; } catch { throw new Error('The planning service returned an unreadable response. Your existing plan has not been changed.'); }
      if (!payload.ok && payload.error.code === 'UNAUTHENTICATED') { setSignedOut(true); setCloudReady(false); }
      if (!response.ok || !payload.ok) throw new Error(payload.ok ? 'AI planning failed. Your existing plan has not been changed.' : payload.error.message);
      setProposal(payload.proposal); setProposalProvider(payload.meta.provider === 'anthropic' ? 'Claude' : 'Local development planner'); setModifyMode(false); setModifyText(''); setMessage(''); if (args.trigger === 'morning') setMorning(false);
    } catch (error) { const detail = error instanceof Error ? error.message : ''; setAiError(!detail || detail === 'Failed to fetch' ? 'AI planning failed. Your existing plan has not been changed.' : detail); } finally { setAiStatus('idle'); }
  }
  function applyProposal() { if (!proposal) return; setAiStatus('applying'); const result = applyProposalAtomically(doc, proposal); if (!result.ok) { setAiError(`The proposal was not applied: ${result.errors.join(' ')}`); setAiStatus('idle'); return; } setDoc(result.document); setProposal(null); setModifyMode(false); setAiStatus('idle'); }
  function rejectProposal() { setProposal(null); setModifyMode(false); setModifyText(''); }
  const toggleSession = (session: Session) => setDoc(current => ({ ...current, sessions: current.sessions.map(item => item.id === session.id ? { ...item, status: session.status === 'done' ? 'planned' : 'done' } : item), history: [{ id: `history-${crypto.randomUUID()}`, at: new Date().toISOString(), type: session.status === 'done' ? 'session_reopened' : 'session_completed', note: session.title, weekId: startOfIsoWeek(session.date) }, ...current.history] }));
  function addSession() { if (!newTitle.trim()) return; setDoc(current => ({ ...current, sessions: [...current.sessions, { id: `session-${crypto.randomUUID()}`, date: selectedDate, start: newTime, duration: 60, title: newTitle.trim(), category: 'personal', kind: newFixed ? 'fixed' : 'flexible', status: 'planned' }] })); setNewTitle(''); setAddOpen(false); }
  function setMemory(id: string, status: 'approved' | 'rejected') { setDoc(current => { const memory = current.memories.find(item => item.id === id); return { ...current, memories: current.memories.map(item => item.id === id ? { ...item, status } : item), profile: status === 'approved' && memory ? { ...current.profile, preferences: [...current.profile.preferences, memory.text] } : current.profile }; }); }
  function exportData() { const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `amir-planner-${localToday}.json`; anchor.click(); URL.revokeObjectURL(anchor.href); }
  async function importData(file?: File) { if (file) setDoc(migratePlannerData(JSON.parse(await file.text()), localToday)); }

  useEffect(() => { const context = (document as Document & { modelContext?: { registerTool: (tool: unknown, options?: unknown) => unknown } }).modelContext; if (!context?.registerTool) return; const controller = new AbortController(); Promise.resolve(context.registerTool({ name: 'request_plan_update', title: 'Request plan update', description: 'Stage a proposal for the date Amir is currently viewing. Nothing changes before approval.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: async (input: unknown) => { const toolMessage = (input as { message?: unknown }).message; if (typeof toolMessage !== 'string' || !toolMessage.trim()) throw new Error('message is required'); setMessage(toolMessage); return { status: 'staged', selectedDate, message: toolMessage }; } }, { signal: controller.signal })).catch(() => {}); return () => controller.abort(); }, [selectedDate]);
  if (!loaded) return <div className="min-h-screen grid place-items-center text-stone-500">Preparing your current week…</div>;

  return <div className="min-h-screen bg-background text-foreground">
    <header className="topbar"><div className="brand"><div className="brandmark">A</div><span>Amir</span><span className="brand-muted">OS</span></div><nav className="desktop-nav" aria-label="Primary">{([['day', 'Day'], ['week', 'Week'], ['goals', 'Goals'], ['tasks', 'Tasks'], ['month', 'Month'], ['settings', 'Profile']] as const).map(([id, label]) => <button key={id} onClick={() => setView(id)} className={view === id ? 'active' : ''}>{label}</button>)}</nav><div className="sync"><span className={`sync-dot ${syncState}`} />{syncState === 'saved' ? 'Cloud saved' : syncState === 'saving' ? 'Saving…' : offlineEdits ? 'Not saved to cloud' : 'Local cache'}<button className="icon-btn" aria-label="More"><MoreHorizontal size={19} /></button></div></header>
    <main className="shell"><div className="mobile-nav"><button onClick={() => setView('day')}>Day</button><button onClick={() => setView('week')}><Gauge />Week</button><button onClick={() => setView('goals')}><Target />Goals</button><button onClick={() => setView('tasks')}><ListTodo />Tasks</button><button onClick={() => setView('settings')}><Settings2 />Profile</button></div>
      {(signedOut || syncError) && <div className="ai-error" role="alert"><CircleAlert /><div><b>{signedOut ? 'Signed out — changes are not reaching the cloud' : 'Not saving to the cloud'}</b><span>{signedOut ? 'This device’s session expired. Your plan is safe here; sign in again to resume cloud sync.' : `${syncError}${offlineEdits ? ' Your latest changes are held on this device and will be pushed once syncing resumes.' : ''}`}</span></div>{signedOut ? <a className="sync-signin" href={`/login?next=${encodeURIComponent('/')}`}>Sign in</a> : <button onClick={() => loadFromCloud()}>Retry</button>}<button aria-label="Dismiss sync message" onClick={() => { setSyncError(''); setSignedOut(false); }}><X /></button></div>}
      {aiError && <div className="ai-error" role="alert"><CircleAlert /><div><b>AI planning failed</b><span>{aiError}</span></div>{retryRequest && <button onClick={() => requestPlan(retryRequest)}>Retry</button>}<button aria-label="Dismiss error" onClick={() => setAiError('')}><X /></button></div>}
      {view === 'day' && <DayView doc={doc} setDoc={setDoc} localToday={localToday} selectedDate={selectedDate} sessions={selectedSessions} active={active} next={next} focusMinutes={focusMinutes} fixedMinutes={fixedMinutes} onDate={openDate} onMorning={() => setMorning(true)} onReplan={() => requestPlan({ trigger: 'manual' })} onToggle={toggleSession} onAdd={() => setAddOpen(true)} onReasoning={() => setReasoning(!reasoning)} reasoning={reasoning} onOpenWeek={() => openWeek(startOfIsoWeek(selectedDate))} />}
      {view === 'week' && <WeekView doc={doc} setDoc={setDoc} weekId={weekCursor} currentWeekId={currentWeekId} onWeek={openWeek} onDate={openDate} onReplan={() => requestPlan({ trigger: 'manual' })} />}
      {view === 'goals' && <GoalsView doc={doc} setDoc={setDoc} />}{view === 'tasks' && <TasksView doc={doc} setDoc={setDoc} selectedDate={selectedDate} localToday={localToday} />}{view === 'month' && <MonthView doc={doc} selectedDate={selectedDate} localToday={localToday} onDate={openDate} />}{view === 'settings' && <ProfileView doc={doc} setDoc={setDoc} onMemory={setMemory} onExport={exportData} onImport={() => importRef.current?.click()} />}
    </main>
    <div className="command-dock"><div className="command-inner"><Sparkles size={18} /><input aria-label="Tell the planner what changed" value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && message.trim()) requestPlan({ trigger: 'conversation', message }); }} placeholder={`Tell me what changed for ${relativeDayLabel(selectedDate, localToday).toLowerCase()}…`} /><button aria-label="Send to planner" onClick={() => message.trim() && requestPlan({ trigger: 'conversation', message })} disabled={!message.trim() || aiStatus !== 'idle'}>{aiStatus === 'planning' ? <RefreshCw className="spin" /> : <ArrowRight />}</button></div><span>AI context date: {formatDateLong(selectedDate)}</span></div>
    {aiStatus !== 'idle' && <div className="ai-status" role="status"><RefreshCw className="spin" />{aiStatus === 'planning' ? 'Planning your day…' : aiStatus === 'updating' ? 'Updating proposal…' : 'Applying changes…'}</div>}
    <Dialog open={morning} onOpenChange={setMorning}><DialogContent className="checkin-dialog"><DialogHeader className="checkin-header"><DialogTitle className="checkin-title">Good morning</DialogTitle><DialogDescription className="checkin-date">{formatDateLong(selectedDate)}</DialogDescription></DialogHeader><div className="checkin-fields"><label className="checkin-field"><span className="checkin-label">What time did you wake up?</span><Input type="time" value={wake} onChange={event => setWake(event.target.value)} className="checkin-input" /></label><div className="checkin-field"><span className="checkin-label">How's your energy?</span><div className="checkin-energy">{(['low', 'normal', 'high'] as const).map(level => <button className={`checkin-energy-btn ${energy === level ? 'selected' : ''}`} key={level} onClick={() => setEnergy(level)}>{level[0].toUpperCase() + level.slice(1)}</button>)}</div></div><label className="checkin-field"><span className="checkin-label">Anything unusual today?</span><Textarea value={unusual} onChange={event => setUnusual(event.target.value)} placeholder="Appointments, travel, poor sleep, changes to your day..." className="checkin-textarea" rows={3} /></label></div><DialogFooter className="checkin-footer"><Button className="checkin-submit" onClick={() => requestPlan({ trigger: 'morning' })} disabled={aiStatus !== 'idle'}>{aiStatus === 'planning' ? 'Planning your day...' : 'Plan my day'}</Button></DialogFooter></DialogContent></Dialog>
    {proposal && <div className="proposal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) rejectProposal(); }}><section className="proposal-sheet" role="dialog" aria-modal="true" aria-labelledby="proposal-title"><div className="proposal-scroll"><div className="proposal-kicker"><Sparkles /> AI plan update <span>{proposalProvider}</span><button aria-label="Close proposal" onClick={rejectProposal}><X /></button></div><h2 id="proposal-title">{proposal.title}</h2><p className="proposal-summary">{proposal.summary}</p><div className="proposal-date"><CalendarDays />Planning {formatDateLong(proposal.selectedDate)} · week {formatWeekRange(proposal.weekId)}</div><div className="changes-heading"><b>AI suggests {proposal.changes.length} {proposal.changes.length === 1 ? 'change' : 'changes'}</b><span>Nothing has changed yet</span></div><div className="proposal-changes">{proposal.changes.length ? proposal.changes.map(change => <Diff key={change.id} change={change} />) : <div className="no-change"><Check />Your current plan is already the best realistic allocation.</div>}</div><details className="proposal-reasoning"><summary>Why this plan <ChevronRight /></summary><ul>{proposal.reasoning.map((item, index) => <li key={index}>{item}</li>)}</ul>{proposal.tradeoffs.length > 0 && <><h4>Tradeoffs</h4><ul>{proposal.tradeoffs.map((item, index) => <li key={index}>{item}</li>)}</ul></>}</details>{modifyMode && <div className="modify-panel"><label htmlFor="modify-proposal">What should change?</label><Textarea id="modify-proposal" autoFocus value={modifyText} onChange={event => setModifyText(event.target.value)} placeholder="Keep the run on Tuesday but move Dutch instead." /><div><button onClick={() => { setModifyMode(false); setModifyText(''); }}>Cancel</button><Button onClick={() => requestPlan({ trigger: 'modify', originalProposal: proposal, modification: modifyText })} disabled={!modifyText.trim() || aiStatus !== 'idle'}>{aiStatus === 'updating' ? 'Updating proposal…' : 'Update proposal'}</Button></div></div>}</div><footer className="proposal-actions"><button className="reject-action" onClick={rejectProposal}>Reject</button><button className="modify-action" onClick={() => setModifyMode(true)}>Modify</button><Button onClick={applyProposal} disabled={!proposal.changes.length || aiStatus !== 'idle'}>Apply changes</Button></footer></section></div>}
    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent><DialogHeader><DialogTitle>Add to {relativeDayLabel(selectedDate, localToday).toLowerCase()}</DialogTitle><DialogDescription>Create a fixed commitment or a flexible session on {formatDateLong(selectedDate)}.</DialogDescription></DialogHeader><label className="field">What<Input value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="Appointment or work session" /></label><label className="field">Starts<Input type="time" value={newTime} onChange={event => setNewTime(event.target.value)} /></label><button className={`fixed-toggle ${newFixed ? 'on' : ''}`} onClick={() => setNewFixed(!newFixed)}><Flag /> {newFixed ? 'Fixed commitment' : 'Flexible session'}</button><DialogFooter><Button onClick={addSession}>Add to plan</Button></DialogFooter></DialogContent></Dialog>
    <input ref={importRef} type="file" hidden accept="application/json" onChange={event => importData(event.target.files?.[0])} />
  </div>;
}

function DateNavigator({ selectedDate, localToday, onDate }: { selectedDate: string; localToday: string; onDate: (date: string) => void }) { return <div className="date-navigator" aria-label="Date navigation"><button aria-label="Previous day" onClick={() => onDate(addLocalDays(selectedDate, -1))}><ChevronLeft /></button><button className={selectedDate === localToday ? 'selected' : ''} onClick={() => onDate(localToday)}>Today</button><button className={selectedDate === addLocalDays(localToday, 1) ? 'selected' : ''} onClick={() => onDate(addLocalDays(localToday, 1))}>Tomorrow</button><label><CalendarDays /><Input aria-label="Select a date" type="date" value={selectedDate} onChange={event => event.target.value && onDate(event.target.value)} /></label><button aria-label="Next day" onClick={() => onDate(addLocalDays(selectedDate, 1))}><ChevronRight /></button></div>; }

function DayView({ doc, setDoc, localToday, selectedDate, sessions, active, next, focusMinutes, fixedMinutes, onDate, onMorning, onReplan, onToggle, onAdd, onReasoning, reasoning, onOpenWeek }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; localToday: string; selectedDate: string; sessions: Session[]; active?: Session; next?: Session; focusMinutes: number; fixedMinutes: number; onDate: (date: string) => void; onMorning: () => void; onReplan: () => void; onToggle: (session: Session) => void; onAdd: () => void; onReasoning: () => void; reasoning: boolean; onOpenWeek: () => void }) {
  const week = getWeek(doc, startOfIsoWeek(selectedDate)), label = relativeDayLabel(selectedDate, localToday);
  return <div><DateNavigator selectedDate={selectedDate} localToday={localToday} onDate={onDate} /><div className="day-layout"><section className="day-main">
    <div className="day-heading"><div><div className="eyebrow">{label} · {startOfIsoWeek(selectedDate) === startOfIsoWeek(localToday) ? 'Current week' : formatWeekRange(startOfIsoWeek(selectedDate))}</div><h1>{formatDateLong(selectedDate).replace(/^[A-Za-z]+,?\s*/, '')}</h1><p>{Math.round(focusMinutes / 6) / 10}h focused · {Math.round(fixedMinutes / 6) / 10}h routines & fixed · selected plan is current</p></div><div className="day-actions">{selectedDate === localToday && <Button variant="outline" onClick={onMorning}><Activity /> Check in</Button>}<Button onClick={onReplan}><RefreshCw /> Replan</Button></div></div>
    <div className="now-grid"><div className="now-card"><span>{selectedDate === localToday ? 'Now' : 'First planned'}</span>{active ? <><h2>{active.title}</h2><p>{active.start}–{endTime(active.start, active.duration)} · {cat[active.category]?.label}</p><div className="now-actions"><button onClick={() => onToggle(active)}><Check />Mark {active.status === 'done' ? 'planned' : 'done'}</button><button onClick={() => document.getElementById(`session-${active.id}`)?.scrollIntoView({ behavior: 'smooth' })}>Open</button></div></> : <h2>No sessions planned</h2>}</div><div className="next-card"><span>{selectedDate === localToday ? 'Next' : 'After that'}</span>{next ? <><h3>{next.title}</h3><p>{next.start} · {fmtMinutes(next.duration)}</p></> : <><h3>Open capacity</h3><p>No later planned work</p></>}<div className="capacity"><div><span>Daily capacity</span><b>{Math.round(focusMinutes / 6) / 10} / {doc.profile.dailyFocusCapacityHours}h</b></div><Progress value={Math.min(100, focusMinutes / 60 / doc.profile.dailyFocusCapacityHours * 100)} /></div></div></div>
    <DeadlineAlerts tasks={doc.ongoingTasks} localToday={localToday} />
    <div className="priority-strip"><div className="section-label"><Flag /> Priorities</div>{doc.top3.map((priority, index) => <div key={priority}><b>{index + 1}</b><span>{priority}</span></div>)}</div>
    <div className="plan-head"><div><div className="section-label">{label}’s plan</div><p>This exact date is shared across Day, Week, Month, and AI planning.</p></div><button onClick={onAdd}><Plus /> Add</button></div><div className="timeline">{sessions.length ? sessions.map((session, index) => <SessionRow key={session.id} session={session} last={index === sessions.length - 1} onToggle={() => onToggle(session)} />) : <div className="empty-day"><CalendarDays /><b>No plan for this date yet.</b><span>Add a session or ask AI to plan it.</span></div>}</div>
    <OngoingSection doc={doc} setDoc={setDoc} selectedDate={selectedDate} localToday={localToday} compact />
  </section><aside className="insights"><div className="ai-card"><div className="ai-title"><Brain />Chief of staff</div><p>The planner will optimize from {formatDateLong(selectedDate)}, with fixed commitments and recovery protected.</p><button onClick={onReasoning}>{reasoning ? 'Hide reasoning' : 'View planning context'} <ArrowRight /></button>{reasoning && <ul><li>Selected date: {selectedDate}</li><li>Planning week: {startOfIsoWeek(selectedDate)}</li><li>Fixed commitments cannot be moved by AI.</li></ul>}</div>{week && <div className="week-mini"><div className="section-label">Week · {formatWeekRange(week.weekId)}</div>{week.targets.slice(0, 4).map(target => <MiniTarget key={target.id} doc={doc} week={week} target={target} />)}<button className="text-button" onClick={onOpenWeek}>Open this week <ArrowRight /></button></div>}</aside></div></div>;
}

function SessionRow({ session, last, onToggle }: { session: Session; last: boolean; onToggle: () => void }) { return <div id={`session-${session.id}`} className={`session ${session.status === 'done' ? 'done' : ''}`}><div className="time"><b>{session.start}</b><span>{endTime(session.start, session.duration)}</span></div><div className="rail"><button onClick={onToggle} aria-label={`Mark ${session.title} ${session.status === 'done' ? 'planned' : 'done'}`}>{session.status === 'done' ? <Check /> : <span style={{ borderColor: cat[session.category]?.dot }} />}</button>{!last && <i />}</div><div className="session-body"><div><h3>{session.title}</h3><p><span className="tag" style={{ background: cat[session.category]?.pale, color: cat[session.category]?.dot }}>{cat[session.category]?.label}</span><span>{fmtMinutes(session.duration)}</span>{session.kind === 'fixed' && <span className="fixed"><Flag /> Fixed</span>}{session.sourceTaskId && <span>Linked task</span>}</p></div><button aria-label="Session menu"><MoreHorizontal /></button></div></div>; }
function MiniTarget({ doc, week, target }: { doc: PlannerDocument; week: WeekRecord; target: WeeklyTarget }) { const metrics = targetMetrics(doc, week, target), state = statusFor(metrics); return <div className="mini-target"><div><span className="cat-dot" style={{ background: cat[target.category]?.dot }} /><b>{target.label}</b><em className={state[1]}>{state[0]}</em></div><p>{metrics.done} done · {metrics.planned} planned · {metrics.remaining} remaining · {metrics.target} target</p><Progress value={Math.min(100, metrics.done / Math.max(1, metrics.target) * 100)} /></div>; }
function Diff({ change }: { change: ProposalChange }) { const names: Record<ProposalChange['action'], string> = { add: 'Add', remove: 'Remove', move: 'Move', shorten: 'Resize', 'update-goal': 'Priority', 'update-target': 'Weekly target', 'add-commitment': 'Fixed commitment' }; return <article className={`proposal-change ${change.action}`}><div className="change-type">{names[change.action]}</div><div><h3>{change.label}</h3><p>{change.from && <><span>{change.from}</span><ArrowRight /></>}<span>{change.to || (change.session ? `${change.session.date} · ${change.session.start}–${endTime(change.session.start, change.session.duration)}` : '')}</span></p></div></article>; }

function WeekView({ doc, setDoc, weekId, currentWeekId, onWeek, onDate, onReplan }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; weekId: string; currentWeekId: string; onWeek: (weekId: string) => void; onDate: (date: string) => void; onReplan: () => void }) {
  const week = getWeek(doc, weekId) ?? { weekId, startDate: weekId, endDate: endOfIsoWeek(weekId), targets: doc.weeklyTargetTemplates, createdAt: '', source: 'rollover' as const };
  const relation = weekId === currentWeekId ? 'Current week' : weekId < currentWeekId ? 'Previous week' : 'Future week', days = Array.from({ length: 7 }, (_, index) => addLocalDays(weekId, index));
  return <section className="page-section"><div className="week-nav"><button onClick={() => onWeek(addLocalDays(weekId, -7))}><ChevronLeft /> Previous week</button><div><span>{relation}</span><b>{formatWeekRange(weekId)}</b></div><button onClick={() => onWeek(addLocalDays(weekId, 7))}>Next week <ChevronRight /></button></div>{weekId !== currentWeekId && <button className="back-current" onClick={() => onWeek(currentWeekId)}><RefreshCw /> Back to current week</button>}
    <div className="page-title"><div><div className="eyebrow">{relation}</div><h1>Targets & plan</h1><p>Progress is calculated only from {week.startDate} through {week.endDate}.</p></div><Button onClick={onReplan}><Sparkles /> Balance this week</Button></div>
    <div className="week-table"><div className="table-head"><span>Goal</span><span>Target</span><span>Done</span><span>Planned</span><span>Remaining</span><span>Status</span></div>{week.targets.map(target => { const metrics = targetMetrics(doc, week, target), state = statusFor(metrics); return <div className="target-row" key={target.id}><div><span className="cat-dot" style={{ background: cat[target.category]?.dot }} /><div><b>{target.label}</b><small>P{target.priority} · {target.unit}</small></div></div><input aria-label={`${target.label} target`} type="number" value={target.target} onChange={event => setDoc(current => ({ ...current, weeks: current.weeks.map(item => item.weekId === weekId ? { ...item, targets: item.targets.map(candidate => candidate.id === target.id ? { ...candidate, target: Number(event.target.value) } : candidate) } : item) }))} /><strong>{metrics.done}</strong><strong>{metrics.planned}</strong><strong>{metrics.remaining}</strong><em className={state[1]}>{state[0]}</em></div>; })}</div>
    <div className="week-days"><div className="section-label">Plan by date</div>{days.map(date => { const sessions = doc.sessions.filter(session => session.date === date && session.status !== 'skipped').sort((a, b) => mins(a.start) - mins(b.start)); return <button key={date} onClick={() => onDate(date)}><div><b>{parseLocalDate(date).toLocaleDateString('en-GB', { weekday: 'short' })}</b><span>{parseLocalDate(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></div><p>{sessions.length ? sessions.map(session => `${session.start} ${session.title}`).join(' · ') : 'No sessions planned'}</p><ChevronRight /></button>; })}</div>
  </section>;
}

function GoalsView({ doc, setDoc }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>> }) { return <section className="page-section"><div className="page-title"><div><div className="eyebrow">Direction</div><h1>Goals</h1><p>Priorities decide what survives when the week cannot hold everything.</p></div><Button><Plus /> New goal</Button></div><div className="goal-grid">{doc.goals.map(goal => <article className="goal-card" key={goal.id}><div className="goal-top"><span style={{ background: cat[goal.category]?.pale, color: cat[goal.category]?.dot }}>{cat[goal.category]?.label}</span><button><MoreHorizontal /></button></div><h2>{goal.title}</h2><p>{goal.measure}</p><div className="goal-bottom"><div className="priority-select"><span>Priority</span>{([1, 2, 3] as const).map(priority => <button key={priority} className={goal.priority === priority ? 'selected' : ''} onClick={() => setDoc(current => ({ ...current, goals: current.goals.map(item => item.id === goal.id ? { ...item, priority } : item) }))}>P{priority}</button>)}</div><label><input type="checkbox" checked={goal.active} onChange={event => setDoc(current => ({ ...current, goals: current.goals.map(item => item.id === goal.id ? { ...item, active: event.target.checked } : item) }))} />Active</label></div></article>)}</div><div className="monthly"><div className="section-label">This month</div>{doc.monthlyTargets.map(target => <div key={target.id}><div><b>{target.label}</b><span>{target.done} / {target.target} {target.unit}</span></div><Progress value={target.done / target.target * 100} /></div>)}</div></section>; }

function MonthView({ doc, selectedDate, localToday, onDate }: { doc: PlannerDocument; selectedDate: string; localToday: string; onDate: (date: string) => void }) { const selected = parseLocalDate(selectedDate), days = new Date(selected.getFullYear(), selected.getMonth() + 1, 0).getDate(), first = new Date(selected.getFullYear(), selected.getMonth(), 1).getDay(); return <section className="page-section"><div className="page-title"><div><div className="eyebrow">Monthly plan</div><h1>{selected.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h1><p>Select any date to open the exact plan in Day view.</p></div></div><div className="calendar"><div className="cal-head">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <span key={day}>{day}</span>)}</div><div className="cal-grid">{Array.from({ length: first }, (_, index) => <div key={`empty-${index}`} />)}{Array.from({ length: days }, (_, index) => { const date = `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`, sessions = doc.sessions.filter(session => session.date === date && session.status !== 'skipped'); return <button key={date} onClick={() => onDate(date)} className={`${date === localToday ? 'today' : ''} ${date === selectedDate ? 'selected-date' : ''}`}><b>{index + 1}</b><span>{sessions.slice(0, 3).map(session => <i key={session.id} style={{ background: cat[session.category]?.dot }} />)}</span>{sessions.length > 0 && <small>{sessions.filter(session => session.status === 'done').length}/{sessions.length}</small>}</button>; })}</div></div></section>; }

function ProfileView({ doc, setDoc, onMemory, onExport, onImport }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; onMemory: (id: string, status: 'approved' | 'rejected') => void; onExport: () => void; onImport: () => void }) { return <section className="page-section"><div className="page-title"><div><div className="eyebrow">Planning memory</div><h1>Profile & preferences</h1><p>The AI uses this as context. Lasting changes require your approval.</p></div></div><div className="settings-grid"><article><h2>Working rhythm</h2><div className="form-grid"><label>Usual wake<Input type="time" value={doc.profile.wakeTime} onChange={event => setDoc(current => ({ ...current, profile: { ...current.profile, wakeTime: event.target.value } }))} /></label><label>Usual sleep<Input type="time" value={doc.profile.sleepTime} onChange={event => setDoc(current => ({ ...current, profile: { ...current.profile, sleepTime: event.target.value } }))} /></label><label>Deep-work window<Input value={doc.profile.deepWorkWindow} onChange={event => setDoc(current => ({ ...current, profile: { ...current.profile, deepWorkWindow: event.target.value } }))} /></label><label>Daily focus capacity<Input type="number" value={doc.profile.dailyFocusCapacityHours} onChange={event => setDoc(current => ({ ...current, profile: { ...current.profile, dailyFocusCapacityHours: Number(event.target.value) } }))} /></label></div><h3>Saved preferences</h3><ul className="pref-list">{doc.profile.preferences.map(preference => <li key={preference}><Check />{preference}</li>)}</ul></article><article><h2>Suggested memories</h2>{doc.memories.filter(memory => memory.status === 'pending').map(memory => <div className="memory" key={memory.id}><Sparkles /><div><b>{memory.text}</b><p>{memory.reason}</p><div><Button size="sm" onClick={() => onMemory(memory.id, 'approved')}>Yes, remember this</Button><Button size="sm" variant="ghost" onClick={() => onMemory(memory.id, 'rejected')}>No</Button></div></div></div>)}<h2 className="data-title">Your data</h2><p>Cloud sync is primary. JSON remains available for backup and migration.</p><div className="data-actions"><Button variant="outline" onClick={onExport}><Download /> Export JSON</Button><Button variant="outline" onClick={onImport}><Upload /> Import V3, V4, or V5</Button></div></article></div></section>; }

const CATEGORIES: Category[] = ['sabzapply', 'internship', 'fitness', 'dutch', 'learning', 'cooking', 'personal', 'work'];
function deadlineStatus(deadline: string | null, localToday: string): { label: string; cls: string } | null {
  if (!deadline) return null;
  const diff = (parseLocalDate(deadline).getTime() - parseLocalDate(localToday).getTime()) / 86_400_000;
  if (diff < 0) return { label: `Overdue ${Math.abs(Math.round(diff))}d`, cls: 'deadline-overdue' };
  if (diff === 0) return { label: 'Due today', cls: 'deadline-today' };
  if (diff === 1) return { label: 'Due tomorrow', cls: 'deadline-today' };
  if (diff <= 3) return { label: `Due in ${Math.round(diff)}d`, cls: 'deadline-soon' };
  return { label: deadline.slice(5), cls: 'deadline-later' };
}
function groupByCategory(tasks: OngoingTask[]) {
  const groups: Record<string, OngoingTask[]> = {};
  for (const task of tasks) { (groups[task.category] ??= []).push(task); }
  for (const key of Object.keys(groups)) groups[key].sort((a, b) => a.priority - b.priority);
  return Object.entries(groups).sort(([, a], [, b]) => a[0].priority - b[0].priority);
}

function DeadlineAlerts({ tasks, localToday }: { tasks: OngoingTask[]; localToday: string }) {
  const urgent = tasks.filter(t => !t.done && t.deadline).map(t => ({ ...t, status: deadlineStatus(t.deadline, localToday)! })).filter(t => t.status && (t.status.cls === 'deadline-overdue' || t.status.cls === 'deadline-today'));
  if (!urgent.length) return null;
  return <div className="ai-error" role="alert" style={{ borderColor: '#e7c4b0', background: '#fffaf5' }}><CircleAlert /><div><b>{urgent.length} ongoing task{urgent.length > 1 ? 's' : ''} need{urgent.length === 1 ? 's' : ''} attention</b><span>{urgent.map(t => `${t.text} (${t.status.label})`).join(' · ')}</span></div></div>;
}

function OngoingTaskRow({ task, doc, setDoc, selectedDate, localToday }: { task: OngoingTask; doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; selectedDate: string; localToday: string }) {
  const [editing, setEditing] = useState(false), [editText, setEditText] = useState(task.text);
  const [scheduling, setScheduling] = useState(false);
  const [schedTime, setSchedTime] = useState('14:00'), [schedDuration, setSchedDuration] = useState('60'), [schedDay, setSchedDay] = useState(selectedDate);
  const [confirming, setConfirming] = useState(false);
  const dl = deadlineStatus(task.deadline, localToday);
  const toggleDone = () => setDoc(c => ({ ...c, ongoingTasks: c.ongoingTasks.map(t => t.id === task.id ? { ...t, done: !t.done } : t) }));
  const updateText = () => { if (editText.trim() && editText !== task.text) setDoc(c => ({ ...c, ongoingTasks: c.ongoingTasks.map(t => t.id === task.id ? { ...t, text: editText.trim() } : t) })); setEditing(false); };
  const deleteTask = () => setDoc(c => ({ ...c, ongoingTasks: c.ongoingTasks.filter(t => t.id !== task.id) }));
  const promoteToTop3 = () => { if (doc.top3.length >= 3) return; setDoc(c => ({ ...c, top3: [...c.top3, task.text] })); };
  const scheduleSession = () => {
    const session: Session = { id: `session-${crypto.randomUUID()}`, date: schedDay, start: schedTime, duration: Number(schedDuration), title: task.text, category: task.category, kind: 'flexible', status: 'planned', sourceTaskId: task.id };
    setDoc(c => ({ ...c, sessions: [...c.sessions, session] }));
    setScheduling(false);
  };
  return <div>
    <div className={`ongoing-row ${task.done ? 'done-row' : ''}`}>
      <button className={`ongoing-check ${task.done ? 'checked' : ''}`} onClick={toggleDone} aria-label={task.done ? 'Mark not done' : 'Mark done'}>{task.done && <Check />}</button>
      <span className={`ongoing-badge p${task.priority}`}>P{task.priority}</span>
      {editing ? <input className="ongoing-text-input" autoFocus value={editText} onChange={e => setEditText(e.target.value)} onBlur={updateText} onKeyDown={e => { if (e.key === 'Enter') updateText(); if (e.key === 'Escape') { setEditText(task.text); setEditing(false); } }} /> : <span className="ongoing-text" onClick={() => !task.done && setEditing(true)}>{task.text}</span>}
      {dl && <span className={`deadline-badge ${dl.cls}`}>{dl.label}</span>}
      {!task.done && <div className="ongoing-actions">
        {doc.top3.length < 3 && <button onClick={promoteToTop3} title="Add to top 3"><ArrowUp /></button>}
        <button onClick={() => setScheduling(!scheduling)} title="Schedule session"><Play /></button>
        {confirming ? <button onClick={deleteTask} title="Confirm delete" style={{ color: '#c05b46' }}><Trash2 /></button> : <button onClick={() => setConfirming(true)} title="Delete"><X /></button>}
      </div>}
    </div>
    {scheduling && <div className="schedule-inline">
      <input type="time" value={schedTime} onChange={e => setSchedTime(e.target.value)} />
      <select value={schedDuration} onChange={e => setSchedDuration(e.target.value)}><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option><option value="90">90 min</option><option value="120">2h</option></select>
      <select value={schedDay} onChange={e => setSchedDay(e.target.value)}><option value={localToday}>Today</option><option value={addLocalDays(localToday, 1)}>Tomorrow</option><option value={addLocalDays(localToday, 2)}>+2 days</option><option value={addLocalDays(localToday, 3)}>+3 days</option></select>
      <Button size="sm" onClick={scheduleSession}>Add session</Button>
      <button onClick={() => setScheduling(false)}><X size={14} /></button>
    </div>}
  </div>;
}

function AddTaskForm({ onAdd }: { onAdd: (task: Omit<OngoingTask, 'id' | 'createdAt'>) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(''), [category, setCategory] = useState<Category>('personal'), [priority, setPriority] = useState<Priority>(2), [deadline, setDeadline] = useState('');
  const submit = () => { if (!text.trim()) return; onAdd({ text: text.trim(), done: false, deadline: deadline || null, category, priority }); setText(''); setDeadline(''); setOpen(false); };
  if (!open) return <button onClick={() => setOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#526e63', fontSize: 13, fontWeight: 600, marginTop: 8 }}><Plus size={15} /> Add task</button>;
  return <div className="add-task-form">
    <div className="add-task-row"><Input value={text} onChange={e => setText(e.target.value)} placeholder="Task description" onKeyDown={e => { if (e.key === 'Enter') submit(); }} /></div>
    <div className="add-task-row">
      <select value={category} onChange={e => setCategory(e.target.value as Category)}>{CATEGORIES.map(c => <option key={c} value={c}>{cat[c]?.label}</option>)}</select>
      <select value={priority} onChange={e => setPriority(Number(e.target.value) as Priority)}><option value={1}>P1 — Must</option><option value={2}>P2 — Should</option><option value={3}>P3 — Nice</option></select>
      <Input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} style={{ width: 145 }} />
      <Button size="sm" onClick={submit}>Add</Button>
      <button onClick={() => setOpen(false)}><X size={14} /></button>
    </div>
  </div>;
}

function OngoingSection({ doc, setDoc, selectedDate, localToday, compact }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; selectedDate: string; localToday: string; compact?: boolean }) {
  const [showCompleted, setShowCompleted] = useState(false);
  const active = doc.ongoingTasks.filter(t => !t.done), done = doc.ongoingTasks.filter(t => t.done);
  const groups = groupByCategory(active);
  const addTask = (task: Omit<OngoingTask, 'id' | 'createdAt'>) => setDoc(c => ({ ...c, ongoingTasks: [...c.ongoingTasks, { ...task, id: `ongoing-${crypto.randomUUID()}`, createdAt: new Date().toISOString() }] }));
  return <div className="ongoing-section">
    <div className="ongoing-head"><div className="section-label"><ListTodo size={14} /> Ongoing tasks</div><span style={{ fontSize: 12, color: '#8b8a83' }}>{active.length} active{done.length ? ` · ${done.length} done` : ''}</span></div>
    {groups.map(([category, tasks]) => <div key={category} className="ongoing-group">
      <div className="ongoing-group-header"><span className="cat-dot" style={{ background: cat[category]?.dot }} />{cat[category]?.label}</div>
      {tasks.map(task => <OngoingTaskRow key={task.id} task={task} doc={doc} setDoc={setDoc} selectedDate={selectedDate} localToday={localToday} />)}
    </div>)}
    {!groups.length && !done.length && <div style={{ padding: '16px 0', color: '#8b8a83', fontSize: 13 }}>No ongoing tasks yet. Add one below.</div>}
    <AddTaskForm onAdd={addTask} />
    {done.length > 0 && <button className="completed-toggle" onClick={() => setShowCompleted(!showCompleted)}>{showCompleted ? <ChevronDown /> : <ChevronRight />} Show {done.length} completed</button>}
    {showCompleted && done.map(task => <OngoingTaskRow key={task.id} task={task} doc={doc} setDoc={setDoc} selectedDate={selectedDate} localToday={localToday} />)}
  </div>;
}

function TasksView({ doc, setDoc, selectedDate, localToday }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; selectedDate: string; localToday: string }) {
  const [filter, setFilter] = useState<string>('all');
  const active = doc.ongoingTasks.filter(t => !t.done), done = doc.ongoingTasks.filter(t => t.done);
  const overdue = active.filter(t => t.deadline && t.deadline < localToday);
  const filtered = filter === 'all' ? active : active.filter(t => t.category === filter);
  const groups = groupByCategory(filtered);
  const addTask = (task: Omit<OngoingTask, 'id' | 'createdAt'>) => setDoc(c => ({ ...c, ongoingTasks: [...c.ongoingTasks, { ...task, id: `ongoing-${crypto.randomUUID()}`, createdAt: new Date().toISOString() }] }));
  return <section className="page-section">
    <div className="page-title"><div><div className="eyebrow">Backlog</div><h1>Ongoing tasks</h1><p>Tasks that aren't tied to a specific time slot — manage alongside your daily schedule.</p></div></div>
    <div className="tasks-stats"><span><b>{active.length}</b> active</span>{overdue.length > 0 && <span style={{ color: '#c05b46' }}><b>{overdue.length}</b> overdue</span>}<span><b>{done.length}</b> completed</span></div>
    <div className="tasks-filters"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>{CATEGORIES.map(c => { const count = active.filter(t => t.category === c).length; return count > 0 ? <button key={c} className={filter === c ? 'active' : ''} onClick={() => setFilter(c)}><span className="cat-dot" style={{ background: cat[c]?.dot, marginRight: 5, display: 'inline-block' }} />{cat[c]?.label} ({count})</button> : null; })}</div>
    <OngoingSection doc={doc} setDoc={setDoc} selectedDate={selectedDate} localToday={localToday} />
  </section>;
}
