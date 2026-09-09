export const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function parseLocalDate(value:string){if(!DATE_RE.test(value))throw new Error(`Invalid date: ${value}`);const[y,m,d]=value.split('-').map(Number),result=new Date(y,m-1,d,12);if(result.getFullYear()!==y||result.getMonth()!==m-1||result.getDate()!==d)throw new Error(`Invalid date: ${value}`);return result}
export function formatLocalDate(date:Date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}
export function localDateInTimeZone(timeZone='Europe/Amsterdam',now=new Date()){const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),part=(type:string)=>parts.find(p=>p.type===type)?.value??'';return `${part('year')}-${part('month')}-${part('day')}`}
export function addLocalDays(date:string,days:number){const d=parseLocalDate(date);d.setDate(d.getDate()+days);return formatLocalDate(d)}
export function startOfIsoWeek(date:string){const d=parseLocalDate(date),day=d.getDay()||7;d.setDate(d.getDate()-day+1);return formatLocalDate(d)}
export function endOfIsoWeek(dateOrWeekId:string){return addLocalDays(startOfIsoWeek(dateOrWeekId),6)}
export function weekIdForDate(date:string){return startOfIsoWeek(date)}
export function isDateInWeek(date:string,weekId:string){return date>=weekId&&date<=endOfIsoWeek(weekId)}
export function formatDateLong(date:string){return parseLocalDate(date).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})}
export function formatWeekRange(weekId:string){const start=parseLocalDate(weekId),end=parseLocalDate(endOfIsoWeek(weekId)),sameMonth=start.getMonth()===end.getMonth();return `${start.getDate()}${sameMonth?'':' '+start.toLocaleDateString('en-GB',{month:'long'})} – ${end.getDate()} ${end.toLocaleDateString('en-GB',{month:'long',year:start.getFullYear()!==end.getFullYear()?'numeric':undefined})}`}
