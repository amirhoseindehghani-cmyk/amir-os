import { addLocalDays, endOfIsoWeek, startOfIsoWeek, weekIdForDate } from './date-utils';
import { ensureCurrentWeek } from './week-metrics';
import type { PlannerDocument, Session, WeeklyTarget } from './planner-types';

const templates:WeeklyTarget[]=[
  {id:'w1',goalId:'g-internship',label:'Internship',category:'internship',priority:1,target:6,unit:'hours'},
  {id:'w2',goalId:'g-marathon',label:'Running',category:'fitness',priority:2,target:25,unit:'km'},
  {id:'w3',goalId:'g-sabz',label:'SabzApply',category:'sabzapply',priority:2,target:15,unit:'hours'},
  {id:'w4',goalId:'g-dutch',label:'Dutch',category:'dutch',priority:2,target:5,unit:'hours'},
  {id:'w5',goalId:'g-learning',label:'Learning',category:'learning',priority:3,target:3,unit:'hours'},
];

export function createDefaultDocument(localDate:string):PlannerDocument{
  const monday=startOfIsoWeek(localDate),today=localDate,tomorrow=addLocalDays(today,1),later=addLocalDays(today,2);
  const sessions:Session[]=[
    {id:'morning',date:today,start:'08:30',duration:60,title:'Morning routine & breakfast',category:'routine',kind:'routine',status:'planned'},
    {id:'internship-1',date:today,start:'09:45',duration:90,title:'Internship applications',category:'internship',kind:'flexible',status:'planned',goalId:'g-internship',sourceTaskId:'t-internship',contribution:1.5,contributionUnit:'hours'},
    {id:'lunch',date:today,start:'12:15',duration:60,title:'Cook & lunch',category:'cooking',kind:'routine',status:'planned'},
    {id:'sabz-1',date:today,start:'13:30',duration:90,title:'SabzApply — product work',category:'sabzapply',kind:'flexible',status:'planned',goalId:'g-sabz',sourceTaskId:'t-sabz',contribution:1.5,contributionUnit:'hours'},
    {id:'run-today',date:today,start:'16:00',duration:55,title:'Easy run · 7 km',category:'fitness',kind:'flexible',status:'planned',goalId:'g-marathon',contribution:7,contributionUnit:'km',runType:'easy',distanceKm:7},
    {id:'dutch-1',date:today,start:'17:30',duration:45,title:'Dutch practice',category:'dutch',kind:'flexible',status:'planned',goalId:'g-dutch',sourceTaskId:'t-dutch',contribution:.75,contributionUnit:'hours'},
    {id:'recovery',date:today,start:'19:00',duration:180,title:'Dinner & free evening',category:'free',kind:'recovery',status:'planned'},
    {id:'intervals',date:tomorrow,start:'15:30',duration:60,title:'Intervals · 8 km',category:'fitness',kind:'flexible',status:'planned',goalId:'g-marathon',contribution:8,contributionUnit:'km',runType:'intervals',distanceKm:8},
    {id:'dutch-class',date:tomorrow,start:'18:00',duration:90,title:'Dutch class',category:'dutch',kind:'fixed',status:'planned',goalId:'g-dutch',contribution:1.5,contributionUnit:'hours'},
    {id:'internship-2',date:later,start:'10:00',duration:120,title:'Internship applications',category:'internship',kind:'flexible',status:'planned',goalId:'g-internship',sourceTaskId:'t-internship',contribution:2,contributionUnit:'hours'},
    {id:'dutch-2',date:later,start:'16:30',duration:60,title:'Dutch practice',category:'dutch',kind:'flexible',status:'planned',goalId:'g-dutch',sourceTaskId:'t-dutch',contribution:1,contributionUnit:'hours'},
    {id:'long-run',date:addLocalDays(monday,5),start:'10:00',duration:100,title:'Long run · 14 km',category:'fitness',kind:'flexible',status:'planned',goalId:'g-marathon',contribution:14,contributionUnit:'km',runType:'long',distanceKm:14},
  ];
  return{version:5,profile:{name:'Amir',timezone:'Europe/Amsterdam',wakeTime:'08:30',sleepTime:'00:00',deepWorkWindow:'09:30–13:00',workoutWindow:'15:00–18:00',dailyFocusCapacityHours:5,planningAggressiveness:'balanced',preferences:['Prefer deep work earlier in the day','Prefer gym and running in the afternoon','Schedule Dutch before late evening','Treat cooking, transitions, recovery and free time as real time','Use lighter cognitive load after demanding training'],context:'Building SabzApply while preparing for an internship and marathon training.'},goals:[
    {id:'g-internship',title:'Find an internship',category:'internship',priority:1,active:true,targetDate:addLocalDays(today,30),measure:'Focused application hours'},
    {id:'g-marathon',title:'Prepare for the marathon',category:'fitness',priority:2,active:true,measure:'Weekly kilometres and training distribution'},
    {id:'g-sabz',title:'Grow SabzApply',category:'sabzapply',priority:2,active:true,measure:'Focused hours'},
    {id:'g-dutch',title:'Reach Dutch B1',category:'dutch',priority:2,active:true,measure:'Study hours'},
    {id:'g-learning',title:'Complete current course',category:'learning',priority:3,active:true,measure:'Study hours'},
  ],monthlyTargets:[{id:'m1',month:today.slice(0,7),goalId:'g-internship',label:'Submit 15 applications',target:15,unit:'count',done:0},{id:'m2',month:today.slice(0,7),goalId:'g-marathon',label:'Run 100 km',target:100,unit:'km',done:0}],weeklyTargetTemplates:templates,weeks:[{weekId:monday,startDate:monday,endDate:endOfIsoWeek(monday),targets:templates.map(t=>({...t})),createdAt:new Date().toISOString(),source:'rollover'}],tasks:[
    {id:'t-internship',title:'Prepare and submit internship applications',goalId:'g-internship',category:'internship',priority:1,status:'active',deadline:addLocalDays(today,5),estimatedMinutes:240},
    {id:'t-sabz',title:'Finish SabzApply onboarding flow',goalId:'g-sabz',category:'sabzapply',priority:2,status:'active',deadline:addLocalDays(today,3),estimatedMinutes:300},
    {id:'t-dutch',title:'Complete Dutch B1 chapter 4',goalId:'g-dutch',category:'dutch',priority:2,status:'active',estimatedMinutes:180},
  ],sessions,top3:['Submit two internship applications','Finish SabzApply onboarding decisions','Complete easy run'],reviews:[],memories:[{id:'mem-1',text:'Prefer Dutch before 18:00',reason:'Recent sessions scheduled later were completed less consistently.',status:'pending'}],proposals:[],history:[],lastOpenedLocalDate:localDate};
}

