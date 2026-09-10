import { DATE_RE, TIME_RE, weekIdForDate } from './date-utils';
import type { PlanProposal, PlannerDocument, Priority } from './planner-types';

export const PROPOSAL_ACTIONS=['add','remove','move','shorten','update-goal','update-target','add-commitment','set-week-plan','rebalance-week','flag-at-risk'] as const;

export function validateProposalShape(value:unknown):value is PlanProposal{
  if(!value||typeof value!=='object')return false;const p=value as PlanProposal;
  return typeof p.id==='string'&&typeof p.title==='string'&&typeof p.summary==='string'&&DATE_RE.test(p.selectedDate)&&DATE_RE.test(p.weekId)&&Array.isArray(p.reasoning)&&p.reasoning.every(x=>typeof x==='string')&&Array.isArray(p.tradeoffs)&&p.tradeoffs.every(x=>typeof x==='string')&&Array.isArray(p.changes)&&p.changes.length<=20&&p.changes.every(c=>c&&typeof c.id==='string'&&typeof c.label==='string'&&(PROPOSAL_ACTIONS as readonly string[]).includes(c.action));
}

const show=(value:unknown)=>value===undefined?'nothing':JSON.stringify(value);
const inRange=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;

export function validateProposalAgainstDocument(proposal:PlanProposal,doc:PlannerDocument):string[]{
  const errors:string[]=[],ids=new Set(doc.sessions.map(s=>s.id)),seenAdds=new Set<string>();
  const planningWeek=doc.weeks.find(w=>w.weekId===proposal.weekId);
  if(weekIdForDate(proposal.selectedDate)!==proposal.weekId)errors.push('The proposal is tied to the wrong week.');
  for(const change of proposal.changes){
    const existing=change.sessionId?doc.sessions.find(s=>s.id===change.sessionId):undefined;
    if(['remove','move','shorten'].includes(change.action)&&!existing)errors.push(`${change.label}: referenced session does not exist${change.sessionId?` (sessionId "${change.sessionId}")`:' (no sessionId was supplied)'}.`);
    if(existing?.kind==='fixed'&&change.action==='remove')errors.push(`${change.label}: fixed commitments cannot be removed.`);
    if(existing?.kind==='fixed'&&change.action==='move'&&!change.userReported)errors.push(`${change.label}: fixed commitments cannot be moved unless the user reported the change.`);
    if(change.action==='move'){
      if(!change.patch?.date||!validDate(change.patch.date)||weekIdForDate(change.patch.date)!==proposal.weekId)errors.push(`${change.label}: destination date must be a real date inside week ${proposal.weekId} (received ${show(change.patch?.date)}).`);
      if(!change.patch?.start||!TIME_RE.test(change.patch.start))errors.push(`${change.label}: destination time must be HH:MM (received ${show(change.patch?.start)}).`);
      if(existing&&change.patch?.date&&change.patch?.start&&doc.sessions.some(session=>session.id!==existing.id&&session.status!=='skipped'&&session.date===change.patch?.date&&session.start===change.patch?.start&&session.title===existing.title))errors.push(`${change.label}: destination would duplicate an existing session.`);
    }
    if(change.action==='shorten'){
      const patch=change.patch;
      if(!patch||(patch.duration===undefined&&patch.contribution===undefined&&patch.distanceKm===undefined)){
        errors.push(`${change.label}: a shorten needs patch.duration, patch.contribution or patch.distanceKm.`);
      }else{
        if(patch.duration!==undefined&&!inRange(patch.duration,15,720))errors.push(`${change.label}: duration must be a number of minutes between 15 and 720 (received ${show(patch.duration)}).`);
        if(patch.contribution!==undefined&&!inRange(patch.contribution,0,1000))errors.push(`${change.label}: contribution must be a number between 0 and 1000 (received ${show(patch.contribution)}).`);
        if(patch.distanceKm!==undefined&&!inRange(patch.distanceKm,0,200))errors.push(`${change.label}: distance must be a number of kilometres between 0 and 200 (received ${show(patch.distanceKm)}).`);
      }
    }
    if(change.action==='add'||change.action==='add-commitment'){
      const s=change.session;if(!s)errors.push(`${change.label}: new session data is missing.`);else{
        if(ids.has(s.id)||seenAdds.has(s.id))errors.push(`${change.label}: duplicate session ID.`);seenAdds.add(s.id);
        if(doc.sessions.some(existing=>existing.status!=='skipped'&&existing.date===s.date&&existing.start===s.start&&existing.title===s.title))errors.push(`${change.label}: duplicate session already exists.`);
        if(!validDate(s.date)||weekIdForDate(s.date)!==proposal.weekId)errors.push(`${change.label}: date must be a real date inside week ${proposal.weekId} (received ${show(s.date)}).`);
        if(!TIME_RE.test(s.start)||!inRange(s.duration,15,720))errors.push(`${change.label}: start must be HH:MM and duration 15–720 minutes (received ${show(s.start)} and ${show(s.duration)}).`);
        if(s.sourceTaskId&&!doc.tasks.some(t=>t.id===s.sourceTaskId)&&!doc.ongoingTasks.some(t=>t.id===s.sourceTaskId))errors.push(`${change.label}: linked task "${s.sourceTaskId}" does not exist.`);
        if(s.goalId&&!doc.goals.some(g=>g.id===s.goalId))errors.push(`${change.label}: linked goal "${s.goalId}" does not exist.`);
        if(change.action==='add-commitment'&&s.kind!=='fixed')errors.push(`${change.label}: commitment must be fixed.`);
      }
    }
    if(change.action==='update-goal'){
      // update-goal is deliberately narrow: it re-prioritises a goal and nothing else.
      // Amounts (hours, kilometres, contributions) belong to shorten or update-target.
      if(!change.goalId)errors.push(`${change.label}: a goal update needs goalId.`);
      else if(!doc.goals.some(g=>g.id===change.goalId))errors.push(`${change.label}: no goal matches goalId "${change.goalId}".`);
      if(!([1,2,3] as unknown[]).includes(change.priority))errors.push(`${change.label}: update-goal only changes a goal's priority, which must be 1, 2 or 3 (received ${show(change.priority)}). To change an amount, use update-target for a weekly target or shorten for a single session.`);
    }
    if(change.action==='update-target'){
      const target=planningWeek?.targets.find(t=>t.id===change.targetId);
      if(!change.targetId)errors.push(`${change.label}: a target update needs targetId.`);
      else if(!planningWeek)errors.push(`${change.label}: week ${proposal.weekId} has no stored targets to update.`);
      else if(!target)errors.push(`${change.label}: no weekly target matches targetId "${change.targetId}" in week ${proposal.weekId}.`);
      if(!inRange(change.target,0,1000))errors.push(`${change.label}: the new weekly target must be a number between 0 and 1000 (received ${show(change.target)}).`);
    }
  }
  return [...new Set(errors)];
}

