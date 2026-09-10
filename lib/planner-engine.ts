import { addLocalDays, endOfIsoWeek, isDateInWeek, startOfIsoWeek } from './date-utils';
import { getWeek, historicalPatterns, targetMetrics } from './week-metrics';
import type { PlanProposal, ProposalChange, ReplanRequest, Session } from './planner-types';

const id=(prefix:string)=>`${prefix}-${crypto.randomUUID()}`;
function proposal(req:ReplanRequest,title:string,summary:string,reasoning:string[],tradeoffs:string[],changes:ProposalChange[]):PlanProposal{return{id:id('proposal'),title,summary,reasoning,tradeoffs,changes,createdAt:new Date().toISOString(),selectedDate:req.selectedDate,weekId:startOfIsoWeek(req.selectedDate)}}
function parseTime(text:string){const m=text.match(/(?:from\s*)?(\d{1,2})(?::(\d{2}))?\s*(?:to|–|-)\s*(\d{1,2})(?::(\d{2}))?/i);if(!m)return null;const start=`${m[1].padStart(2,'0')}:${(m[2]??'00').padStart(2,'0')}`,duration=Number(m[3])*60+Number(m[4]??0)-(Number(m[1])*60+Number(m[2]??0));return{start,duration:Math.max(30,duration)}}

export function buildPlannerContext(req:ReplanRequest){
  const doc=req.document,week=getWeek(doc,req.currentWeekId),planningWeek=getWeek(doc,startOfIsoWeek(req.selectedDate));
  const metrics=(planningWeek?.targets??doc.weeklyTargetTemplates).map(t=>({...t,...(planningWeek?targetMetrics(doc,planningWeek,t):{done:0,planned:0,remaining:t.target,coverage:0})}));
  const p=doc.profile,profileSummary=Object.entries({wake:p.wakeTime,sleep:p.sleepTime,morningPerson:p.morningPerson===true?'yes':p.morningPerson===false?'no':'',maxProductiveHours:p.dailyFocusCapacityHours,deepWorkPreference:p.deepWorkPreference||'',gymDaysPerWeek:p.gymDaysPerWeek,runDaysPerWeek:p.runDaysPerWeek,workoutTime:p.workoutTimePreference||'',cooking:p.cookingPreference||'',breaks:p.breakPreference||'',evenings:p.eveningPreference||'',planningStyle:p.planningStyle||'',workSchedule:p.workSchedule||'',fixedCommitments:p.fixedCommitments||'',unavailableDays:p.unavailableDays||''}).filter(([,v])=>v!==''&&v!==undefined&&v!==0).map(([k,v])=>`${k}: ${v}`).join(', ');
  const calendarEvents=(doc.calendarEvents??[]).filter(e=>isDateInWeek(e.date,startOfIsoWeek(req.selectedDate)));
  return{request:{trigger:req.trigger,message:req.message,modification:req.modification,selectedDate:req.selectedDate,currentLocalDate:req.currentLocalDate,timezone:req.timezone,relativeDateRule:`Interpret “this day” as ${req.selectedDate}; interpret “tomorrow” as ${addLocalDays(req.selectedDate,1)} unless the user explicitly says relative to today.`},profile:doc.profile,profileSummary,goals:doc.goals.filter(g=>g.active),monthlyTargets:doc.monthlyTargets,currentWeek:{weekId:req.currentWeekId,startDate:req.currentWeekId,endDate:endOfIsoWeek(req.currentWeekId),targets:week?.targets.map(t=>({...t,...targetMetrics(doc,week,t)}))??[]},planningWeek:{weekId:startOfIsoWeek(req.selectedDate),startDate:startOfIsoWeek(req.selectedDate),endDate:endOfIsoWeek(req.selectedDate),targets:metrics},selectedDaySessions:doc.sessions.filter(s=>s.date===req.selectedDate),weekSessions:doc.sessions.filter(s=>isDateInWeek(s.date,startOfIsoWeek(req.selectedDate))),fixedCommitments:doc.sessions.filter(s=>isDateInWeek(s.date,startOfIsoWeek(req.selectedDate))&&s.kind==='fixed'),calendarEvents,selectedDayCalendar:calendarEvents.filter(e=>e.date===req.selectedDate),flexibleTasks:doc.tasks.filter(t=>t.status==='active'),ongoingTasks:doc.ongoingTasks.filter(t=>!t.done),recentReviews:[...doc.reviews].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,14).map(r=>({date:r.date,score:r.score,win:r.win,struggle:r.struggle||r.blocker,carryForward:r.carryForward||''})),historicalPatterns:historicalPatterns(doc,req.currentWeekId),recentHistory:doc.history.slice(0,20),originalProposal:req.originalProposal};
}