export function migratePlannerData(input:unknown,localDate:string):PlannerDocument{
  const fallback=createDefaultDocument(localDate); if(!input||typeof input!=='object')return fallback;
  const raw=input as Record<string,unknown>;
  if(raw.version===5&&raw.profile&&Array.isArray(raw.weeks))return ensureCurrentWeek(repairMondayMigration(raw as PlannerDocument,localDate),localDate);
  if(raw.version===4&&raw.profile&&Array.isArray(raw.goals)){
    const old=raw as any, oldTargets:WeeklyTarget[]=(old.weeklyTargets??templates).map((t:any)=>({id:String(t.id),goalId:String(t.goalId),label:String(t.label),category:t.category,priority:t.priority,target:Number(t.target),unit:t.unit,baselineDone:Number(t.done??0)}));
    const completedDates=(old.sessions??[]).filter((s:Session)=>s.status==='done').map((s:Session)=>s.date).sort();
    const anchor=completedDates.at(-1)??old.lastMorningCheckIn?.date??old.lastOpenedLocalDate??localDate;
    const inferredWeekId=weekIdForDate(anchor),historicalWeekId=localDate===startOfIsoWeek(localDate)&&inferredWeekId===startOfIsoWeek(localDate)?addLocalDays(inferredWeekId,-7):inferredWeekId,migrated:PlannerDocument={...old,version:5,weeklyTargetTemplates:oldTargets.map(t=>({...t,baselineDone:undefined})),weeks:[{weekId:historicalWeekId,startDate:historicalWeekId,endDate:endOfIsoWeek(historicalWeekId),targets:oldTargets,createdAt:new Date().toISOString(),source:'migration'}],lastOpenedLocalDate:localDate};
    delete (migrated as any).weeklyTargets; return ensureCurrentWeek(migrated,localDate);
  }
  const oldDays=(raw.dayData??{}) as Record<string,{blocks?:Array<Record<string,unknown>>;review?:Record<string,unknown>;top3?:string[]}>,sessions:Session[]=[],reviews:PlannerDocument['reviews']=[];
  for(const[date,day]of Object.entries(oldDays)){for(const block of day.blocks??[])sessions.push({id:String(block.id??`${date}-${sessions.length}`),date,start:String(block.time??'12:00'),duration:Number(block.dur??60),title:String(block.label??'Untitled'),category:(block.cat as Session['category'])??'personal',kind:block.type==='commitment'?'fixed':block.type==='recovery'?'recovery':block.type==='routine'?'routine':'flexible',status:block.done?'done':'planned',sourceTaskId:block.sourceTaskId?String(block.sourceTaskId):undefined});if(day.review)reviews.push({id:`review-${date}`,date,score:Number(day.review.score??5),win:String(day.review.win??''),blocker:String(day.review.blocker??'')})}
  return ensureCurrentWeek({...fallback,sessions:sessions.length?sessions:fallback.sessions,reviews:reviews.length?reviews:fallback.reviews},localDate);
}

function repairMondayMigration(doc:PlannerDocument,localDate:string):PlannerDocument{
  const currentWeekId=startOfIsoWeek(localDate);
  if(localDate!==currentWeekId)return doc;
  const current=doc.weeks.find(week=>week.weekId===currentWeekId);
  if(!current||current.source!=='migration'||!current.targets.some(target=>(target.baselineDone??0)>0))return doc;
  const previousWeekId=addLocalDays(currentWeekId,-7);
  const historical:typeof current={...current,weekId:previousWeekId,startDate:previousWeekId,endDate:endOfIsoWeek(previousWeekId)};
  const fresh:typeof current={weekId:currentWeekId,startDate:currentWeekId,endDate:endOfIsoWeek(currentWeekId),targets:doc.weeklyTargetTemplates.map(target=>({...target,baselineDone:0})),createdAt:new Date().toISOString(),source:'rollover'};
  return{...doc,weeks:[...doc.weeks.filter(week=>week.weekId!==currentWeekId&&week.weekId!==previousWeekId),historical,fresh].sort((a,b)=>a.weekId.localeCompare(b.weekId)),history:[{id:`week-repair-${currentWeekId}`,at:new Date().toISOString(),type:'week_rollover_repaired',note:`Moved legacy progress to ${previousWeekId}`,weekId:currentWeekId},...doc.history]};
}
