'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Activity, ArrowRight, ArrowUp, ArrowUpDown, Brain, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock, Download, Flag, Gauge, ListTodo, MapPin, MoreHorizontal, Play, Plus, RefreshCw, RotateCcw, Search, Settings2, Sparkles, Target, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import type { CalendarEvent, Category, Goal, OngoingTask, PlanProposal, PlannerApiResponse, PlannerDocument, Priority, ProposalChange, Review, Session, WeekRecord, WeeklyTarget } from '@/lib/planner-types';
import { createDefaultDocument, migratePlannerData } from '@/lib/default-data';
import { addLocalDays, endOfIsoWeek, formatDateLong, formatWeekRange, localDateInTimeZone, parseLocalDate, startOfIsoWeek } from '@/lib/date-utils';
import { applyProposalAtomically } from '@/lib/proposal-ops';
import { ensureWeekForDate, getWeek, targetMetrics } from '@/lib/week-metrics';

const CACHE = 'amir-planner-v5';
const TIMEZONE = 'Europe/Amsterdam';
const mins = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const fmtMinutes = (value: number) => value >= 60 ? `${Math.floor(value / 60)}h${value % 60 ? ` ${value % 60}m` : ''}` : `${value}m`;
const catMap: Record<string, { dot: string; pale: string; label: string }> = {
  internship: { dot: '#c05b46', pale: '#f9ece8', label: 'Internship' }, dutch: { dot: '#4e76b2', pale: '#eaf0f8', label: 'Dutch' },
  sabzapply: { dot: '#4b856c', pale: '#e8f2ed', label: 'SabzApply' }, fitness: { dot: '#d47a3d', pale: '#f9eee5', label: 'Fitness' },
  learning: { dot: '#8467a7', pale: '#f1ecf7', label: 'Learning' }, routine: { dot: '#8b8b82', pale: '#f0f0ed', label: 'Routine' },
  cooking: { dot: '#b48542', pale: '#f7f0e5', label: 'Cooking' }, free: { dot: '#718079', pale: '#edf0ee', label: 'Recovery' },
  personal: { dot: '#77716c', pale: '#f0eeec', label: 'Personal' }, work: { dot: '#b64e57', pale: '#f8e9eb', label: 'Work' },
};
function cat(c: string) { if (catMap[c]) return catMap[c]; const h = Math.abs([...c].reduce((a, ch) => ch.charCodeAt(0) + ((a << 5) - a), 0) % 360); return { dot: `hsl(${h},45%,45%)`, pale: `hsl(${h},35%,93%)`, label: c.charAt(0).toUpperCase() + c.slice(1).replace(/[-_]/g, ' ') }; }
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
  const baselineDoc = useRef<PlannerDocument | null>(null), offlineEditsRef = useRef(false), cloudUpdatedAt = useRef<string>(''), localDirty = useRef(false);
  const markOfflineEdits = (value: boolean) => { offlineEditsRef.current = value; setOfflineEdits(value); };
  const [view, setView] = useState<'day' | 'week' | 'goals' | 'tasks' | 'month' | 'settings'>('day');
  const [selectedDate, setSelectedDate] = useState(localToday), [weekCursor, setWeekCursor] = useState(currentWeekId);
  const [morning, setMorning] = useState(false), [proposal, setProposal] = useState<PlanProposal | null>(null);
  const [proposalProvider, setProposalProvider] = useState(''), [modifyMode, setModifyMode] = useState(false), [modifyText, setModifyText] = useState('');
  const [wake, setWake] = useState(new Date().toTimeString().slice(0, 5)), [energy, setEnergy] = useState<'low' | 'normal' | 'high'>('normal'), [unusual, setUnusual] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false), [reviewScore, setReviewScore] = useState(0), [reviewWin, setReviewWin] = useState(''), [reviewStruggle, setReviewStruggle] = useState(''), [reviewCarry, setReviewCarry] = useState('');
  const [message, setMessage] = useState(''), [aiStatus, setAiStatus] = useState<AiStatus>('idle'), [aiError, setAiError] = useState('');
  const [retryRequest, setRetryRequest] = useState<RetryRequest | null>(null), [reasoning, setReasoning] = useState(false), [addOpen, setAddOpen] = useState(false);
  const [newTitle, setNewTitle] = useState(''), [newTime, setNewTime] = useState('14:00'), [newDuration, setNewDuration] = useState('60'), [newCategory, setNewCategory] = useState<string>('personal'), [newFixed, setNewFixed] = useState(false);
  const [editOpen, setEditOpen] = useState(false), [editSession, setEditSession] = useState<Session | null>(null);
  const [editTitle, setEditTitle] = useState(''), [editTime, setEditTime] = useState(''), [editDuration, setEditDuration] = useState('60'), [editCategory, setEditCategory] = useState<string>('personal'), [editKind, setEditKind] = useState<Session['kind']>('flexible');
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);
  const [headerMenu, setHeaderMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!headerMenu) return;
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setHeaderMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [headerMenu]);
  const logout = async () => { try { await fetch('/api/login', { method: 'DELETE', credentials: 'same-origin' }); } catch {} window.location.href = '/login'; };

  const loadFromCloud = useCallback(async () => {
    setSync('saving'); setSyncError('');
    try {
      const response = await fetch(`/api/state?localDate=${localToday}`, { cache: 'no-store', credentials: 'same-origin' });
      if (response.status === 401) { setSignedOut(true); setCloudReady(false); setSync('offline'); return false; }
      if (!response.ok) throw new Error(response.status === 503 ? 'Cloud storage is unavailable right now, so this device is not syncing.' : `The planner could not be loaded from the cloud (HTTP ${response.status}).`);
      const payload = await response.json() as { document: unknown; updatedAt?: string };
      setSignedOut(false); setCloudReady(true);
      if (payload.updatedAt) cloudUpdatedAt.current = payload.updatedAt;
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

  // Auto-sync calendar in background if stale (>4 hours)
  useEffect(() => {
    if (!loaded || !cloudReady) return;
    const icsUrl = doc.profile.calendarIcsUrl;
    const lastSync = doc.profile.calendarLastSync;
    if (!icsUrl) return;
    const age = lastSync ? (Date.now() - new Date(lastSync).getTime()) / 3600_000 : Infinity;
    if (age < 4) return;
    fetch('/api/calendar', { method: 'POST', credentials: 'same-origin' }).then(async res => {
      if (!res.ok) return;
      const fresh = await fetch(`/api/state?localDate=${localToday}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!fresh.ok) return;
      const payload = await fresh.json() as { document: unknown; updatedAt?: string };
      if (payload.updatedAt) cloudUpdatedAt.current = payload.updatedAt;
      const next = migratePlannerData(payload.document, localToday);
      baselineDoc.current = next; setDoc(next);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, cloudReady]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(CACHE, JSON.stringify(doc));
    const edited = baselineDoc.current !== null && doc !== baselineDoc.current;
    localDirty.current = edited;
    const timer = setTimeout(async () => {
      if (!cloudReady) { if (edited) markOfflineEdits(true); return; }
      setSync('saving');
      try {
        const response = await fetch('/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(doc) });
        if (response.status === 401) { setSignedOut(true); setCloudReady(false); markOfflineEdits(true); setSync('offline'); return; }
        if (!response.ok) throw new Error(response.status === 503 ? 'Cloud storage is unavailable, so this change is only on this device.' : `This change could not be saved to the cloud (HTTP ${response.status}).`);
        const saved = await response.json() as { updatedAt?: string };
        if (saved.updatedAt) cloudUpdatedAt.current = saved.updatedAt;
        baselineDoc.current = doc; localDirty.current = false; markOfflineEdits(false); setSyncError(''); setSync('saved');
      } catch (error) {
        markOfflineEdits(true); setSync('offline');
        setSyncError(error instanceof Error && error.message ? error.message : 'This change is saved on this device only.');
      }
    }, 650);
    return () => clearTimeout(timer);
  }, [doc, loaded, cloudReady]);

  // Cross-device sync: refetch cloud state on tab focus and every 30s.
  const pullIfNewer = useCallback(async () => {
    if (!cloudReady || offlineEditsRef.current || localDirty.current) return;
    try {
      const res = await fetch(`/api/state?localDate=${localToday}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      const payload = await res.json() as { document: unknown; updatedAt?: string };
      if (!payload.updatedAt || payload.updatedAt <= cloudUpdatedAt.current) return;
      cloudUpdatedAt.current = payload.updatedAt;
      const next = migratePlannerData(payload.document, localToday);
      baselineDoc.current = next; setDoc(next); setSync('saved');
    } catch { /* silent — the periodic retry will catch it next time */ }
  }, [cloudReady, localToday]);

  useEffect(() => {
    if (!loaded) return;
    const onFocus = () => { if (document.visibilityState === 'visible') pullIfNewer(); };
    document.addEventListener('visibilitychange', onFocus);
    const poll = setInterval(pullIfNewer, 30_000);
    return () => { document.removeEventListener('visibilitychange', onFocus); clearInterval(poll); };
  }, [loaded, pullIfNewer]);

  const syncState = sync === 'saving' ? 'saving' : cloudReady ? sync : 'offline';
  const openDate = (date: string) => { setDoc(current => ensureWeekForDate(current, date)); setSelectedDate(date); setWeekCursor(startOfIsoWeek(date)); setView('day'); };
  const openWeek = (weekId: string) => { const targetWeek = startOfIsoWeek(weekId); setDoc(current => ensureWeekForDate(current, targetWeek)); setWeekCursor(targetWeek); if (startOfIsoWeek(selectedDate) !== targetWeek) setSelectedDate(targetWeek); setView('week'); };
  const selectedSessions = useMemo(() => doc.sessions.filter(session => session.date === selectedDate).sort((a, b) => mins(a.start) - mins(b.start)), [doc.sessions, selectedDate]);
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
  const skipSession = (session: Session) => setDoc(current => ({ ...current, sessions: current.sessions.map(item => item.id === session.id ? { ...item, status: session.status === 'skipped' ? 'planned' : 'skipped' } : item), history: [{ id: `history-${crypto.randomUUID()}`, at: new Date().toISOString(), type: session.status === 'skipped' ? 'session_unskipped' : 'session_skipped', note: session.title, weekId: startOfIsoWeek(session.date) }, ...current.history] }));
  const removeSession = (id: string) => { if (removeConfirm !== id) { setRemoveConfirm(id); return; } setDoc(current => ({ ...current, sessions: current.sessions.filter(s => s.id !== id), history: [{ id: `history-${crypto.randomUUID()}`, at: new Date().toISOString(), type: 'session_removed', note: current.sessions.find(s => s.id === id)?.title ?? '', weekId: startOfIsoWeek(selectedDate) }, ...current.history] })); setRemoveConfirm(null); };
  function openEditSession(s: Session) { setEditSession(s); setEditTitle(s.title); setEditTime(s.start); setEditDuration(String(s.duration)); setEditCategory(s.category); setEditKind(s.kind); setEditOpen(true); }
  function saveEditSession() { if (!editSession || !editTitle.trim()) return; setDoc(current => ({ ...current, sessions: current.sessions.map(s => s.id === editSession.id ? { ...s, title: editTitle.trim(), start: editTime, duration: Number(editDuration), category: editCategory, kind: editKind } : s) })); setEditOpen(false); setEditSession(null); }
  function addSession() { if (!newTitle.trim()) return; setDoc(current => ({ ...current, sessions: [...current.sessions, { id: `session-${crypto.randomUUID()}`, date: selectedDate, start: newTime, duration: Number(newDuration), title: newTitle.trim(), category: newCategory, kind: newFixed ? 'fixed' : 'flexible', status: 'planned' }] })); setNewTitle(''); setAddOpen(false); }
  function setMemory(id: string, status: 'approved' | 'rejected') { setDoc(current => { const memory = current.memories.find(item => item.id === id); return { ...current, memories: current.memories.map(item => item.id === id ? { ...item, status } : item), profile: status === 'approved' && memory ? { ...current.profile, preferences: [...current.profile.preferences, memory.text] } : current.profile }; }); }
  function exportData() { const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `amir-planner-${localToday}.json`; anchor.click(); URL.revokeObjectURL(anchor.href); }
  async function importData(file?: File) { if (file) setDoc(migratePlannerData(JSON.parse(await file.text()), localToday)); }

  const existingReview = useMemo(() => doc.reviews.find(r => r.date === selectedDate), [doc.reviews, selectedDate]);
  function openReview() {
    if (existingReview) { setReviewScore(existingReview.score); setReviewWin(existingReview.win); setReviewStruggle(existingReview.struggle || existingReview.blocker); setReviewCarry(existingReview.carryForward || ''); }
    else { setReviewScore(0); setReviewWin(''); setReviewStruggle(''); setReviewCarry(''); }
    setReviewOpen(true);
  }
  function saveReview() {
    if (!reviewScore) return;
    const review: Review = { id: existingReview?.id || `review-${crypto.randomUUID()}`, date: selectedDate, score: reviewScore, win: reviewWin.trim(), blocker: reviewStruggle.trim(), struggle: reviewStruggle.trim(), carryForward: reviewCarry.trim(), reviewedAt: new Date().toISOString() };
    setDoc(current => ({ ...current, reviews: existingReview ? current.reviews.map(r => r.id === existingReview.id ? review : r) : [...current.reviews, review] }));
    setReviewOpen(false);
  }

  useEffect(() => { const context = (document as Document & { modelContext?: { registerTool: (tool: unknown, options?: unknown) => unknown } }).modelContext; if (!context?.registerTool) return; const controller = new AbortController(); Promise.resolve(context.registerTool({ name: 'request_plan_update', title: 'Request plan update', description: 'Stage a proposal for the date Amir is currently viewing. Nothing changes before approval.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: async (input: unknown) => { const toolMessage = (input as { message?: unknown }).message; if (typeof toolMessage !== 'string' || !toolMessage.trim()) throw new Error('message is required'); setMessage(toolMessage); return { status: 'staged', selectedDate, message: toolMessage }; } }, { signal: controller.signal })).catch(() => {}); return () => controller.abort(); }, [selectedDate]);
  if (!loaded) return <div className="min-h-screen grid place-items-center text-stone-500">Preparing your current week…</div>;

  return <div className="min-h-screen bg-background text-foreground">
    <header className="topbar"><div className="brand"><div className="brandmark">A</div><span>Amir</span><span className="brand-muted">OS</span></div><nav className="desktop-nav" aria-label="Primary">{([['day', 'Day'], ['week', 'Week'], ['goals', 'Goals'], ['tasks', 'Tasks'], ['month', 'Month'], ['settings', 'Profile']] as const).map(([id, label]) => <button key={id} onClick={() => setView(id)} className={view === id ? 'active' : ''}>{label}</button>)}</nav><div className="sync"><span className={`sync-dot ${syncState}`} />{syncState === 'saved' ? 'Cloud saved' : syncState === 'saving' ? 'Saving…' : offlineEdits ? 'Not saved to cloud' : 'Local cache'}<div className="header-menu-wrap" ref={menuRef}><button className="icon-btn" aria-label="More" onClick={() => setHeaderMenu(!headerMenu)}><MoreHorizontal size={19} /></button>{headerMenu && <div className="header-menu"><button onClick={() => { exportData(); setHeaderMenu(false); }}><Download size={15} />Export data</button><button onClick={() => { setHeaderMenu(false); logout(); }}><ArrowRight size={15} />Logout</button><div className="header-menu-version">Amir OS v0.1.0</div></div>}</div></div></header>
    <main className="shell"><div className="mobile-nav"><button onClick={() => setView('day')}>Day</button><button onClick={() => setView('week')}><Gauge />Week</button><button onClick={() => setView('goals')}><Target />Goals</button><button onClick={() => setView('tasks')}><ListTodo />Tasks</button><button onClick={() => setView('settings')}><Settings2 />Profile</button></div>
      {(signedOut || syncError) && <div className="ai-error" role="alert"><CircleAlert /><div><b>{signedOut ? 'Signed out — changes are not reaching the cloud' : 'Not saving to the cloud'}</b><span>{signedOut ? 'This device’s session expired. Your plan is safe here; sign in again to resume cloud sync.' : `${syncError}${offlineEdits ? ' Your latest changes are held on this device and will be pushed once syncing resumes.' : ''}`}</span></div>{signedOut ? <a className="sync-signin" href={`/login?next=${encodeURIComponent('/')}`}>Sign in</a> : <button onClick={() => loadFromCloud()}>Retry</button>}<button aria-label="Dismiss sync message" onClick={() => { setSyncError(''); setSignedOut(false); }}><X /></button></div>}
      {aiError && <div className="ai-error" role="alert"><CircleAlert /><div><b>AI planning failed</b><span>{aiError}</span></div>{retryRequest && <button onClick={() => requestPlan(retryRequest)}>Retry</button>}<button aria-label="Dismiss error" onClick={() => setAiError('')}><X /></button></div>}
      {view === 'day' && <DayView doc={doc} setDoc={setDoc} localToday={localToday} selectedDate={selectedDate} sessions={selectedSessions} active={active} next={next} focusMinutes={focusMinutes} fixedMinutes={fixedMinutes} onDate={openDate} onMorning={() => setMorning(true)} onReview={openReview} existingReview={existingReview} onReplan={() => requestPlan({ trigger: 'manual' })} onToggle={toggleSession} onSkip={skipSession} onEdit={openEditSession} onRemove={removeSession} removeConfirm={removeConfirm} onAdd={() => setAddOpen(true)} onReasoning={() => setReasoning(!reasoning)} reasoning={reasoning} onOpenWeek={() => openWeek(startOfIsoWeek(selectedDate))} />}
      {view === 'week' && <WeekView doc={doc} setDoc={setDoc} weekId={weekCursor} currentWeekId={currentWeekId} onWeek={openWeek} onDate={openDate} onReplan={() => requestPlan({ trigger: 'manual' })} />}
      {view === 'goals' && <GoalsView doc={doc} setDoc={setDoc} />}{view === 'tasks' && <TasksView doc={doc} setDoc={setDoc} selectedDate={selectedDate} localToday={localToday} />}{view === 'month' && <MonthView doc={doc} selectedDate={selectedDate} localToday={localToday} onDate={openDate} />}{view === 'settings' && <ProfileView doc={doc} setDoc={setDoc} onMemory={setMemory} onExport={exportData} onImport={() => importRef.current?.click()} />}
    </main>
    <div className="command-dock"><div className="command-inner"><Sparkles size={18} /><input aria-label="Tell the planner what changed" value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && message.trim()) requestPlan({ trigger: 'conversation', message }); }} placeholder={`Tell me what changed for ${relativeDayLabel(selectedDate, localToday).toLowerCase()}…`} /><button aria-label="Send to planner" onClick={() => message.trim() && requestPlan({ trigger: 'conversation', message })} disabled={!message.trim() || aiStatus !== 'idle'}>{aiStatus === 'planning' ? <RefreshCw className="spin" /> : <ArrowRight />}</button></div><span>AI context date: {formatDateLong(selectedDate)}</span></div>
    {aiStatus !== 'idle' && <div className="ai-status" role="status"><RefreshCw className="spin" />{aiStatus === 'planning' ? 'Planning your day…' : aiStatus === 'updating' ? 'Updating proposal…' : 'Applying changes…'}</div>}
    <Dialog open={morning} onOpenChange={setMorning}><DialogContent className="checkin-dialog"><DialogHeader className="checkin-header"><DialogTitle className="checkin-title">Good morning</DialogTitle><DialogDescription className="checkin-date">{formatDateLong(selectedDate)}</DialogDescription></DialogHeader><div className="checkin-fields"><label className="checkin-field"><span className="checkin-label">What time did you wake up?</span><Input type="time" value={wake} onChange={event => setWake(event.target.value)} className="checkin-input" /></label><div className="checkin-field"><span className="checkin-label">How's your energy?</span><div className="checkin-energy">{(['low', 'normal', 'high'] as const).map(level => <button className={`checkin-energy-btn ${energy === level ? 'selected' : ''}`} key={level} onClick={() => setEnergy(level)}>{level[0].toUpperCase() + level.slice(1)}</button>)}</div></div><label className="checkin-field"><span className="checkin-label">Anything unusual today?</span><Textarea value={unusual} onChange={event => setUnusual(event.target.value)} placeholder="Appointments, travel, poor sleep, changes to your day..." className="checkin-textarea" rows={3} /></label></div><DialogFooter className="checkin-footer"><Button className="checkin-submit" onClick={() => requestPlan({ trigger: 'morning' })} disabled={aiStatus !== 'idle'}>{aiStatus === 'planning' ? 'Planning your day...' : 'Plan my day'}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={reviewOpen} onOpenChange={setReviewOpen}><DialogContent className="checkin-dialog"><DialogHeader className="checkin-header"><DialogTitle className="checkin-title">How was your day?</DialogTitle><DialogDescription className="checkin-date">{formatDateLong(selectedDate)}</DialogDescription></DialogHeader><div className="checkin-fields"><div className="checkin-field"><span className="checkin-label">Day score</span><div className="review-scores">{Array.from({ length: 10 }, (_, i) => i + 1).map(n => <button key={n} className={`review-score-btn ${reviewScore === n ? 'selected' : ''} score-${n <= 3 ? 'low' : n <= 6 ? 'mid' : n <= 8 ? 'good' : 'great'}`} onClick={() => setReviewScore(n)}>{n}</button>)}</div></div><label className="checkin-field"><span className="checkin-label">What went well today?</span><Input value={reviewWin} onChange={event => setReviewWin(event.target.value)} placeholder="Finished internship application, great gym session..." className="checkin-input" /></label><label className="checkin-field"><span className="checkin-label">What didn't go well?</span><Input value={reviewStruggle} onChange={event => setReviewStruggle(event.target.value)} placeholder="Skipped Dutch, procrastinated in the morning..." className="checkin-input" /></label><label className="checkin-field"><span className="checkin-label">Move to tomorrow?</span><Input value={reviewCarry} onChange={event => setReviewCarry(event.target.value)} placeholder="Finish SabzApply contracts, call about apartment..." className="checkin-input" /></label></div><DialogFooter className="checkin-footer"><Button className="checkin-submit" onClick={saveReview} disabled={!reviewScore}>Save review</Button></DialogFooter></DialogContent></Dialog>
    {proposal && <div className="proposal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) rejectProposal(); }}><section className="proposal-sheet" role="dialog" aria-modal="true" aria-labelledby="proposal-title"><div className="proposal-scroll"><div className="proposal-kicker"><Sparkles /> AI plan update <span>{proposalProvider}</span><button aria-label="Close proposal" onClick={rejectProposal}><X /></button></div><h2 id="proposal-title">{proposal.title}</h2><p className="proposal-summary">{proposal.summary}</p><div className="proposal-date"><CalendarDays />Planning {formatDateLong(proposal.selectedDate)} · week {formatWeekRange(proposal.weekId)}</div><div className="changes-heading"><b>AI suggests {proposal.changes.length} {proposal.changes.length === 1 ? 'change' : 'changes'}</b><span>Nothing has changed yet</span></div><div className="proposal-changes">{proposal.changes.length ? proposal.changes.map(change => <Diff key={change.id} change={change} />) : <div className="no-change"><Check />Your current plan is already the best realistic allocation.</div>}</div><details className="proposal-reasoning"><summary>Why this plan <ChevronRight /></summary><ul>{proposal.reasoning.map((item, index) => <li key={index}>{item}</li>)}</ul>{proposal.tradeoffs.length > 0 && <><h4>Tradeoffs</h4><ul>{proposal.tradeoffs.map((item, index) => <li key={index}>{item}</li>)}</ul></>}</details>{modifyMode && <div className="modify-panel"><label htmlFor="modify-proposal">What should change?</label><Textarea id="modify-proposal" autoFocus value={modifyText} onChange={event => setModifyText(event.target.value)} placeholder="Keep the run on Tuesday but move Dutch instead." /><div><button onClick={() => { setModifyMode(false); setModifyText(''); }}>Cancel</button><Button onClick={() => requestPlan({ trigger: 'modify', originalProposal: proposal, modification: modifyText })} disabled={!modifyText.trim() || aiStatus !== 'idle'}>{aiStatus === 'updating' ? 'Updating proposal…' : 'Update proposal'}</Button></div></div>}</div><footer className="proposal-actions"><button className="reject-action" onClick={rejectProposal}>Reject</button><button className="modify-action" onClick={() => setModifyMode(true)}>Modify</button><Button onClick={applyProposal} disabled={!proposal.changes.length || aiStatus !== 'idle'}>Apply changes</Button></footer></section></div>}
    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent className="checkin-dialog"><DialogHeader className="checkin-header"><DialogTitle className="checkin-title">Add to {relativeDayLabel(selectedDate, localToday).toLowerCase()}</DialogTitle><DialogDescription className="checkin-date">Create a session on {formatDateLong(selectedDate)}.</DialogDescription></DialogHeader><div className="checkin-fields">
      <label className="checkin-field"><span className="checkin-label">What</span><Input value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="Appointment or work session" className="checkin-input" /></label>
      <div className="goal-target-row"><label className="checkin-field" style={{ flex: 1 }}><span className="checkin-label">Starts</span><Input type="time" value={newTime} onChange={event => setNewTime(event.target.value)} className="checkin-input" /></label><label className="checkin-field" style={{ flex: 1 }}><span className="checkin-label">Duration</span><select className="goal-select" value={newDuration} onChange={e => setNewDuration(e.target.value)}><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option><option value="180">3 hours</option></select></label></div>
      <label className="checkin-field"><span className="checkin-label">Category</span><select className="goal-select" value={newCategory} onChange={e => setNewCategory(e.target.value)}>{(doc.profile.customCategories ?? Object.keys(catMap)).map(c => <option key={c} value={c}>{cat(c).label}</option>)}</select></label>
      <button className={`fixed-toggle ${newFixed ? 'on' : ''}`} onClick={() => setNewFixed(!newFixed)}><Flag /> {newFixed ? 'Fixed commitment' : 'Flexible session'}</button>
    </div><DialogFooter className="checkin-footer"><Button className="checkin-submit" onClick={addSession} disabled={!newTitle.trim()}>Add to plan</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={editOpen} onOpenChange={v => { setEditOpen(v); if (!v) setEditSession(null); }}><DialogContent className="checkin-dialog"><DialogHeader className="checkin-header"><DialogTitle className="checkin-title">Edit session</DialogTitle><DialogDescription className="checkin-date">Change the details of this session.</DialogDescription></DialogHeader><div className="checkin-fields">
      <label className="checkin-field"><span className="checkin-label">Title</span><Input value={editTitle} onChange={e => setEditTitle(e.target.value)} className="checkin-input" /></label>
      <div className="goal-target-row"><label className="checkin-field" style={{ flex: 1 }}><span className="checkin-label">Start time</span><Input type="time" value={editTime} onChange={e => setEditTime(e.target.value)} className="checkin-input" /></label><label className="checkin-field" style={{ flex: 1 }}><span className="checkin-label">Duration</span><select className="goal-select" value={editDuration} onChange={e => setEditDuration(e.target.value)}><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option><option value="180">3 hours</option></select></label></div>
      <label className="checkin-field"><span className="checkin-label">Category</span><select className="goal-select" value={editCategory} onChange={e => setEditCategory(e.target.value)}>{(doc.profile.customCategories ?? Object.keys(catMap)).map(c => <option key={c} value={c}>{cat(c).label}</option>)}</select></label>
      <button className={`fixed-toggle ${editKind === 'fixed' ? 'on' : ''}`} onClick={() => setEditKind(editKind === 'fixed' ? 'flexible' : 'fixed')}><Flag /> {editKind === 'fixed' ? 'Fixed commitment' : 'Flexible session'}</button>
    </div><DialogFooter className="checkin-footer"><Button className="checkin-submit" onClick={saveEditSession} disabled={!editTitle.trim()}>Save changes</Button></DialogFooter></DialogContent></Dialog>
    <input ref={importRef} type="file" hidden accept="application/json" onChange={event => importData(event.target.files?.[0])} />
  </div>;
}

function DateNavigator({ selectedDate, localToday, onDate }: { selectedDate: string; localToday: string; onDate: (date: string) => void }) { return <div className="date-navigator" aria-label="Date navigation"><button aria-label="Previous day" onClick={() => onDate(addLocalDays(selectedDate, -1))}><ChevronLeft /></button><button className={selectedDate === localToday ? 'selected' : ''} onClick={() => onDate(localToday)}>Today</button><button className={selectedDate === addLocalDays(localToday, 1) ? 'selected' : ''} onClick={() => onDate(addLocalDays(localToday, 1))}>Tomorrow</button><label><CalendarDays /><Input aria-label="Select a date" type="date" value={selectedDate} onChange={event => event.target.value && onDate(event.target.value)} /></label><button aria-label="Next day" onClick={() => onDate(addLocalDays(selectedDate, 1))}><ChevronRight /></button></div>; }

function DayView({ doc, setDoc, localToday, selectedDate, sessions, active, next, focusMinutes, fixedMinutes, onDate, onMorning, onReview, existingReview, onReplan, onToggle, onSkip, onEdit, onRemove, removeConfirm, onAdd, onReasoning, reasoning, onOpenWeek }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; localToday: string; selectedDate: string; sessions: Session[]; active?: Session; next?: Session; focusMinutes: number; fixedMinutes: number; onDate: (date: string) => void; onMorning: () => void; onReview: () => void; existingReview?: Review; onReplan: () => void; onToggle: (session: Session) => void; onSkip: (session: Session) => void; onEdit: (session: Session) => void; onRemove: (id: string) => void; removeConfirm: string | null; onAdd: () => void; onReasoning: () => void; reasoning: boolean; onOpenWeek: () => void }) {
  const week = getWeek(doc, startOfIsoWeek(selectedDate)), label = relativeDayLabel(selectedDate, localToday);
  const yesterdayReview = doc.reviews.find(r => r.date === addLocalDays(selectedDate, -1));
  const carryForwardText = yesterdayReview?.carryForward?.trim();
  return <div><DateNavigator selectedDate={selectedDate} localToday={localToday} onDate={onDate} /><div className="day-layout"><section className="day-main">
    <div className="day-heading"><div><div className="eyebrow">{label} · {startOfIsoWeek(selectedDate) === startOfIsoWeek(localToday) ? 'Current week' : formatWeekRange(startOfIsoWeek(selectedDate))}</div><h1>{formatDateLong(selectedDate).replace(/^[A-Za-z]+,?\s*/, '')}</h1><p>{Math.round(focusMinutes / 6) / 10}h focused · {Math.round(fixedMinutes / 6) / 10}h routines & fixed · selected plan is current</p></div><div className="day-actions">{selectedDate === localToday && <Button variant="outline" onClick={onMorning}><Activity /> Check in</Button>}{selectedDate <= localToday && <Button variant="outline" className="review-btn" onClick={onReview}><Clock /> {existingReview ? 'Edit review' : 'Review'}</Button>}<Button onClick={onReplan}><RefreshCw /> Replan</Button></div></div>
    {carryForwardText && <div className="carry-banner"><ArrowRight size={14} /><span>Carried from yesterday: {carryForwardText}</span></div>}
    <div className="now-grid"><div className="now-card"><span>{selectedDate === localToday ? 'Now' : 'First planned'}</span>{active ? <><h2>{active.title}</h2><p>{active.start}–{endTime(active.start, active.duration)} · {cat(active.category).label}</p><div className="now-actions"><button onClick={() => onToggle(active)}><Check />Mark {active.status === 'done' ? 'planned' : 'done'}</button><button onClick={() => document.getElementById(`session-${active.id}`)?.scrollIntoView({ behavior: 'smooth' })}>Open</button></div></> : <h2>No sessions planned</h2>}</div><div className="next-card"><span>{selectedDate === localToday ? 'Next' : 'After that'}</span>{next ? <><h3>{next.title}</h3><p>{next.start} · {fmtMinutes(next.duration)}</p></> : <><h3>Open capacity</h3><p>No later planned work</p></>}<div className="capacity"><div><span>Daily capacity</span><b>{Math.round(focusMinutes / 6) / 10} / {doc.profile.dailyFocusCapacityHours}h</b></div><Progress value={Math.min(100, focusMinutes / 60 / doc.profile.dailyFocusCapacityHours * 100)} /></div></div></div>
    <DeadlineAlerts tasks={doc.ongoingTasks} localToday={localToday} />
    {doc.top3.length > 0 && doc.goals.some(g => g.active) && sessions.length > 0 && <div className="priority-strip"><div className="section-label"><Flag /> Priorities</div>{doc.top3.map((priority, index) => <div key={priority}><b>{index + 1}</b><span>{priority}</span></div>)}</div>}
    <div className="plan-head"><div><div className="section-label">{label}'s plan</div><p>This exact date is shared across Day, Week, Month, and AI planning.</p></div><button onClick={onAdd}><Plus /> Add</button></div><div className="timeline">{(() => { const calEvts = (doc.calendarEvents ?? []).filter(e => e.date === selectedDate); const items: Array<{ type: 'session'; data: Session } | { type: 'calendar'; data: CalendarEvent }> = [...sessions.map(s => ({ type: 'session' as const, data: s })), ...calEvts.map(e => ({ type: 'calendar' as const, data: e }))].sort((a, b) => { const ta = a.type === 'session' ? a.data.start : (a.data as CalendarEvent).allDay ? '00:00' : (a.data as CalendarEvent).startTime; const tb = b.type === 'session' ? b.data.start : (b.data as CalendarEvent).allDay ? '00:00' : (b.data as CalendarEvent).startTime; return mins(ta) - mins(tb); }); return items.length ? items.map((item, index) => item.type === 'session' ? <SessionRow key={item.data.id} session={item.data} last={index === items.length - 1} onToggle={() => onToggle(item.data)} onSkip={() => onSkip(item.data)} onEdit={() => onEdit(item.data)} onRemove={() => onRemove(item.data.id)} isRemoving={removeConfirm === item.data.id} /> : <CalendarEventRow key={item.data.id} event={item.data} last={index === items.length - 1} />) : <div className="empty-day"><CalendarDays /><b>No plan for this date yet.</b><span>Add a session or ask AI to plan it.</span></div>; })()}</div>
    {existingReview && <ReviewCard review={existingReview} onEdit={onReview} />}
    <OngoingSection doc={doc} setDoc={setDoc} selectedDate={selectedDate} localToday={localToday} compact />
  </section><aside className="insights"><div className="ai-card"><div className="ai-title"><Brain />Chief of staff</div><p>The planner will optimize from {formatDateLong(selectedDate)}, with fixed commitments and recovery protected.</p><button onClick={onReasoning}>{reasoning ? 'Hide reasoning' : 'View planning context'} <ArrowRight /></button>{reasoning && <ul><li>Selected date: {selectedDate}</li><li>Planning week: {startOfIsoWeek(selectedDate)}</li><li>Fixed commitments cannot be moved by AI.</li></ul>}</div>{week && <div className="week-mini"><div className="section-label">Week · {formatWeekRange(week.weekId)}</div>{week.targets.slice(0, 4).map(target => <MiniTarget key={target.id} doc={doc} week={week} target={target} />)}<button className="text-button" onClick={onOpenWeek}>Open this week <ArrowRight /></button></div>}</aside></div></div>;
}

function SessionRow({ session, last, onToggle, onSkip, onEdit, onRemove, isRemoving }: { session: Session; last: boolean; onToggle: () => void; onSkip: () => void; onEdit: () => void; onRemove: () => void; isRemoving: boolean }) { return <div id={`session-${session.id}`} className={`session ${session.status === 'done' ? 'done' : ''} ${session.status === 'skipped' ? 'skipped' : ''}`}><div className="time"><b>{session.start}</b><span>{endTime(session.start, session.duration)}</span></div><div className="rail"><button onClick={onToggle} aria-label={`Mark ${session.title} ${session.status === 'done' ? 'planned' : 'done'}`}>{session.status === 'done' ? <Check /> : session.status === 'skipped' ? <X size={14} /> : <span style={{ borderColor: cat(session.category).dot }} />}</button>{!last && <i />}</div><div className="session-body"><div><h3>{session.title}</h3><p><span className="tag" style={{ background: cat(session.category).pale, color: cat(session.category).dot }}>{cat(session.category).label}</span><span>{fmtMinutes(session.duration)}</span>{session.kind === 'fixed' && <span className="fixed"><Flag /> Fixed</span>}{session.sourceTaskId && <span>Linked task</span>}</p></div><div className="session-actions"><button onClick={onEdit} title="Edit session"><Settings2 size={15} /></button><button onClick={onSkip} title={session.status === 'skipped' ? 'Unskip' : 'Skip'}><span className="skip-icon">{session.status === 'skipped' ? '↩' : '⏭'}</span></button>{isRemoving ? <button onClick={onRemove} title="Confirm remove" style={{ color: '#c05b46' }}><Trash2 size={15} /></button> : <button onClick={onRemove} title="Remove"><X size={15} /></button>}</div></div></div>; }
function CalendarEventRow({ event, last }: { event: CalendarEvent; last: boolean }) { return <div className="session calendar-event"><div className="time"><b>{event.allDay ? 'All day' : event.startTime}</b>{!event.allDay && <span>{event.endTime}</span>}</div><div className="rail"><span className="cal-icon"><CalendarDays size={13} /></span>{!last && <i />}</div><div className="session-body"><div><h3>{event.title}</h3><p><span className="tag cal-tag">Google Calendar</span>{event.location && <span className="cal-location"><MapPin size={11} />{event.location}</span>}</p></div></div></div>; }
function MiniTarget({ doc, week, target }: { doc: PlannerDocument; week: WeekRecord; target: WeeklyTarget }) { const metrics = targetMetrics(doc, week, target), state = statusFor(metrics); return <div className="mini-target"><div><span className="cat-dot" style={{ background: cat(target.category).dot }} /><b>{target.label}</b><em className={state[1]}>{state[0]}</em></div><p>{metrics.done} done · {metrics.planned} planned · {metrics.remaining} remaining · {metrics.target} target</p><Progress value={Math.min(100, metrics.done / Math.max(1, metrics.target) * 100)} /></div>; }
function Diff({ change }: { change: ProposalChange }) { const names: Record<ProposalChange['action'], string> = { add: 'Add', remove: 'Remove', move: 'Move', shorten: 'Resize', 'update-goal': 'Priority', 'update-target': 'Weekly target', 'add-commitment': 'Fixed commitment' }; return <article className={`proposal-change ${change.action}`}><div className="change-type">{names[change.action]}</div><div><h3>{change.label}</h3><p>{change.from && <><span>{change.from}</span><ArrowRight /></>}<span>{change.to || (change.session ? `${change.session.date} · ${change.session.start}–${endTime(change.session.start, change.session.duration)}` : '')}</span></p></div></article>; }

function scoreColor(score: number) { if (score <= 3) return '#c05b46'; if (score <= 6) return '#d0a04d'; if (score <= 8) return '#4b856c'; return '#2d8a56'; }
function ReviewCard({ review, onEdit }: { review: Review; onEdit: () => void }) {
  return <div className="review-card"><div className="review-card-head"><span className="review-score-badge" style={{ background: scoreColor(review.score) }}>{review.score}/10</span><button className="text-button" onClick={onEdit}>Edit</button></div>
    {review.win && <div className="review-line"><Check size={14} /><span>{review.win}</span></div>}
    {(review.struggle || review.blocker) && <div className="review-line review-struggle"><X size={14} /><span>{review.struggle || review.blocker}</span></div>}
    {review.carryForward && <div className="review-line review-carry"><ArrowRight size={14} /><span>{review.carryForward}</span></div>}
  </div>;
}

function WeekView({ doc, setDoc, weekId, currentWeekId, onWeek, onDate, onReplan }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; weekId: string; currentWeekId: string; onWeek: (weekId: string) => void; onDate: (date: string) => void; onReplan: () => void }) {
  const week = getWeek(doc, weekId) ?? { weekId, startDate: weekId, endDate: endOfIsoWeek(weekId), targets: doc.weeklyTargetTemplates, createdAt: '', source: 'rollover' as const };
  const relation = weekId === currentWeekId ? 'Current week' : weekId < currentWeekId ? 'Previous week' : 'Future week', days = Array.from({ length: 7 }, (_, index) => addLocalDays(weekId, index));
  const weekReviews = doc.reviews.filter(r => days.includes(r.date));
  const avgScore = weekReviews.length ? Math.round(weekReviews.reduce((sum, r) => sum + r.score, 0) / weekReviews.length * 10) / 10 : null;
  return <section className="page-section"><div className="week-nav"><button onClick={() => onWeek(addLocalDays(weekId, -7))}><ChevronLeft /> Previous week</button><div><span>{relation}</span><b>{formatWeekRange(weekId)}</b></div><button onClick={() => onWeek(addLocalDays(weekId, 7))}>Next week <ChevronRight /></button></div>{weekId !== currentWeekId && <button className="back-current" onClick={() => onWeek(currentWeekId)}><RefreshCw /> Back to current week</button>}
    <div className="page-title"><div><div className="eyebrow">{relation}{avgScore !== null && <span className="week-avg-score" style={{ color: scoreColor(avgScore) }}> · Avg: {avgScore}/10</span>}</div><h1>Targets & plan</h1><p>Progress is calculated only from {week.startDate} through {week.endDate}.</p></div><Button onClick={onReplan}><Sparkles /> Balance this week</Button></div>
    <div className="week-table"><div className="table-head"><span>Goal</span><span>Target</span><span>Done</span><span>Planned</span><span>Remaining</span><span>Status</span></div>{week.targets.map(target => { const metrics = targetMetrics(doc, week, target), state = statusFor(metrics); return <div className="target-row" key={target.id}><div><span className="cat-dot" style={{ background: cat(target.category).dot }} /><div><b>{target.label}</b><small>P{target.priority} · {target.unit}</small></div></div><input aria-label={`${target.label} target`} type="number" value={target.target} onChange={event => setDoc(current => ({ ...current, weeks: current.weeks.map(item => item.weekId === weekId ? { ...item, targets: item.targets.map(candidate => candidate.id === target.id ? { ...candidate, target: Number(event.target.value) } : candidate) } : item) }))} /><strong>{metrics.done}</strong><strong>{metrics.planned}</strong><strong>{metrics.remaining}</strong><em className={state[1]}>{state[0]}</em></div>; })}</div>
    <div className="week-days"><div className="section-label">Plan by date</div>{days.map(date => { const sessions = doc.sessions.filter(session => session.date === date && session.status !== 'skipped').sort((a, b) => mins(a.start) - mins(b.start)); const dayReview = doc.reviews.find(r => r.date === date); return <button key={date} onClick={() => onDate(date)}><div><b>{parseLocalDate(date).toLocaleDateString('en-GB', { weekday: 'short' })}</b><span>{parseLocalDate(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>{dayReview && <span className="week-day-score" style={{ color: scoreColor(dayReview.score) }}>{dayReview.score}</span>}</div><p>{sessions.length ? sessions.map(session => `${session.start} ${session.title}`).join(' · ') : 'No sessions planned'}</p><ChevronRight /></button>; })}</div>
  </section>;
}

function GoalsView({ doc, setDoc }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>> }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [gTitle, setGTitle] = useState('');
  const [gCategory, setGCategory] = useState('');
  const [gPriority, setGPriority] = useState<Priority>(2);
  const [gMeasure, setGMeasure] = useState('');
  const [gTarget, setGTarget] = useState(0);
  const [gUnit, setGUnit] = useState('hours');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [mDialogOpen, setMDialogOpen] = useState(false);
  const [editingMonthly, setEditingMonthly] = useState<typeof doc.monthlyTargets[0] | null>(null);
  const [mLabel, setMLabel] = useState('');
  const [mTarget, setMTarget] = useState(0);
  const [mUnit, setMUnit] = useState('count');
  const [mDeleteConfirm, setMDeleteConfirm] = useState<string | null>(null);
  const categories = doc.profile.customCategories ?? Object.keys(catMap);
  function openAdd() { setEditingGoal(null); setGTitle(''); setGCategory(categories[0] ?? 'personal'); setGPriority(2); setGMeasure(''); setGTarget(0); setGUnit('hours'); setDialogOpen(true); }
  function openEdit(goal: Goal) { const tpl = doc.weeklyTargetTemplates.find(t => t.goalId === goal.id); setEditingGoal(goal); setGTitle(goal.title); setGCategory(goal.category); setGPriority(goal.priority); setGMeasure(goal.measure ?? ''); setGTarget(tpl?.target ?? 0); setGUnit(tpl?.unit ?? 'hours'); setDialogOpen(true); }
  function saveGoal() {
    if (!gTitle.trim()) return;
    if (editingGoal) {
      const gid = editingGoal.id;
      setDoc(c => ({ ...c, goals: c.goals.map(g => g.id === gid ? { ...g, title: gTitle.trim(), category: gCategory, priority: gPriority, measure: gMeasure.trim() } : g), weeklyTargetTemplates: c.weeklyTargetTemplates.map(t => t.goalId === gid ? { ...t, label: gTitle.trim(), category: gCategory, priority: gPriority, target: gTarget, unit: gUnit } : t), weeks: c.weeks.map(w => ({ ...w, targets: w.targets.map(t => t.goalId === gid ? { ...t, label: gTitle.trim(), category: gCategory, priority: gPriority, target: gTarget, unit: gUnit } : t) })) }));
    } else {
      const gid = `g-${crypto.randomUUID()}`, tid = `w-${crypto.randomUUID()}`;
      const tpl: WeeklyTarget = { id: tid, goalId: gid, label: gTitle.trim(), category: gCategory, priority: gPriority, target: gTarget, unit: gUnit };
      setDoc(c => ({ ...c, goals: [...c.goals, { id: gid, title: gTitle.trim(), category: gCategory, priority: gPriority, active: true, measure: gMeasure.trim() }], weeklyTargetTemplates: [...c.weeklyTargetTemplates, tpl], weeks: c.weeks.map(w => ({ ...w, targets: [...w.targets, { ...tpl }] })) }));
    }
    setDialogOpen(false);
  }
  function deleteGoal(id: string) {
    const linked = doc.sessions.filter(s => s.goalId === id && s.status === 'planned').length;
    if (linked > 0 && deleteConfirm !== id) { setDeleteConfirm(id); return; }
    setDoc(c => ({ ...c, goals: c.goals.filter(g => g.id !== id), weeklyTargetTemplates: c.weeklyTargetTemplates.filter(t => t.goalId !== id), weeks: c.weeks.map(w => ({ ...w, targets: w.targets.filter(t => t.goalId !== id) })) }));
    setDeleteConfirm(null);
  }
  function openAddMonthly() { setEditingMonthly(null); setMLabel(''); setMTarget(0); setMUnit('count'); setMDialogOpen(true); }
  function openEditMonthly(mt: typeof doc.monthlyTargets[0]) { setEditingMonthly(mt); setMLabel(mt.label); setMTarget(mt.target); setMUnit(mt.unit); setMDialogOpen(true); }
  function saveMonthly() {
    if (!mLabel.trim() || mTarget <= 0) return;
    if (editingMonthly) {
      const mid = editingMonthly.id;
      setDoc(c => ({ ...c, monthlyTargets: c.monthlyTargets.map(m => m.id === mid ? { ...m, label: mLabel.trim(), target: mTarget, unit: mUnit } : m) }));
    } else {
      const now = new Date(), month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      setDoc(c => ({ ...c, monthlyTargets: [...c.monthlyTargets, { id: `m-${crypto.randomUUID()}`, month, label: mLabel.trim(), target: mTarget, unit: mUnit, done: 0 }] }));
    }
    setMDialogOpen(false);
  }
  function deleteMonthly(id: string) {
    if (mDeleteConfirm !== id) { setMDeleteConfirm(id); return; }
    setDoc(c => ({ ...c, monthlyTargets: c.monthlyTargets.filter(m => m.id !== id) }));
    setMDeleteConfirm(null);
  }
  function updateMonthlyDone(id: string, done: number) { setDoc(c => ({ ...c, monthlyTargets: c.monthlyTargets.map(m => m.id === id ? { ...m, done: Math.max(0, done) } : m) })); }
  return <section className="page-section">
    <div className="page-title"><div><div className="eyebrow">Direction</div><h1>Goals</h1><p>Add, edit, or remove goals. Priorities decide what survives when the week cannot hold everything.</p></div><Button onClick={openAdd}><Plus /> New goal</Button></div>
    {doc.goals.length === 0 && <div className="empty-goals"><Target size={32} /><b>No goals yet</b><p>Add your first goal to start planning.</p></div>}
    <div className="goal-grid">{doc.goals.map(goal => { const tpl = doc.weeklyTargetTemplates.find(t => t.goalId === goal.id); return <article className="goal-card" key={goal.id}>
      <div className="goal-top"><span style={{ background: cat(goal.category).pale, color: cat(goal.category).dot }}>{cat(goal.category).label}</span><div className="goal-actions"><button onClick={() => openEdit(goal)} title="Edit"><Settings2 size={15} /></button>{deleteConfirm === goal.id ? <button onClick={() => deleteGoal(goal.id)} title="Confirm delete" style={{ color: '#c05b46' }}><Trash2 size={15} /></button> : <button onClick={() => setDeleteConfirm(goal.id)} title="Delete"><X size={15} /></button>}</div></div>
      <h2>{goal.title}</h2>
      <p>{goal.measure}</p>
      {tpl && <div className="goal-target-info">{tpl.target} {tpl.unit}/week</div>}
      <div className="goal-bottom"><div className="priority-select"><span>Priority</span>{([1, 2, 3] as const).map(priority => <button key={priority} className={goal.priority === priority ? 'selected' : ''} onClick={() => setDoc(current => ({ ...current, goals: current.goals.map(item => item.id === goal.id ? { ...item, priority } : item) }))}>P{priority}</button>)}</div><label><input type="checkbox" checked={goal.active} onChange={event => setDoc(current => ({ ...current, goals: current.goals.map(item => item.id === goal.id ? { ...item, active: event.target.checked } : item) }))} />Active</label></div>
    </article>; })}</div>
    <div className="monthly"><div className="monthly-head"><div className="section-label">This month</div><button className="monthly-add-btn" onClick={openAddMonthly}><Plus size={14} /> Add monthly goal</button></div>
      {doc.monthlyTargets.length === 0 && <div className="empty-goals" style={{ padding: '28px 16px' }}><Target size={24} /><b>Add your first monthly goal</b></div>}
      {doc.monthlyTargets.map(mt => <div className="monthly-item" key={mt.id}>
        <div className="monthly-item-top"><b>{mt.label}</b><div className="goal-actions"><button onClick={() => openEditMonthly(mt)} title="Edit"><Settings2 size={14} /></button>{mDeleteConfirm === mt.id ? <button onClick={() => deleteMonthly(mt.id)} title="Confirm delete" style={{ color: '#c05b46' }}><Trash2 size={14} /></button> : <button onClick={() => setMDeleteConfirm(mt.id)} title="Delete"><X size={14} /></button>}</div></div>
        <div className="monthly-progress"><button className="monthly-step" onClick={() => updateMonthlyDone(mt.id, mt.done - 1)} disabled={mt.done <= 0}>-</button><input type="number" className="monthly-done-input" value={mt.done} onChange={e => updateMonthlyDone(mt.id, Number(e.target.value))} min={0} max={mt.target * 10} /><span>/ {mt.target} {mt.unit}</span><button className="monthly-step" onClick={() => updateMonthlyDone(mt.id, mt.done + 1)}>+</button></div>
        <Progress value={Math.min(100, mt.target > 0 ? mt.done / mt.target * 100 : 0)} />
      </div>)}
    </div>
    <Dialog open={mDialogOpen} onOpenChange={setMDialogOpen}><DialogContent className="checkin-dialog"><DialogHeader className="checkin-header"><DialogTitle className="checkin-title">{editingMonthly ? 'Edit monthly goal' : 'New monthly goal'}</DialogTitle><DialogDescription className="checkin-date">{editingMonthly ? 'Update your monthly target' : 'What do you want to achieve this month?'}</DialogDescription></DialogHeader><div className="checkin-fields">
      <label className="checkin-field"><span className="checkin-label">Goal name</span><Input value={mLabel} onChange={e => setMLabel(e.target.value)} placeholder="e.g. Submit 15 applications" className="checkin-input" /></label>
      <div className="goal-target-row"><label className="checkin-field" style={{ flex: 1 }}><span className="checkin-label">Target</span><Input type="number" value={mTarget || ''} onChange={e => setMTarget(Number(e.target.value))} className="checkin-input" placeholder="0" /></label><label className="checkin-field" style={{ flex: 1 }}><span className="checkin-label">Unit</span><Input value={mUnit} onChange={e => setMUnit(e.target.value)} className="checkin-input" placeholder="count" /></label></div>
    </div><DialogFooter className="checkin-footer"><Button className="checkin-submit" onClick={saveMonthly} disabled={!mLabel.trim() || mTarget <= 0}>{editingMonthly ? 'Save changes' : 'Add goal'}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogContent className="checkin-dialog"><DialogHeader className="checkin-header"><DialogTitle className="checkin-title">{editingGoal ? 'Edit goal' : 'New goal'}</DialogTitle><DialogDescription className="checkin-date">{editingGoal ? 'Update your goal details' : 'Define what you want to achieve'}</DialogDescription></DialogHeader><div className="checkin-fields">
      <label className="checkin-field"><span className="checkin-label">Goal name</span><Input value={gTitle} onChange={e => setGTitle(e.target.value)} placeholder="e.g. Learn Dutch B1" className="checkin-input" /></label>
      <label className="checkin-field"><span className="checkin-label">Category</span><select className="goal-select" value={gCategory} onChange={e => setGCategory(e.target.value)}>{categories.map(c => <option key={c} value={c}>{cat(c).label}</option>)}</select></label>
      <div className="checkin-field"><span className="checkin-label">Priority</span><div className="checkin-energy">{([1, 2, 3] as const).map(p => <button key={p} className={`checkin-energy-btn ${gPriority === p ? 'selected' : ''}`} onClick={() => setGPriority(p)}>P{p}</button>)}</div></div>
      <label className="checkin-field"><span className="checkin-label">How do you measure progress?</span><Input value={gMeasure} onChange={e => setGMeasure(e.target.value)} placeholder="e.g. Study hours, Applications sent" className="checkin-input" /></label>
      <div className="goal-target-row"><label className="checkin-field" style={{ flex: 1 }}><span className="checkin-label">Weekly target</span><Input type="number" value={gTarget || ''} onChange={e => setGTarget(Number(e.target.value))} className="checkin-input" placeholder="0" /></label><label className="checkin-field" style={{ flex: 1 }}><span className="checkin-label">Unit</span><Input value={gUnit} onChange={e => setGUnit(e.target.value)} className="checkin-input" placeholder="hours" /></label></div>
    </div><DialogFooter className="checkin-footer"><Button className="checkin-submit" onClick={saveGoal} disabled={!gTitle.trim()}>{editingGoal ? 'Save changes' : 'Add goal'}</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}

function MonthView({ doc, selectedDate, localToday, onDate }: { doc: PlannerDocument; selectedDate: string; localToday: string; onDate: (date: string) => void }) { const selected = parseLocalDate(selectedDate), days = new Date(selected.getFullYear(), selected.getMonth() + 1, 0).getDate(), first = new Date(selected.getFullYear(), selected.getMonth(), 1).getDay(); return <section className="page-section"><div className="page-title"><div><div className="eyebrow">Monthly plan</div><h1>{selected.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h1><p>Select any date to open the exact plan in Day view.</p></div></div><div className="calendar"><div className="cal-head">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <span key={day}>{day}</span>)}</div><div className="cal-grid">{Array.from({ length: first }, (_, index) => <div key={`empty-${index}`} />)}{Array.from({ length: days }, (_, index) => { const date = `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`, sessions = doc.sessions.filter(session => session.date === date && session.status !== 'skipped'); return <button key={date} onClick={() => onDate(date)} className={`${date === localToday ? 'today' : ''} ${date === selectedDate ? 'selected-date' : ''}`}><b>{index + 1}</b><span>{sessions.slice(0, 3).map(session => <i key={session.id} style={{ background: cat(session.category).dot }} />)}</span>{sessions.length > 0 && <small>{sessions.filter(session => session.status === 'done').length}/{sessions.length}</small>}</button>; })}</div></div></section>; }

function ProfileView({ doc, setDoc, onMemory, onExport, onImport }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; onMemory: (id: string, status: 'approved' | 'rejected') => void; onExport: () => void; onImport: () => void }) {
  const [newPref, setNewPref] = useState('');
  const [newCat, setNewCat] = useState('');
  const [calSyncing, setCalSyncing] = useState(false), [calError, setCalError] = useState(''), [calCount, setCalCount] = useState<number | null>(null);
  const up = (u: Partial<typeof doc.profile>) => setDoc(c => ({ ...c, profile: { ...c.profile, ...u } }));
  const categories = doc.profile.customCategories ?? Object.keys(catMap);
  const removePref = (p: string) => up({ preferences: doc.profile.preferences.filter(x => x !== p) });
  const addPref = () => { if (newPref.trim()) { up({ preferences: [...doc.profile.preferences, newPref.trim()] }); setNewPref(''); } };
  const addCat = () => { const v = newCat.trim().toLowerCase().replace(/\s+/g, '-'); if (v && !categories.includes(v)) { up({ customCategories: [...categories, v] }); setNewCat(''); } };
  const removeCat = (c: string) => up({ customCategories: categories.filter(x => x !== c) });
  async function syncCalendar() {
    setCalSyncing(true); setCalError(''); setCalCount(null);
    try {
      const res = await fetch('/api/calendar', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json() as { ok?: boolean; count?: number; error?: string };
      if (!res.ok || !data.ok) { setCalError(data.error || 'Sync failed'); return; }
      setCalCount(data.count ?? 0);
      const stateRes = await fetch(`/api/state?localDate=${doc.lastOpenedLocalDate}`, { cache: 'no-store', credentials: 'same-origin' });
      if (stateRes.ok) { const payload = await stateRes.json() as { document: unknown }; setDoc(migratePlannerData(payload.document, doc.lastOpenedLocalDate)); }
    } catch { setCalError('Network error. Try again.'); } finally { setCalSyncing(false); }
  }
  const lastSync = doc.profile.calendarLastSync;
  const syncAge = lastSync ? (Date.now() - new Date(lastSync).getTime()) / 3600_000 : Infinity;
  const syncDot = !doc.profile.calendarIcsUrl ? 'cal-dot-none' : syncAge < 6 ? 'cal-dot-ok' : syncAge < 24 ? 'cal-dot-stale' : 'cal-dot-none';
  return <section className="page-section">
    <div className="page-title"><div><div className="eyebrow">Settings</div><h1>Profile & preferences</h1><p>All fields are used by the AI planner. Fill in what's relevant to you.</p></div></div>
    <div className="settings-grid">
      <article>
        <h2>Identity</h2>
        <div className="form-grid"><label>Display name<Input value={doc.profile.name} onChange={e => up({ name: e.target.value })} /></label><label>Timezone<Input value={doc.profile.timezone} onChange={e => up({ timezone: e.target.value })} /></label></div>
        <h2 className="profile-section-title">Daily structure</h2>
        <div className="form-grid"><label>Wake-up time<Input type="time" value={doc.profile.wakeTime} onChange={e => up({ wakeTime: e.target.value })} /></label><label>Bedtime<Input type="time" value={doc.profile.sleepTime} onChange={e => up({ sleepTime: e.target.value })} /></label><label>Max productive hours<Input type="number" value={doc.profile.dailyFocusCapacityHours} onChange={e => up({ dailyFocusCapacityHours: Number(e.target.value) })} /></label><label>Deep work preference<select className="profile-select" value={doc.profile.deepWorkPreference ?? ''} onChange={e => up({ deepWorkPreference: (e.target.value as 'morning' | 'afternoon' | 'evening') || undefined })}><option value="">Not set</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option><option value="evening">Evening</option></select></label><label>Morning or evening type<select className="profile-select" value={doc.profile.morningPerson === undefined ? '' : doc.profile.morningPerson ? 'yes' : 'no'} onChange={e => up({ morningPerson: e.target.value === '' ? undefined : e.target.value === 'yes' })}><option value="">Not set</option><option value="yes">Morning type</option><option value="no">Evening type</option></select></label></div>
        <h2 className="profile-section-title">Constraints</h2>
        <div className="form-grid single-col"><label>Work schedule<Textarea value={doc.profile.workSchedule ?? ''} onChange={e => up({ workSchedule: e.target.value })} placeholder="e.g. Restaurant shifts Tue/Thu evenings" rows={2} /></label><label>Fixed commitments<Textarea value={doc.profile.fixedCommitments ?? ''} onChange={e => up({ fixedCommitments: e.target.value })} placeholder="e.g. Dutch class Wednesday 14:00-15:30" rows={2} /></label><label>Days unavailable<Textarea value={doc.profile.unavailableDays ?? ''} onChange={e => up({ unavailableDays: e.target.value })} placeholder="e.g. Saturdays family day" rows={2} /></label></div>
        <h2 className="profile-section-title">Fitness</h2>
        <div className="form-grid"><label>Gym days/week<Input type="number" min={0} max={7} value={doc.profile.gymDaysPerWeek ?? ''} onChange={e => up({ gymDaysPerWeek: e.target.value ? Number(e.target.value) : undefined })} /></label><label>Run days/week<Input type="number" min={0} max={7} value={doc.profile.runDaysPerWeek ?? ''} onChange={e => up({ runDaysPerWeek: e.target.value ? Number(e.target.value) : undefined })} /></label><label>Workout time<select className="profile-select" value={doc.profile.workoutTimePreference ?? ''} onChange={e => up({ workoutTimePreference: (e.target.value as 'morning' | 'afternoon' | 'evening') || undefined })}><option value="">Not set</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option><option value="evening">Evening</option></select></label></div>
        <h2 className="profile-section-title">Google Calendar</h2>
        <div className="form-grid single-col">
          <label>Secret iCal URL<Input value={doc.profile.calendarIcsUrl ?? ''} onChange={e => up({ calendarIcsUrl: e.target.value })} placeholder="Paste your secret iCal URL here" /></label>
          <p className="cal-help">Go to Google Calendar {'→'} Settings {'→'} your calendar {'→'} {'“'}Secret address in iCal format{'”'} {'→'} copy and paste here</p>
        </div>
        <div className="cal-sync-row"><Button size="sm" variant="outline" onClick={syncCalendar} disabled={calSyncing || !doc.profile.calendarIcsUrl}><RefreshCw size={14} className={calSyncing ? 'spin' : ''} />{calSyncing ? 'Syncing...' : 'Sync now'}</Button><span className={`cal-status ${syncDot}`}>{lastSync ? `Last synced ${syncAge < 1 ? 'just now' : syncAge < 24 ? `${Math.round(syncAge)}h ago` : new Date(lastSync).toLocaleDateString()}` : 'Never synced'}</span></div>
        {calError && <p className="cal-error">{calError}</p>}
        {calCount !== null && !calError && <p className="cal-success">{calCount} event{calCount !== 1 ? 's' : ''} synced for the next 14 days</p>}
      </article>
      <article>
        <h2>AI planning preferences</h2>
        <div className="form-grid single-col"><label>Cooking<select className="profile-select" value={doc.profile.cookingPreference ?? ''} onChange={e => up({ cookingPreference: e.target.value || undefined })}><option value="">Not set</option><option value="every-meal">I cook every meal</option><option value="once-daily">I cook once a day</option><option value="minimal">I don't cook much</option></select></label><label>Breaks<select className="profile-select" value={doc.profile.breakPreference ?? ''} onChange={e => up({ breakPreference: e.target.value || undefined })}><option value="">Not set</option><option value="frequent">I need breaks between tasks</option><option value="long-blocks">I can work in long blocks</option></select></label><label>Evenings<select className="profile-select" value={doc.profile.eveningPreference ?? ''} onChange={e => up({ eveningPreference: e.target.value || undefined })}><option value="">Not set</option><option value="free">Free evenings for rest</option><option value="flexible">I can work evenings</option></select></label><label>Planning style<select className="profile-select" value={doc.profile.planningStyle ?? ''} onChange={e => up({ planningStyle: e.target.value || undefined })}><option value="">Not set</option><option value="strict">Give me a tight schedule</option><option value="flexible">Keep it flexible with buffer time</option></select></label><label>Context for AI<Textarea value={doc.profile.context} onChange={e => up({ context: e.target.value })} placeholder="Any other context the planner should know about you" rows={3} /></label></div>
        <h2 className="profile-section-title">Categories</h2>
        <div className="category-list">{categories.map(c => <div key={c} className="category-item"><span className="cat-dot" style={{ background: cat(c).dot }} /><span>{cat(c).label}</span><button onClick={() => removeCat(c)} title="Remove"><X size={13} /></button></div>)}</div>
        <div className="category-add"><Input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="New category name" onKeyDown={e => { if (e.key === 'Enter') addCat(); }} /><Button size="sm" onClick={addCat} disabled={!newCat.trim()}>Add</Button></div>
        <h2 className="profile-section-title">Saved preferences</h2>
        <ul className="pref-list">{doc.profile.preferences.map(pref => <li key={pref}><Check /><span>{pref}</span><button onClick={() => removePref(pref)} className="pref-remove" title="Remove"><X size={13} /></button></li>)}</ul>
        <div className="pref-add"><Input value={newPref} onChange={e => setNewPref(e.target.value)} placeholder="Add a new preference" onKeyDown={e => { if (e.key === 'Enter') addPref(); }} /><Button size="sm" onClick={addPref} disabled={!newPref.trim()}>Add</Button></div>
        <h2 className="profile-section-title">Suggested memories</h2>
        {doc.memories.filter(m => m.status === 'pending').map(m => <div className="memory" key={m.id}><Sparkles /><div><b>{m.text}</b><p>{m.reason}</p><div><Button size="sm" onClick={() => onMemory(m.id, 'approved')}>Yes, remember this</Button><Button size="sm" variant="ghost" onClick={() => onMemory(m.id, 'rejected')}>No</Button></div></div></div>)}
        <h2 className="data-title">Your data</h2><p>Cloud sync is primary. JSON remains available for backup and migration.</p><div className="data-actions"><Button variant="outline" onClick={onExport}><Download /> Export JSON</Button><Button variant="outline" onClick={onImport}><Upload /> Import V3, V4, or V5</Button></div>
      </article>
    </div>
  </section>;
}

const TASKS_PER_CATEGORY = 4;
const DEFAULT_CATEGORIES: string[] = ['sabzapply', 'internship', 'fitness', 'dutch', 'learning', 'cooking', 'personal', 'work'];
function deadlineStatus(deadline: string | null, localToday: string): { label: string; cls: string } | null {
  if (!deadline) return null;
  const diff = (parseLocalDate(deadline).getTime() - parseLocalDate(localToday).getTime()) / 86_400_000;
  if (diff < 0) return { label: `Overdue ${Math.abs(Math.round(diff))}d`, cls: 'deadline-overdue' };
  if (diff === 0) return { label: 'Due today', cls: 'deadline-today' };
  if (diff === 1) return { label: 'Due tomorrow', cls: 'deadline-today' };
  if (diff <= 3) return { label: `Due in ${Math.round(diff)}d`, cls: 'deadline-soon' };
  return { label: deadline.slice(5), cls: 'deadline-later' };
}
function groupByCategory(tasks: OngoingTask[], sortMode: 'priority' | 'deadline' = 'priority') {
  const groups: Record<string, OngoingTask[]> = {};
  for (const task of tasks) { (groups[task.category] ??= []).push(task); }
  for (const key of Object.keys(groups)) {
    if (sortMode === 'deadline') {
      groups[key].sort((a, b) => { const da = a.deadline ?? '￿', db = b.deadline ?? '￿'; return da !== db ? da.localeCompare(db) : a.priority - b.priority; });
    } else {
      groups[key].sort((a, b) => a.priority !== b.priority ? a.priority - b.priority : (a.deadline ?? '￿').localeCompare(b.deadline ?? '￿'));
    }
  }
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
  const toggleDone = () => setDoc(c => ({ ...c, ongoingTasks: c.ongoingTasks.map(t => t.id === task.id ? { ...t, done: !t.done, completedAt: t.done ? null : new Date().toISOString() } : t) }));
  const bumpPriority = () => setDoc(c => ({ ...c, ongoingTasks: c.ongoingTasks.map(t => t.id === task.id ? { ...t, priority: (t.priority === 1 ? 3 : t.priority - 1) as Priority } : t) }));
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
      <button className={`ongoing-badge p${task.priority}`} onClick={bumpPriority} title="Cycle priority">P{task.priority}</button>
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

function AddTaskForm({ onAdd, categories }: { onAdd: (task: Omit<OngoingTask, 'id' | 'createdAt'>) => void; categories: string[] }) {
  const [open, setOpen] = useState(false);
  const cats = categories.length ? categories : DEFAULT_CATEGORIES;
  const [text, setText] = useState(''), [category, setCategory] = useState<Category>(cats[0] ?? 'personal'), [priority, setPriority] = useState<Priority>(2), [deadline, setDeadline] = useState('');
  const submit = () => { if (!text.trim()) return; onAdd({ text: text.trim(), done: false, deadline: deadline || null, category, priority }); setText(''); setDeadline(''); setOpen(false); };
  if (!open) return <button onClick={() => setOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#526e63', fontSize: 13, fontWeight: 600, marginTop: 8 }}><Plus size={15} /> Add task</button>;
  return <div className="add-task-form">
    <div className="add-task-row"><Input value={text} onChange={e => setText(e.target.value)} placeholder="Task description" onKeyDown={e => { if (e.key === 'Enter') submit(); }} /></div>
    <div className="add-task-row">
      <select value={category} onChange={e => setCategory(e.target.value as Category)}>{cats.map(c => <option key={c} value={c}>{cat(c).label}</option>)}</select>
      <select value={priority} onChange={e => setPriority(Number(e.target.value) as Priority)}><option value={1}>P1 — Must</option><option value={2}>P2 — Should</option><option value={3}>P3 — Nice</option></select>
      <Input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} style={{ width: 145 }} />
      <Button size="sm" onClick={submit}>Add</Button>
      <button onClick={() => setOpen(false)}><X size={14} /></button>
    </div>
  </div>;
}

function OngoingSection({ doc, setDoc, selectedDate, localToday, compact }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; selectedDate: string; localToday: string; compact?: boolean }) {
  const [showCompleted, setShowCompleted] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const active = doc.ongoingTasks.filter(t => !t.done), done = doc.ongoingTasks.filter(t => t.done);
  const groups = groupByCategory(active);
  const addTask = (task: Omit<OngoingTask, 'id' | 'createdAt'>) => setDoc(c => ({ ...c, ongoingTasks: [...c.ongoingTasks, { ...task, id: `ongoing-${crypto.randomUUID()}`, createdAt: new Date().toISOString() }] }));
  return <div className="ongoing-section">
    <div className="ongoing-head"><div className="section-label"><ListTodo size={14} /> Ongoing tasks</div><span style={{ fontSize: 12, color: '#8b8a83' }}>{active.length} active{done.length ? ` · ${done.length} done` : ''}</span></div>
    {groups.map(([category, tasks]) => { const isExpanded = expanded[category] ?? false; const visible = isExpanded ? tasks : tasks.slice(0, TASKS_PER_CATEGORY); const hidden = tasks.length - TASKS_PER_CATEGORY; return <div key={category} className="ongoing-group">
      <div className="ongoing-group-header"><span className="cat-dot" style={{ background: cat(category).dot }} />{cat(category).label}</div>
      {visible.map(task => <OngoingTaskRow key={task.id} task={task} doc={doc} setDoc={setDoc} selectedDate={selectedDate} localToday={localToday} />)}
      {hidden > 0 && <button className="show-more-toggle" onClick={() => setExpanded(prev => ({ ...prev, [category]: !isExpanded }))}>{isExpanded ? <><ChevronDown size={14} /> Show less</> : <><ChevronRight size={14} /> Show {hidden} more</>}</button>}
    </div>; })}
    {!groups.length && !done.length && <div style={{ padding: '16px 0', color: '#8b8a83', fontSize: 13 }}>No ongoing tasks yet. Add one below.</div>}
    <AddTaskForm onAdd={addTask} categories={doc.profile.customCategories ?? DEFAULT_CATEGORIES} />
    {done.length > 0 && <button className="completed-toggle" onClick={() => setShowCompleted(!showCompleted)}>{showCompleted ? <ChevronDown /> : <ChevronRight />} Show {done.length} completed</button>}
    {showCompleted && done.map(task => <OngoingTaskRow key={task.id} task={task} doc={doc} setDoc={setDoc} selectedDate={selectedDate} localToday={localToday} />)}
  </div>;
}

function QuickAdd({ category, onAdd }: { category: string; onAdd: (task: Omit<OngoingTask, 'id' | 'createdAt'>) => void }) {
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<Priority>(2);
  const [deadline, setDeadline] = useState('');
  const submit = () => { if (!text.trim()) return; onAdd({ text: text.trim(), done: false, deadline: deadline || null, category, priority }); setText(''); setDeadline(''); setPriority(2); };
  return <div className="quick-add"><input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} placeholder="Add task…" className="quick-add-input" /><button className={`quick-add-priority p${priority}`} onClick={() => setPriority(p => (p === 3 ? 1 : p + 1) as Priority)} title="Cycle priority">P{priority}</button><input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} className="quick-add-date" /><button className="quick-add-submit" onClick={submit} disabled={!text.trim()}><Plus size={14} /></button></div>;
}

function TasksView({ doc, setDoc, selectedDate, localToday }: { doc: PlannerDocument; setDoc: Dispatch<SetStateAction<PlannerDocument>>; selectedDate: string; localToday: string }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'p1' | 'due-soon' | 'overdue'>('all');
  const [sortMode, setSortMode] = useState<'priority' | 'deadline'>('priority');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => { const t = setTimeout(() => setSearch(searchInput), 150); return () => clearTimeout(t); }, [searchInput]);

  const allActive = doc.ongoingTasks.filter(t => !t.done);
  const allDone = doc.ongoingTasks.filter(t => t.done);
  const overdueCount = allActive.filter(t => t.deadline && t.deadline < localToday).length;

  let filtered = allActive;
  if (search) filtered = filtered.filter(t => t.text.toLowerCase().includes(search.toLowerCase()));
  if (filter === 'p1') filtered = filtered.filter(t => t.priority === 1);
  else if (filter === 'due-soon') filtered = filtered.filter(t => { if (!t.deadline || t.deadline < localToday) return false; return (parseLocalDate(t.deadline).getTime() - parseLocalDate(localToday).getTime()) / 86_400_000 <= 7; });
  else if (filter === 'overdue') filtered = filtered.filter(t => t.deadline != null && t.deadline < localToday);

  const groups = groupByCategory(filtered, sortMode);
  const addTask = (task: Omit<OngoingTask, 'id' | 'createdAt'>) => setDoc(c => ({ ...c, ongoingTasks: [...c.ongoingTasks, { ...task, id: `ongoing-${crypto.randomUUID()}`, createdAt: new Date().toISOString() }] }));
  const restoreTask = (id: string) => setDoc(c => ({ ...c, ongoingTasks: c.ongoingTasks.map(t => t.id === id ? { ...t, done: false, completedAt: null } : t) }));

  return <section className="page-section">
    <div className="page-title"><div><div className="eyebrow">Backlog</div><h1>Ongoing tasks</h1><p>Tasks that aren't tied to a specific time slot.</p></div><button className="sort-toggle" onClick={() => setSortMode(m => m === 'priority' ? 'deadline' : 'priority')}><ArrowUpDown size={14} />{sortMode === 'priority' ? 'Priority' : 'Deadline'}</button></div>
    <div className="tasks-stats"><span><b>{allActive.length}</b> active</span>{overdueCount > 0 && <span style={{ color: '#c05b46' }}><b>{overdueCount}</b> overdue</span>}<span><b>{allDone.length}</b> completed</span></div>
    <div className="tasks-search"><Search size={16} /><input value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="Search tasks…" />{searchInput && <button onClick={() => setSearchInput('')} aria-label="Clear search"><X size={14} /></button>}</div>
    <div className="tasks-filter-bar"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'p1' ? 'active' : ''} onClick={() => setFilter('p1')}>P1</button><button className={filter === 'due-soon' ? 'active' : ''} onClick={() => setFilter('due-soon')}>Due soon</button><button className={filter === 'overdue' ? 'active' : ''} onClick={() => setFilter('overdue')}>Overdue</button></div>
    {groups.map(([category, tasks]) => { const isExpanded = expanded[category] ?? false; const visible = isExpanded ? tasks : tasks.slice(0, TASKS_PER_CATEGORY); const hidden = tasks.length - TASKS_PER_CATEGORY; return <div key={category} className="ongoing-group">
      <div className="ongoing-group-header"><span className="cat-dot" style={{ background: cat(category).dot }} />{cat(category).label}<span className="ongoing-group-count">{tasks.length}</span></div>
      <QuickAdd category={category} onAdd={addTask} />
      {visible.map(task => <OngoingTaskRow key={task.id} task={task} doc={doc} setDoc={setDoc} selectedDate={selectedDate} localToday={localToday} />)}
      {hidden > 0 && <button className="show-more-toggle" onClick={() => setExpanded(prev => ({ ...prev, [category]: !isExpanded }))}>{isExpanded ? <><ChevronDown size={14} /> Show less</> : <><ChevronRight size={14} /> Show {hidden} more</>}</button>}
    </div>; })}
    {!groups.length && <div style={{ padding: '32px 0', color: '#8b8a83', fontSize: 13, textAlign: 'center' }}>{search || filter !== 'all' ? 'No tasks match your filters.' : 'No ongoing tasks yet.'}</div>}
    {allDone.length > 0 && <div className="completed-section">
      <button className="completed-section-head" onClick={() => setShowCompleted(!showCompleted)}>{showCompleted ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Completed ({allDone.length})</button>
      {showCompleted && <div className="completed-list">{allDone.map(task => <div key={task.id} className="completed-row"><span className="completed-text">{task.text}</span><span className="completed-meta">{cat(task.category).label}{task.completedAt && <> &middot; {new Date(task.completedAt).toLocaleDateString()}</>}</span><button className="restore-btn" onClick={() => restoreTask(task.id)}><RotateCcw size={13} /> Restore</button></div>)}</div>}
    </div>}
  </section>;
}