export function applyProposalAtomically(doc:PlannerDocument,proposal:PlanProposal):{ok:true;document:PlannerDocument}|{ok:false;errors:string[]}{
  const errors=validateProposalAgainstDocument(proposal,doc);if(errors.length)return{ok:false,errors};
  let sessions=doc.sessions.map(s=>({...s})),goals=doc.goals.map(g=>({...g})),weeks=doc.weeks.map(w=>({...w,targets:w.targets.map(t=>({...t}))}));
  for(const c of proposal.changes){
    if((c.action==='add'||c.action==='add-commitment')&&c.session)sessions.push({...c.session});
    else if(c.action==='remove')sessions=sessions.map(s=>s.id===c.sessionId?{...s,status:'skipped'}:s);
    else if(c.action==='move')sessions=sessions.map(s=>s.id===c.sessionId?{...s,date:c.patch!.date!,start:c.patch!.start!}:s);
    else if(c.action==='shorten')sessions=sessions.map(s=>{
      if(s.id!==c.sessionId)return s;
      const patch=c.patch!,next={...s};
      if(patch.duration!==undefined)next.duration=patch.duration;
      if(patch.contribution!==undefined)next.contribution=patch.contribution;
      if(patch.distanceKm!==undefined)next.distanceKm=patch.distanceKm;
      return next;
    });
    else if(c.action==='update-goal')goals=goals.map(g=>g.id===c.goalId?{...g,priority:c.priority as Priority}:g);
    else if(c.action==='update-target')weeks=weeks.map(w=>w.weekId!==proposal.weekId?w:{...w,targets:w.targets.map(t=>t.id===c.targetId?{...t,target:c.target as number}:t)});
  }
  if(new Set(sessions.map(s=>s.id)).size!==sessions.length)return{ok:false,errors:['The proposal would create duplicate sessions.']};
  return{ok:true,document:{...doc,sessions,goals,weeks,proposals:[proposal,...doc.proposals].slice(0,30),history:[{id:`applied-${crypto.randomUUID()}`,at:new Date().toISOString(),type:'proposal_applied',note:proposal.summary,weekId:proposal.weekId},...doc.history]}};
}

