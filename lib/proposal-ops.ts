import { DATE_RE, TIME_RE, weekIdForDate } from './date-utils';
import type { PlanProposal, PlannerDocument, Priority } from './planner-types';

export function validateProposalShape(value:unknown):value is PlanProposal{
  if(!value||typeof value!=='object')return false;const p=value as PlanProposal;
  return typeof p.id==='string'&&typeof p.title==='string'&&typeof p.summary==='string'&&DATE_RE.test(p.selectedDate)&&DATE_RE.test(p.weekId)&&Array.isArray(p.reasoning)&&p.reasoning.every(x=>typeof x==='string')&&Array.isArray(p.tradeoffs)&&p.tradeoffs.every(x=>typeof x==='string')&&Array.isArray(p.changes)&&p.changes.length<=20&&p.changes.every(c=>c&&typeof c.id==='string'&&typeof c.label==='string'&&['add','remove','move','shorten','update-goal','add-commitment'].includes(c.action));
}

export function validateProposalAgainstDocument(proposal:PlanProposal,doc:PlannerDocument):string[]{
  const errors:string[]=[],ids=new Set(doc.sessions.map(s=>s.id)),seenAdds=new Set<string>();
  if(weekIdForDate(proposal.selectedDate)!==proposal.weekId)errors.push('The proposal is tied to the wrong week.');
  for(const change of proposal.changes){
    const existing=change.sessionId?doc.sessions.find(s=>s.id===change.sessionId):undefined;
    if(['remove','move','shorten'].includes(change.action)&&!existing)errors.push(`${change.label}: referenced session does not exist.`);
    if(existing?.kind==='fixed'&&['remove','move'].includes(change.action))errors.push(`${change.label}: fixed commitments cannot be moved or removed.`);
    if(change.action==='move'){
      if(!change.patch?.date||!validDate(change.patch.date)||weekIdForDate(change.patch.date)!==proposal.weekId)errors.push(`${change.label}: destination date is outside the planning week.`);
      if(!change.patch?.start||!TIME_RE.test(change.patch.start))errors.push(`${change.label}: destination time is invalid.`);
      if(existing&&change.patch?.date&&change.patch?.start&&doc.sessions.some(session=>session.id!==existing.id&&session.status!=='skipped'&&session.date===change.patch?.date&&session.start===change.patch?.start&&session.title===existing.title))errors.push(`${change.label}: destination would duplicate an existing session.`);
    }
    if(change.action==='shorten'&&(!change.patch?.duration||change.patch.duration<15||change.patch.duration>720))errors.push(`${change.label}: duration is invalid.`);
    if(change.action==='add'||change.action==='add-commitment'){
      const s=change.session;if(!s)errors.push(`${change.label}: new session data is missing.`);else{
        if(ids.has(s.id)||seenAdds.has(s.id))errors.push(`${change.label}: duplicate session ID.`);seenAdds.add(s.id);
        if(doc.sessions.some(existing=>existing.status!=='skipped'&&existing.date===s.date&&existing.start===s.start&&existing.title===s.title))errors.push(`${change.label}: duplicate session already exists.`);
        if(!validDate(s.date)||weekIdForDate(s.date)!==proposal.weekId)errors.push(`${change.label}: date is outside the planning week.`);
        if(!TIME_RE.test(s.start)||!Number.isFinite(s.duration)||s.duration<15||s.duration>720)errors.push(`${change.label}: time or duration is invalid.`);
        if(s.sourceTaskId&&!doc.tasks.some(t=>t.id===s.sourceTaskId))errors.push(`${change.label}: linked task does not exist.`);
        if(s.goalId&&!doc.goals.some(g=>g.id===s.goalId))errors.push(`${change.label}: linked goal does not exist.`);
        if(change.action==='add-commitment'&&s.kind!=='fixed')errors.push(`${change.label}: commitment must be fixed.`);
      }
    }
    if(change.action==='update-goal'&&(!change.goalId||!doc.goals.some(g=>g.id===change.goalId)||![1,2,3].includes(change.priority??0)))errors.push(`${change.label}: goal update is invalid.`);
  }
  return [...new Set(errors)];
}

export function applyProposalAtomically(doc:PlannerDocument,proposal:PlanProposal):{ok:true;document:PlannerDocument}|{ok:false;errors:string[]}{
  const errors=validateProposalAgainstDocument(proposal,doc);if(errors.length)return{ok:false,errors};
  let sessions=doc.sessions.map(s=>({...s})),goals=doc.goals.map(g=>({...g}));
  for(const c of proposal.changes){
    if((c.action==='add'||c.action==='add-commitment')&&c.session)sessions.push({...c.session});
    else if(c.action==='remove')sessions=sessions.map(s=>s.id===c.sessionId?{...s,status:'skipped'}:s);
    else if(c.action==='move')sessions=sessions.map(s=>s.id===c.sessionId?{...s,date:c.patch!.date!,start:c.patch!.start!}:s);
    else if(c.action==='shorten')sessions=sessions.map(s=>s.id===c.sessionId?{...s,duration:c.patch!.duration!}:s);
    else if(c.action==='update-goal')goals=goals.map(g=>g.id===c.goalId?{...g,priority:c.priority as Priority}:g);
  }
  if(new Set(sessions.map(s=>s.id)).size!==sessions.length)return{ok:false,errors:['The proposal would create duplicate sessions.']};
  return{ok:true,document:{...doc,sessions,goals,proposals:[proposal,...doc.proposals].slice(0,30),history:[{id:`applied-${crypto.randomUUID()}`,at:new Date().toISOString(),type:'proposal_applied',note:proposal.summary,weekId:proposal.weekId},...doc.history]}};
}

function validDate(value:string){if(!DATE_RE.test(value))return false;const d=new Date(`${value}T12:00:00`);return !Number.isNaN(d.getTime())&&`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`===value}

export function proposalJsonSchema(){return{type:'object',additionalProperties:false,required:['id','title','summary','reasoning','tradeoffs','changes','createdAt','selectedDate','weekId'],properties:{id:{type:'string'},title:{type:'string'},summary:{type:'string'},reasoning:{type:'array',items:{type:'string'}},tradeoffs:{type:'array',items:{type:'string'}},createdAt:{type:'string'},selectedDate:{type:'string'},weekId:{type:'string'},changes:{type:'array',items:{type:'object',additionalProperties:false,required:['id','action','label'],properties:{id:{type:'string'},action:{enum:['add','remove','move','shorten','update-goal','add-commitment']},sessionId:{type:'string'},label:{type:'string'},from:{type:'string'},to:{type:'string'},goalId:{type:'string'},priority:{type:'integer'},patch:{type:'object',additionalProperties:false,properties:{date:{type:'string'},start:{type:'string'},duration:{type:'number'}}},session:{type:'object',additionalProperties:false,required:['id','date','start','duration','title','category','kind','status'],properties:{id:{type:'string'},date:{type:'string'},start:{type:'string'},duration:{type:'number'},title:{type:'string'},category:{enum:['internship','dutch','sabzapply','fitness','learning','personal','routine','cooking','free','work']},kind:{enum:['fixed','flexible','routine','recovery']},status:{enum:['planned','done','skipped']},goalId:{type:'string'},sourceTaskId:{type:'string'},contribution:{type:'number'},contributionUnit:{enum:['hours','sessions','km','count']},runType:{enum:['easy','long','tempo','intervals','recovery']},distanceKm:{type:'number'}}}}}}}}as const}
