import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {canonicalDigest,checksum} from './content.ts';
export interface SqliteImportOptions {
 pool:Pool; sourceKey:string; servicePath:string; runtimePath?:string;
 /** Explicit existing production IDs. Never infer account links from email. */
 users?:Record<string,string>; teams?:Record<string,string>;
 faultInjector?:()=>void;
}
/** Offline, read-only SQLite snapshot -> one PostgreSQL transaction. Unknown identities are disabled. */
export async function importSqlite(options:SqliteImportOptions):Promise<{importId:string;idMap:Record<string,string>;replayed:boolean}> {
 if(!options.sourceKey.trim())throw new Error('sourceKey required');
 const data:Record<string,any[]>={};
 const read=(path:string,prefix:string)=>{
  const db=new DatabaseSync(path,{readOnly:true});
  try{
   db.exec('BEGIN');
   const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]);
   for(const {name} of tables){
    if(!/^[a-z_]+$/.test(name))throw new Error('Unexpected SQLite table name');
    data[prefix+name]=db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
   }
   db.exec('COMMIT');
  }finally{db.close()}
 };
 read(options.servicePath,'service.');if(options.runtimePath)read(options.runtimePath,'runtime.');
 if(![1,2].includes(data['service.service_schema']?.[0]?.version))throw new Error('Unsupported SQLite service schema');
 const fingerprint=canonicalDigest({data,users:options.users??{},teams:options.teams??{}});
 const client=await options.pool.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(731402663)');
  const prior=(await client.query('SELECT * FROM legacy_imports WHERE source_key=$1',[options.sourceKey])).rows[0];
  if(prior){if(prior.fingerprint!==fingerprint)throw new Error('Import source changed; use a new sourceKey and empty target');await client.query('COMMIT');return {importId:prior.id,idMap:prior.id_map,replayed:true}}
  const idMap:Record<string,string>={};
  const map=(kind:string,value:string):string=>{
   if(!value)throw new Error('Missing legacy '+kind+' id');
   const key=kind+':'+value;
   if(idMap[key])return idMap[key];
   const explicit=kind==='user'?options.users?.[value]:kind==='team'?options.teams?.[value]:undefined;
   if(explicit)return idMap[key]=explicit;
   if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))return idMap[key]=value;
   const h=createHash('sha256').update(options.sourceKey+'\0'+kind+'\0'+value).digest('hex');
   return idMap[key]=`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
  };
  const refs:Record<string,string>={teamId:'team',authorId:'user',reviewerId:'user',creatorId:'user',actorId:'user',skillId:'skill',versionId:'version',currentVersionId:'version',baseVersionId:'version',parentVersionId:'version',previousVersionId:'version',targetVersionId:'version',mergedVersionId:'version',draftId:'draft',proposalId:'proposal',sessionId:'session',taskId:'task',parentTaskId:'task'};
  const remap=(value:any,key='',kind=''):any=>{
   if(value===null||value===undefined)return value;
   // Content and arbitrary file text must remain byte-for-byte unchanged.
   if(key==='content'||key.endsWith('Content'))return value;
   if(key==='maintainerIds')return value.map((v:string)=>map('user',v));
   if(key==='versions')return Object.fromEntries(Object.entries(value).map(([k,v])=>[map('skill',k),map('version',v as string)]));
   if(key==='preferenceRevisions')return Object.fromEntries(Object.entries(value).map(([k,v])=>[map('skill',k),v]));
   if(key==='id'&&typeof value==='string')return map(kind,value);
   if(refs[key]&&typeof value==='string')return map(refs[key],value);
   if(Array.isArray(value))return value.map(v=>remap(v,'',kind));
   if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v,k,kind)]));
   return value;
  };
  const entities:Record<string,any[]>={};
  for(const [table,kind] of Object.entries({skills:'skill',versions:'version',drafts:'draft',proposals:'proposal',audit:'audit',events:'event'}))entities[table]=(data['service.'+table]??[]).map(r=>remap(JSON.parse(r.data),'',kind));
  const pairs=new Set<string>();const add=(team:string,user:string)=>{if(team&&user)pairs.add(team+':'+user)};
  for(const table of Object.values(entities))for(const v of table){
   for(const user of [v.creatorId,v.authorId,v.reviewerId,v.actorId,...(v.maintainerIds??[])])add(v.teamId,user);
  }
  const sessions=(data['runtime.sessions']??[]).map(r=>({id:map('session',r.id),team:map('team',r.team),owner:map('user',r.owner),epoch:r.epoch}));
  for(const s of sessions)add(s.team,s.owner);
  for(const r of data['service.requests']??[])add(map('team',r.team),map('user',r.actor));
  for(const [key,value] of Object.entries(idMap)){
   if(key.startsWith('team:'))await client.query("INSERT INTO teams(id,name,status) VALUES($1,$2,'disabled') ON CONFLICT(id) DO NOTHING",[value,'Imported '+key.slice(5)]);
   if(key.startsWith('user:'))await client.query("INSERT INTO users(id,display_name,status) VALUES($1,$2,'disabled') ON CONFLICT(id) DO NOTHING",[value,'Imported '+key.slice(5)]);
  }
  for(const pair of pairs){const [team,user]=pair.split(':');await client.query("INSERT INTO team_memberships(team_id,user_id,role,status) VALUES($1,$2,'viewer','removed') ON CONFLICT DO NOTHING",[team,user])}
  for(const table of ['skills','versions','drafts','proposals','audit'])for(let v of entities[table]){
   if(table==='skills')v={...v,revision:1,archivedAt:null};
   if(table==='versions'&&checksum(v.content)!==v.checksum)throw new Error('Legacy checksum mismatch '+v.id);
   await client.query(`INSERT INTO ${table}(id,team_id,data,created_at) VALUES($1,$2,$3,$4)`,[v.id,v.teamId,JSON.stringify(v),v.createdAt??v.updatedAt]);
  }
  // Preserve event order with new global sequence; old cursors must be reset at cutover.
  for(const v of entities.events)await client.query('INSERT INTO events(id,team_id,data,created_at) VALUES($1,$2,$3,$4)',[v.id,v.teamId,JSON.stringify(v),v.createdAt]);
  for(const r of data['service.requests']??[])await client.query('INSERT INTO requests(id,team_id,actor_id,operation,key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),map('team',r.team),map('user',r.actor),r.operation,r.key,r.fingerprint,JSON.stringify(remap(JSON.parse(r.result),'',r.operation==='publish'?'version':'draft'))]);
  // Old previews remain in the raw archive only: clients must request a fresh bound preview.
  for(const s of sessions)await client.query('INSERT INTO runtime_sessions(id,team_id,owner_id,epoch) VALUES($1,$2,$3,$4)',[s.id,s.team,s.owner,s.epoch]);
  const taskTeams=new Map<string,string>();
  for(const r of data['runtime.tasks']??[]){
   const s=remap(JSON.parse(r.snapshot),'','task');taskTeams.set(s.taskId,s.teamId);
   const checksums=Object.fromEntries(Object.entries(JSON.parse(r.checksums)).map(([k,v])=>[map('skill',k),v]));
   for(const [skillId,versionId] of Object.entries(s.versions)){
    const v=entities.versions.find(v=>v.id===versionId&&v.skillId===skillId&&v.teamId===s.teamId);
    if(!v||checksums[skillId]!==v.checksum)throw new Error('Legacy task resource missing or checksum mismatch');
   }
   await client.query('INSERT INTO runtime_tasks(id,team_id,session_id,parent_task_id,snapshot,checksums,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[s.taskId,s.teamId,s.sessionId,s.parentTaskId??null,JSON.stringify(s),JSON.stringify(checksums),s.createdAt]);
  }
  for(const r of data['runtime.preferences']??[]){
   const v=remap(JSON.parse(r.value),'','preference'),team=sessions.find(s=>s.id===v.sessionId)?.team;
   await client.query('INSERT INTO runtime_preferences VALUES($1,$2,$3,$4,$5)',[team,v.sessionId,v.skillId,map('version',r.target),JSON.stringify(v)]);
  }
  for(const r of data['runtime.invocations']??[]){
   const v=remap(JSON.parse(r.value),'','invocation');
   await client.query('INSERT INTO runtime_invocations(id,team_id,session_id,task_id,skill_id,version_id,value,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[v.id,taskTeams.get(v.taskId),v.sessionId,v.taskId,v.skillId,v.versionId,JSON.stringify(v),v.createdAt]);
  }
  const importId=randomUUID();
  await client.query('INSERT INTO legacy_imports(id,source_key,fingerprint,id_map) VALUES($1,$2,$3,$4)',[importId,options.sourceKey,fingerprint,JSON.stringify(idMap)]);
  for(const [table,rows] of Object.entries(data))for(let n=0;n<rows.length;n++)await client.query('INSERT INTO legacy_records(id,import_id,source_table,source_key,raw_text) VALUES($1,$2,$3,$4,$5)',[randomUUID(),importId,table,String(n),JSON.stringify(rows[n])]);
  options.faultInjector?.();
  await client.query('COMMIT');return {importId,idMap,replayed:false};
 }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}
