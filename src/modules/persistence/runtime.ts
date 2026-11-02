import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Actor,RuntimeService,TaskSnapshot,SkillVersion,SessionPreference,Invocation,SessionUpdate} from '../../contracts/index.ts';
import {createStore} from './store.ts';
import {checksum,fail} from './content.ts';
import type {ProductionSkill} from '../../contracts/production.ts';
export const provisionalDefaults=Object.freeze({D1:'future-tasks-only',D2:'session-skill-until-unpinned',D3:'latest-unless-explicitly-pinned'});
/** Uses the same team lock and Pool as library writes, including catalog-to-task acceptance. */
export function createPostgresRuntimeService({pool}:{pool:Pool}):RuntimeService {
 const {query,transaction,all,get}=createStore(pool);
 const session=async(actor:Actor,id:string)=>{
  const row=(await query('SELECT * FROM runtime_sessions WHERE id=$1 AND team_id=$2',[id,actor.teamId])).rows[0];
  if(!row) fail('NOT_FOUND','会话不存在');
  if(row.owner_id!==actor.userId) fail('FORBIDDEN','无权访问此会话');return row;
 };
 const task=async(actor:Actor,id:string)=>{
  const row=(await query('SELECT * FROM runtime_tasks WHERE id=$1 AND team_id=$2',[id,actor.teamId])).rows[0];
  if(!row) fail('NOT_FOUND','任务不存在');await session(actor,row.session_id);
  return {snapshot:row.snapshot as TaskSnapshot,checksums:row.checksums as Record<string,string>};
 };
 const catalog=async(actor:Actor)=>Object.fromEntries((await all<ProductionSkill>('skills',actor)).filter(s=>s.currentVersionId&&!s.archivedAt).map(s=>[s.id,s.currentVersionId!]));
 const version=async(actor:Actor,skillId:string,versionId:string)=>{
  const v=await get<SkillVersion>('versions',actor,versionId);
  if(v.skillId!==skillId||checksum(v.content)!==v.checksum) fail('RESOURCE_MISSING','固定版本资源校验失败');return v;
 };
 const prefs=async(actor:Actor,sessionId:string)=>(await query('SELECT value,target_id FROM runtime_preferences WHERE team_id=$1 AND session_id=$2 ORDER BY skill_id',[actor.teamId,sessionId])).rows as {value:SessionPreference;target_id:string}[];
 const invocations=async(actor:Actor,sessionId:string)=>(await query('SELECT value FROM runtime_invocations WHERE team_id=$1 AND session_id=$2 ORDER BY sequence',[actor.teamId,sessionId])).rows.map(r=>r.value as Invocation);
 const existing=async(actor:Actor,taskId:string,sessionId:string,parentTaskId?:string)=>{
  if(!(await query('SELECT 1 FROM runtime_tasks WHERE id=$1',[taskId])).rowCount)return null;
  const saved=(await task(actor,taskId)).snapshot;
  if(saved.sessionId!==sessionId||saved.parentTaskId!==parentTaskId)fail('CONFLICT','任务标识已用于另一请求');return saved;
 };
 const insertTask=async(snapshot:TaskSnapshot,checksums:Record<string,string>)=>{
  await query('INSERT INTO runtime_tasks(id,team_id,session_id,parent_task_id,snapshot,checksums,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[snapshot.taskId,snapshot.teamId,snapshot.sessionId,snapshot.parentTaskId??null,JSON.stringify(snapshot),JSON.stringify(checksums),snapshot.createdAt]);
 };
 const resolve=async(actor:Actor,taskId:string,skillId:string)=>{
  const t=await task(actor,taskId);if(!Object.hasOwn(t.snapshot.versions,skillId))fail('NOT_FOUND','此技能不在任务接受时的目录中');
  const v=await version(actor,skillId,t.snapshot.versions[skillId]);
  if(v.checksum!==t.checksums[skillId])fail('RESOURCE_MISSING','固定版本内容已变化');return v;
 };
 return {
  createSession:(actor)=>transaction(actor,true,async actor=>{
   const id=randomUUID();await query('INSERT INTO runtime_sessions(id,team_id,owner_id) VALUES($1,$2,$3)',[id,actor.teamId,actor.userId]);return {id};
  }),
  createTask:(actor,sessionId,taskId)=>transaction(actor,true,async actor=>{
   await session(actor,sessionId);const prior=await existing(actor,taskId,sessionId);if(prior)return prior;
   const versions=await catalog(actor),revisions:Record<string,number>={},checksums:Record<string,string>={};
   for(const {value:p} of await prefs(actor,sessionId)){
    if(!Object.hasOwn(versions,p.skillId))continue;revisions[p.skillId]=p.revision;
    if(p.mode==='pinned')versions[p.skillId]=p.pinnedVersionId!;
   }
   for(const [s,v] of Object.entries(versions))checksums[s]=(await version(actor,s,v)).checksum;
   const snapshot:TaskSnapshot={taskId,sessionId,teamId:actor.teamId,actorId:actor.userId,versions,preferenceRevisions:revisions,createdAt:new Date().toISOString()};
   await insertTask(snapshot,checksums);return snapshot;
  }),
  getTask:(actor,taskId)=>transaction(actor,false,async actor=>(await task(actor,taskId)).snapshot),
  createChildTask:(actor,parentTaskId,taskId)=>transaction(actor,true,async actor=>{
   const parent=await task(actor,parentTaskId),prior=await existing(actor,taskId,parent.snapshot.sessionId,parentTaskId);if(prior)return prior;
   const snapshot={...parent.snapshot,taskId,parentTaskId,createdAt:new Date().toISOString()};await insertTask(snapshot,parent.checksums);return snapshot;
  }),
  resolveSkill:(actor,taskId,skillId)=>transaction(actor,false,actor=>resolve(actor,taskId,skillId)),
  recordInvocation:(actor,taskId,skillId)=>transaction(actor,true,async actor=>{
   const v=await resolve(actor,taskId,skillId),t=(await task(actor,taskId)).snapshot;
   const i:Invocation={id:randomUUID(),taskId,sessionId:t.sessionId,skillId,versionId:v.id,checksum:v.checksum,createdAt:new Date().toISOString()};
   await query('INSERT INTO runtime_invocations(id,team_id,session_id,task_id,skill_id,version_id,value,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[i.id,actor.teamId,i.sessionId,taskId,skillId,v.id,JSON.stringify(i),i.createdAt]);return i;
  }),
  listInvocations:(actor,sessionId)=>transaction(actor,false,async actor=>{await session(actor,sessionId);return invocations(actor,sessionId)}),
  getSessionUpdates:(actor,sessionId)=>transaction(actor,false,async actor=>{
   await session(actor,sessionId);const c=await catalog(actor),used=new Map<string,Invocation>();for(const i of await invocations(actor,sessionId))used.set(i.skillId,i);
   const preferences=new Map((await prefs(actor,sessionId)).map(p=>[p.value.skillId,p]));const updates:SessionUpdate[]=[];
   for(const [skillId,i] of used){
    if(!Object.hasOwn(c,skillId))continue;const latestVersionId=c[skillId],p=preferences.get(skillId);
    const usedVersionId=p?.value.mode==='pinned'?p.value.pinnedVersionId!:i.versionId;
    if(usedVersionId===latestVersionId||(p?.value.mode==='latest'&&p.target_id===latestVersionId))continue;
    updates.push({sessionId,skillId,usedVersionId,latestVersionId,preference:p?.value??null});
   }return updates;
  }),
  setPreference:(actor,input)=>transaction(actor,true,async actor=>{
   if(!input)fail('VALIDATION','会话选择无效');const {sessionId,skillId,mode,targetVersionId,expectedRevision}=input;
   await session(actor,sessionId);
   if(!['latest','pinned'].includes(mode)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail('VALIDATION','会话选择或修订号无效');
   const c=await catalog(actor);if(!Object.hasOwn(c,skillId))fail('FORBIDDEN','当前无权使用此技能');
   if(mode==='latest'&&c[skillId]!==targetVersionId)fail('STALE_REVISION','技能又有更新');await version(actor,skillId,targetVersionId);
   const current=(await prefs(actor,sessionId)).find(p=>p.value.skillId===skillId)?.value;
   if((current?.revision??0)!==expectedRevision)fail('STALE_REVISION','会话选择已变化');
   if(!(await invocations(actor,sessionId)).some(i=>i.skillId===skillId&&(mode==='latest'||i.versionId===targetVersionId)))fail('VALIDATION','只能选择实际调用过的技能版本');
   const preference:SessionPreference={sessionId,skillId,mode,pinnedVersionId:mode==='pinned'?targetVersionId:null,revision:expectedRevision+1};
   await query('INSERT INTO runtime_preferences(team_id,session_id,skill_id,target_id,value) VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id,skill_id) DO UPDATE SET target_id=excluded.target_id,value=excluded.value',[actor.teamId,sessionId,skillId,targetVersionId,JSON.stringify(preference)]);
   await query('UPDATE runtime_sessions SET epoch=epoch+1 WHERE id=$1',[sessionId]);return preference;
  }),
 };
}