export function deterministicPlan(req:ReplanRequest):PlanProposal{
  const base=req.selectedDate,msg=(req.modification??req.message??'').toLowerCase(),d=req.document;
  if(req.trigger==='modify'&&req.originalProposal){
    const original=req.originalProposal;
    if(/keep.*run/.test(msg)&&/move.*dutch/.test(msg)){
      const runIds=new Set(d.sessions.filter(s=>s.runType).map(s=>s.id));
      const retained=original.changes.filter(c=>!c.sessionId||!runIds.has(c.sessionId));
      const dutch=d.sessions.find(s=>s.date===base&&s.category==='dutch'&&s.kind==='flexible');
      const destination=Array.from({length:6},(_,index)=>addLocalDays(base,index+1)).find(date=>date<=endOfIsoWeek(base)&&!d.sessions.some(session=>session.date===date&&session.category==='dutch'))??addLocalDays(base,1);
      const change=dutch?{id:id('change'),action:'move' as const,sessionId:dutch.id,label:dutch.title,from:`${dutch.date} · ${dutch.start}`,to:`${destination} · 17:00`,patch:{date:destination,start:'17:00'}}:null;
      return proposal(req,'Revised plan update','The run stays where it is. Dutch moves instead, exactly as requested.',['The original proposal has not been applied.','Fixed commitments remain protected.'],[],[...retained.filter(c=>c.action!=='move'||!c.label.toLowerCase().includes('run')),...(change?[change]:[])]);
    }
    if(/don.t remove.*learning|keep.*learning/.test(msg))return proposal(req,'Revised plan update','Learning stays in the plan. The remaining changes are unchanged.',['The original proposal is still unapplied.'],[],original.changes.filter(c=>!c.label.toLowerCase().includes('learning')));
    if(/lighter/.test(msg)){const flexible=d.sessions.find(s=>s.date===base&&s.kind==='flexible');return proposal(req,'A lighter revised plan','I removed one optional flexible block from the selected day.',['The selected date—not today—defines “this day”.'],['This reduces planned progress for its goal.'],flexible?[{id:id('change'),action:'remove',sessionId:flexible.id,label:flexible.title,from:`${base} · ${flexible.start}`}]:[])}
    return proposal(req,'Revised plan update','I kept the original proposal available and revised it around your request.',['No part of the original proposal was applied.'],[],original.changes);
  }
  if(/dinner/.test(msg)&&/(tomorrow|\d{1,2}:\d{2})/.test(msg)){const time=parseTime(msg)??{start:'19:00',duration:180},date=/tomorrow/.test(msg)?addLocalDays(base,1):base,session:Session={id:id('commitment'),date,start:time.start,duration:time.duration,title:'Dinner',category:'personal',kind:'fixed',status:'planned'},overlap=d.sessions.find(s=>s.date===date&&s.kind==='flexible'&&s.start>=time.start),changes:ProposalChange[]=[{id:id('change'),action:'add-commitment',label:'Dinner',to:`${date} · ${time.start}–${endTime(time.start,time.duration)}`,session}];if(overlap)changes.push({id:id('change'),action:'move',sessionId:overlap.id,label:overlap.title,from:`${date} · ${overlap.start}`,to:`${addLocalDays(date,1)} · 17:00`,patch:{date:addLocalDays(date,1),start:'17:00'}});return proposal(req,'Protect the new commitment','Dinner becomes fixed and overlapping flexible work is rebalanced.',['Fixed commitments are protected before flexible sessions.'],['The destination day gains one flexible block.'],changes)}
  if(/lighter/.test(msg)){const flexible=d.sessions.filter(s=>s.date===base&&s.kind==='flexible').sort((a,b)=>b.duration-a.duration)[0];return proposal(req,'Make this day lighter',`I reduced the load on ${base} while protecting fixed commitments.`,['“This day” resolves to the date you are viewing.','The longest flexible block moves; meals and recovery stay.'],['The next day takes on some additional work.'],flexible?[{id:id('change'),action:'move',sessionId:flexible.id,label:flexible.title,from:`${base} · ${flexible.start}`,to:`${addLocalDays(base,1)} · 10:00`,patch:{date:addLocalDays(base,1),start:'10:00'}}]:[])}
  if(/(don.t want|skip|cancel).*(run|running)|not running/.test(msg)){const run=d.sessions.find(s=>s.date===base&&s.runType&&s.status==='planned'),date=addLocalDays(base,2);return proposal(req,'Rebalance training across the week','The run moves to a recovery-safe opening later in the selected week.',['The next day is not used automatically.','The long run stays protected.'],['A later day takes on the easy run.'],run?[{id:id('change'),action:'move',sessionId:run.id,label:run.title,from:`${base} · ${run.start}`,to:`${date} · 16:00`,patch:{date,start:'16:00'}}]:[])}
  const flexible=d.sessions.find(s=>s.date===base&&s.category==='sabzapply'&&s.kind==='flexible');return proposal(req,'Rebalance the selected day','The proposal protects priority work and keeps the selected day realistic.',['Completed work is separate from planned work.','Fixed commitments remain in place.','No change is applied before approval.'],[],flexible?[{id:id('change'),action:'shorten',sessionId:flexible.id,label:flexible.title,from:`${flexible.duration} min`,to:`${Math.max(60,flexible.duration-30)} min`,patch:{duration:Math.max(60,flexible.duration-30)}}]:[])}