function validDate(value:string){if(!DATE_RE.test(value))return false;const d=new Date(`${value}T12:00:00`);return !Number.isNaN(d.getTime())&&`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`===value}

export function proposalJsonSchema(){return{type:'object',additionalProperties:false,required:['id','title','summary','reasoning','tradeoffs','changes','createdAt','selectedDate','weekId'],properties:{id:{type:'string'},title:{type:'string'},summary:{type:'string'},reasoning:{type:'array',items:{type:'string'}},tradeoffs:{type:'array',items:{type:'string'}},createdAt:{type:'string'},selectedDate:{type:'string'},weekId:{type:'string'},changes:{type:'array',items:{type:'object',additionalProperties:false,required:['id','action','label'],properties:{
  id:{type:'string'},
  action:{enum:[...PROPOSAL_ACTIONS],description:'add = new flexible session (needs session). add-commitment = new fixed session (needs session with kind "fixed"). remove = drop a session (needs sessionId). move = reschedule a session (needs sessionId, patch.date, patch.start). shorten = change how big a session is (needs sessionId and at least one of patch.duration, patch.contribution, patch.distanceKm) — use this to change a run distance such as 7 km to 6 km. update-target = change a weekly target amount (needs targetId from planningWeek.targets and target). update-goal = change a goal’s priority ONLY (needs goalId and priority 1, 2 or 3); never use it for hours, kilometres, contributions or target amounts.'},
  sessionId:{type:'string',description:'Existing session id. Required for remove, move and shorten.'},
  label:{type:'string'},
  from:{type:'string'},
  to:{type:'string'},
  goalId:{type:'string',description:'Existing goal id. Only used by update-goal.'},
  priority:{type:'integer',enum:[1,2,3],description:'New goal priority. Required by update-goal and must be 1, 2 or 3.'},
  targetId:{type:'string',description:'Existing weekly target id taken from planningWeek.targets. Required by update-target.'},
  target:{type:'number',description:'New weekly target amount, in that target’s own unit. Required by update-target.'},
  userReported:{type:'boolean',description:'Set to true when the user explicitly reported a fixed commitment changed. Allows moving fixed sessions to reflect reality. Never set when proactively rescheduling.'},
  patch:{type:'object',additionalProperties:false,description:'Field updates for move and shorten.',properties:{date:{type:'string'},start:{type:'string'},duration:{type:'number',description:'New length in minutes, 15–720.'},contribution:{type:'number',description:'New amount this session contributes to its weekly target, in that target’s unit.'},distanceKm:{type:'number',description:'New running distance in kilometres.'}}},
  session:{type:'object',additionalProperties:false,required:['id','date','start','duration','title','category','kind','status'],properties:{id:{type:'string'},date:{type:'string'},start:{type:'string'},duration:{type:'number'},title:{type:'string'},category:{enum:['internship','dutch','sabzapply','fitness','learning','personal','routine','cooking','free','work']},kind:{enum:['fixed','flexible','routine','recovery']},status:{enum:['planned','done','skipped']},goalId:{type:'string'},sourceTaskId:{type:'string'},contribution:{type:'number'},contributionUnit:{enum:['hours','sessions','minutes']},runType:{enum:['easy','long','tempo','intervals','recovery']},distanceKm:{type:'number'}}}
}}}}}as const}
