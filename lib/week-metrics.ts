import { addLocalDays, endOfIsoWeek, isDateInWeek, startOfIsoWeek } from './date-utils';
import type { PlannerDocument, WeekRecord, WeeklyTarget } from './planner-types';
const round=(n:number)=>Math.round(n*100)/100;
export function getWeek(doc:PlannerDocument,weekId:string){return doc.weeks.find(w=>w.weekId===weekId)}
export function targetMetrics(doc:PlannerDocument,week:WeekRecord,target:WeeklyTarget){const relevant=doc.sessions.filter(s=>isDateInWeek(s.date,week.weekId)&&s.goalId===target.goalId&&s.status!=='skipped'),value=(s:typeof relevant[number])=>s.contribution??(target.unit==='hours'?s.duration/60:target.unit==='minutes'?s.duration:1),done=(target.baselineDone??0)+relevant.filter(s=>s.status==='done').reduce((sum,s)=>sum+value(s),0),planned=relevant.filter(s=>s.status==='planned').reduce((sum,s)=>sum+value(s),0);return{target:target.target,done:round(done),planned:round(planned),remaining:round(Math.max(0,target.target-done)),coverage:round(done+planned),startDate:week.weekId,endDate:endOfIsoWeek(week.weekId)}}
export function ensureWeekForDate(doc:PlannerDocument,date:string,source:WeekRecord['source']='rollover'):PlannerDocument{const weekId=startOfIsoWeek(date);if(doc.weeks.some(w=>w.weekId===weekId))return doc;const targets=doc.weeklyTargetTemplates.map(t=>({...t,baselineDone:0})),week:WeekRecord={weekId,startDate:weekId,endDate:endOfIsoWeek(weekId),targets,createdAt:new Date().toISOString(),source};return{...doc,weeks:[...doc.weeks,week].sort((a,b)=>a.weekId.localeCompare(b.weekId)),history:[{id:`week-${weekId}`,at:new Date().toISOString(),type:'week_started',note:`Started week ${weekId}`,weekId},...doc.history]}}
export function ensureCurrentWeek(doc:PlannerDocument,localDate:string):PlannerDocument{return{...ensureWeekForDate(doc,localDate),lastOpenedLocalDate:localDate}}

export type HistoricalPatterns = {
  weeksAnalyzed:number;
  targetCompletion:{goalId:string;label:string;avgCompletionRate:number;trend:'improving'|'stable'|'declining'}[];
  skipPatterns:{dayOfWeek:number;skipRate:number}[];
  durationAccuracy:{category:string;avgPlannedMin:number;avgActualMin:number;accuracy:number}[];
  reviewInsights:{avgScore:number;commonStruggles:string[];commonWins:string[];recentCarryForward:string[]};
};

export function historicalPatterns(doc:PlannerDocument,currentWeekId:string):HistoricalPatterns{
  const pastWeeks:WeekRecord[]=[];
  let weekId=addLocalDays(currentWeekId,-7);
  for(let i=0;i<4;i++){const w=doc.weeks.find(wk=>wk.weekId===startOfIsoWeek(weekId));if(w)pastWeeks.push(w);weekId=addLocalDays(weekId,-7);}

  const targetCompletion=doc.weeklyTargetTemplates.map(tpl=>{
    const rates=pastWeeks.map(w=>{const t=w.targets.find(wt=>wt.goalId===tpl.goalId);if(!t)return null;const m=targetMetrics(doc,w,t);return t.target>0?Math.min(1,m.done/t.target):m.done>0?1:0}).filter((r):r is number=>r!==null);
    const avg=rates.length?round(rates.reduce((s,r)=>s+r,0)/rates.length):0;
    const trend:'improving'|'stable'|'declining'=rates.length>=2?(rates[0]-rates[rates.length-1]>0.15?'improving':rates[rates.length-1]-rates[0]>0.15?'declining':'stable'):'stable';
    return{goalId:tpl.goalId,label:tpl.label,avgCompletionRate:avg,trend};
  });

  const daySkips=[0,1,2,3,4,5,6].map(dow=>{
    const sessionsOnDay=doc.sessions.filter(s=>{const wk=startOfIsoWeek(s.date);return pastWeeks.some(pw=>pw.weekId===wk)&&new Date(`${s.date}T12:00:00`).getDay()===dow});
    const total=sessionsOnDay.length,skipped=sessionsOnDay.filter(s=>s.status==='skipped').length;
    return{dayOfWeek:dow,skipRate:total>0?round(skipped/total):0};
  });

  const catMap=new Map<string,{planned:number[];actual:number[]}>();
  for(const s of doc.sessions){const wk=startOfIsoWeek(s.date);if(!pastWeeks.some(pw=>pw.weekId===wk))continue;if(!catMap.has(s.category))catMap.set(s.category,{planned:[],actual:[]});const entry=catMap.get(s.category)!;entry.planned.push(s.duration);if(s.status==='done')entry.actual.push(s.duration);}
  const durationAccuracy=[...catMap.entries()].map(([category,{planned,actual}])=>{
    const avgP=planned.length?round(planned.reduce((a,b)=>a+b,0)/planned.length):0;
    const avgA=actual.length?round(actual.reduce((a,b)=>a+b,0)/actual.length):0;
    return{category,avgPlannedMin:avgP,avgActualMin:avgA,accuracy:avgP>0?round(avgA/avgP):0};
  });

  const recentReviews=[...doc.reviews].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,14);
  const scores=recentReviews.map(r=>r.score);
  const struggles=recentReviews.map(r=>r.struggle||r.blocker).filter(Boolean);
  const wins=recentReviews.map(r=>r.win).filter(Boolean);
  const carry=recentReviews.filter(r=>r.carryForward).map(r=>r.carryForward!);
  const freq=new Map<string,number>();for(const s of struggles){freq.set(s,(freq.get(s)??0)+1);}
  const topStruggles=[...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s])=>s);
  const winFreq=new Map<string,number>();for(const w of wins){winFreq.set(w,(winFreq.get(w)??0)+1);}
  const topWins=[...winFreq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([w])=>w);

  return{
    weeksAnalyzed:pastWeeks.length,
    targetCompletion,
    skipPatterns:daySkips,
    durationAccuracy,
    reviewInsights:{avgScore:scores.length?round(scores.reduce((a,b)=>a+b,0)/scores.length):0,commonStruggles:topStruggles,commonWins:topWins,recentCarryForward:carry.slice(0,3)},
  };
}