function endTime(start:string,duration:number){const[h,m]=start.split(':').map(Number),n=h*60+m+duration;return`${String(Math.floor(n/60)%24).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`}
export const SYSTEM_PROMPT=`You are Amir's personal planning agent. You plan at the WEEK level: every proposal must consider all remaining days from the selectedDate through the end of the planning week (Sunday). Do not plan a single day in isolation — distribute work across the remaining week to hit weekly targets while respecting daily capacity.

WEEK-LEVEL MENTAL MODEL:
- planningWeek.targets shows each goal's weekly target, done, planned, remaining, and coverage. Use these to decide what still needs scheduling.
- weekSessions shows everything already scheduled this week. Check for gaps, overloads, and balance.
- historicalPatterns contains data from the last 4 weeks: completion rates per goal (and whether improving/declining), skip rates by day-of-week, duration accuracy per category, and review insights. Use this data — if a goal's completion rate is declining, front-load it. If Fridays have high skip rates, schedule less. If planned durations consistently overrun actuals, shorten blocks.
- When a session is completed or skipped, or after a review, recalculate what remains and redistribute across the rest of the week.

DATE INTERPRETATION:
Treat the supplied selectedDate as the reference for “this day”; follow the supplied relativeDateRule for “tomorrow”.

CONSTRAINTS (inviolable):
- Protect fixed commitments, meals, cooking, transitions, sleep and recovery.
- calendarEvents and selectedDayCalendar are synced from Google Calendar — immovable. Never schedule during a calendar event; leave a 15-minute buffer when possible.
- Respect the user's profile: wake/sleep times, deep work preference window, max productive hours, workout timing, fixed commitments, unavailable days.
- All schedule changes must stay inside the proposal week.
- Never proactively move or remove a fixed commitment. When the user explicitly reports a fixed commitment changed (e.g. “the meeting ran until 11:45”), set userReported: true on the move. Fixed commitments can never be removed.

PRIORITY AND ALLOCATION:
- Allocate scarce capacity P1 > P2 > P3, considering deadlines, weekly target remaining, historical completion rates, and training recovery.
- A missed recurring activity changes goal progress; never copy it mechanically to the next day — redistribute thoughtfully across remaining days.
- ongoingTasks are backlog items with optional deadlines; suggest scheduling sessions for high-priority or approaching-deadline tasks.

LEARNING FROM HISTORY:
- recentReviews (last 14 days): use carry-forward items, learn from struggles to avoid repeating them, note what days score highest.
- historicalPatterns.targetCompletion: if avgCompletionRate < 0.7 for a goal, consider whether the weekly target is too ambitious or sessions need better placement.
- historicalPatterns.skipPatterns: avoid heavy scheduling on days with high skip rates.
- historicalPatterns.durationAccuracy: if accuracy < 0.8 for a category, the user consistently does less than planned — use shorter blocks.

PROPOSAL RULES:
- Produce a proposal only, with at most 8 high-value changes. Never apply changes.
- Use existing stable task/session IDs for edits. For add actions create unique IDs.
- Every move must include patch.date and patch.start; every shorten must include patch.duration.
- When revising, use the original proposal plus modification request and return a complete replacement proposal; do not assume the original was applied.
- Keep title, summary, reasoning and tradeoffs concise.
- Call propose_plan_update exactly once. The top-level tool input must contain id, title, summary, reasoning (string array), tradeoffs (string array), changes (array), createdAt, selectedDate, and weekId.

ACTIONS (use exactly these — never invent fields for an action that does not list them):
- add: a new flexible session. Supply session (a complete session object with a fresh unique id). The session's contributionUnit must be one of: sessions, hours, minutes.
- add-commitment: a new fixed session. Supply session with kind “fixed”.
- remove: supply sessionId.
- move: supply sessionId, patch.date and patch.start.
- shorten: resize an existing session. Supply sessionId and at least one of patch.duration (15-720 min), patch.contribution, or patch.distanceKm.
- update-target: change a weekly target amount. Supply targetId (from planningWeek.targets) and target (new number in that target's unit: sessions, hours, or minutes).
- update-goal: change a goal's priority ONLY. Supply goalId and priority (1, 2, or 3). Never use for amounts.
- set-week-plan: batch-set the plan for remaining days. Supply changes as nested add/move/shorten actions.
- rebalance-week: redistribute remaining work after a change. Triggered by session complete/skip or review submission.
- flag-at-risk: mark a weekly target unlikely to be met. Supply targetId and label explaining why.`;
