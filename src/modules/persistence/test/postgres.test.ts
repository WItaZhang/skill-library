import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate, createPostgresLibraryService} from '../index.ts';
import type {Actor, Draft} from '../../../contracts/index.ts';
const url=process.env.DATABASE_URL;
const content=(text='hello')=>({files:[{path:'SKILL.md',content:text,mediaType:'text/markdown'}]});
async function fixture(t:any){
 const root=new pg.Pool({connectionString:url});const schema='test_'+randomUUID().replaceAll('-','');
 await root.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 t.after(async()=>{await pool.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end()});
 await Promise.all([migrate(pool),migrate(pool)]);
 const a:Actor={userId:randomUUID(),teamId:randomUUID(),role:'admin'},b:Actor={userId:randomUUID(),teamId:a.teamId,role:'contributor'},v:Actor={userId:randomUUID(),teamId:a.teamId,role:'viewer'};
 await pool.query('INSERT INTO teams(id,name) VALUES($1,$2)',[a.teamId,'team']);
 for(const actor of [a,b,v]){
  await pool.query('INSERT INTO users(id,display_name) VALUES($1,$2)',[actor.userId,'user']);
  await pool.query('INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,$3)',[actor.teamId,actor.userId,actor.role]);
 }
 const service=createPostgresLibraryService({pool});
 return {pool,service,a,b,v};
}
const publish=(d:Draft,key=randomUUID())=>({draftId:d.id,expectedRevision:d.revision,expectedBaseVersionId:d.baseVersionId,changeSummary:'change',idempotencyKey:key});
test('real PostgreSQL migration, author update, concurrent publish and receipt replay',{skip:!url},async t=>{
 const {pool,service:s,a,b}=await fixture(t);
 const {skill,draft}=await s.createSkill(a,{name:'技能',description:'',maintainerIds:[],content:content()});
 const v1=await s.publishDraft(a,publish(draft));
 let da=await s.createDraft(a,skill.id),db=await s.createDraft(b,skill.id);
 da=await s.saveDraft(a,{draftId:da.id,expectedRevision:da.revision,content:content('A')});
 db=await s.saveDraft(b,{draftId:db.id,expectedRevision:db.revision,content:content('B')});
 const inputs=[publish(da),publish(db)],actors=[a,b];
 const s2=createPostgresLibraryService({pool});
 const results=await Promise.allSettled([s.publishDraft(a,inputs[0]),s2.publishDraft(b,inputs[1])]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const winner=results.findIndex(r=>r.status==='fulfilled'), loser=1-winner;
 assert.equal((results[loser] as PromiseRejectedResult).reason.code,'STALE_REVISION');
 const win=(results[winner] as PromiseFulfilledResult<any>).value;
 assert.equal((await s.publishDraft(actors[winner],inputs[winner])).id,win.id);
 await assert.rejects(s.publishDraft(actors[winner],{...inputs[winner],changeSummary:'different'}),{code:'CONFLICT'});
 const ld=[da,db][loser], la=actors[loser];
 const preview=await s.previewDraftUpdate(la,{draftId:ld.id,expectedRevision:ld.revision,content:content('local unsaved')});
 assert.equal((await s.getDraft(la,ld.id)).revision,ld.revision);
 assert.equal((await s.listUpdateEvents(a,0)).length,2);
 const input={draftId:ld.id,expectedRevision:ld.revision,targetVersionId:win.id,confirmationToken:preview.confirmationToken,resolvedContent:content('resolved'),idempotencyKey:randomUUID()};
 const synced=await s.applyDraftUpdate(la,input);
 assert.deepEqual(await s.applyDraftUpdate(la,input),synced);
 await s.publishDraft(la,publish(synced));
 assert.equal((await s.listVersions(a,skill.id)).length,3);
 assert.deepEqual((await s.getVersion(a,v1.id)).content,content());
 assert.equal((await pool.query('SELECT count(*) FROM production_migrations')).rows[0].count,'1');
});
test('authorization, archive revision and immutable/FK/unique constraints',{skip:!url},async t=>{
 const {pool,service:s,a,b,v}=await fixture(t);
 await assert.rejects(s.createSkill({...v,role:'admin'},{name:'x',description:'',maintainerIds:[],content:content()}),{code:'FORBIDDEN'});
 const {skill,draft}=await s.createSkill(a,{name:'x',description:'',maintainerIds:[],content:content()});
 const version=await s.publishDraft(a,publish(draft));
 await assert.rejects(s.getDraft(b,draft.id),{code:'FORBIDDEN'});
 let current=await s.getSkill(a,skill.id);
 current=await s.updateSkill(a,{skillId:skill.id,expectedRevision:current.revision,name:'changed',description:'new'});
 await assert.rejects(s.archiveSkill(a,{skillId:skill.id,expectedRevision:1}),{code:'STALE_REVISION'});
 current=await s.archiveSkill(a,{skillId:skill.id,expectedRevision:current.revision});
 assert.equal((await s.listSkills(a)).length,0);
 assert.equal(Object.keys((await s.catalogSnapshot(a)).versions).length,0);
 assert.equal((await s.listManagedSkills(a,{includeArchived:true})).length,1);
 assert.equal((await s.getVersion(a,version.id)).id,version.id);
 await assert.rejects(s.createDraft(a,skill.id),{code:'CONFLICT'});
 await s.restoreSkill(a,{skillId:skill.id,expectedRevision:current.revision});
 assert.equal((await s.listSkills(a)).length,1);
 await assert.rejects(pool.query('UPDATE versions SET data=data WHERE id=$1',[version.id]),{code:'23514'});
 await assert.rejects(pool.query('DELETE FROM events'),{code:'23514'});
 await assert.rejects(pool.query("UPDATE team_memberships SET role='viewer' WHERE user_id=$1",[a.userId]),{code:'23514'});
 await pool.query("UPDATE team_memberships SET status='removed' WHERE user_id=$1",[b.userId]);
 await assert.rejects(s.getVersion(b,version.id),{code:'FORBIDDEN'});
 const other=randomUUID();await pool.query('INSERT INTO teams(id,name) VALUES($1,$2)',[other,'other']);
 await pool.query('INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,$3)',[other,a.userId,'admin']);
 await assert.rejects(s.getSkill({...a,teamId:other},skill.id),{code:'NOT_FOUND'});
 const forged=randomUUID();
 await assert.rejects(pool.query('INSERT INTO drafts(id,team_id,data) VALUES($1,$2,$3)',[forged,other,JSON.stringify({...draft,id:forged,teamId:other})]),{code:'23503'});
 await assert.rejects(pool.query('INSERT INTO skill_maintainers(team_id,skill_id,user_id) VALUES($1,$2,$3)',[other,skill.id,a.userId]),{code:'23503'});
 const identity=randomUUID();await pool.query('INSERT INTO auth_identities VALUES($1,$2,$3,$4)',[identity,a.userId,'test','subject']);
 await assert.rejects(pool.query('INSERT INTO auth_identities VALUES($1,$2,$3,$4)',[randomUUID(),b.userId,'test','subject']),{code:'23505'});
});
test('every publish fault rolls back version, pointer, draft, receipt, event and audit',{skip:!url},async t=>{
 const {pool,service:s,a}=await fixture(t);
 for(const stage of ['after_version','after_pointer','after_draft','after_request','after_event','after_audit'] as const){
  const {skill,draft}=await s.createSkill(a,{name:stage,description:'',maintainerIds:[],content:content()});
  const input=publish(draft);
  const broken=createPostgresLibraryService({pool,faultInjector:point=>{if(point===stage) throw new Error('injected')}});
  await assert.rejects(broken.publishDraft(a,input),{code:'UNAVAILABLE'});
  assert.equal((await s.getSkill(a,skill.id)).currentVersionId,null);
  assert.equal((await s.getDraft(a,draft.id)).revision,1);
  assert.equal((await s.listVersions(a,skill.id)).length,0);
  assert.equal((await pool.query('SELECT 1 FROM requests WHERE key=$1',[input.idempotencyKey])).rowCount,0);
  await s.publishDraft(a,input);
 }
 assert.equal((await s.listUpdateEvents(a,0)).length,6);
});

test('draft discovery, stale preview/save races and package/script protections',{skip:!url},async t=>{
 const {service:s,a,b}=await fixture(t);
 const {skill,draft}=await s.createSkill(a,{name:'草稿',description:'',maintainerIds:[],content:content()});
 await s.publishDraft(a,publish(draft));
 let da=await s.createDraft(a,skill.id), db=await s.createDraft(b,skill.id);
 assert.ok((await s.listDrafts(a,skill.id)).every(d=>d.authorId===a.userId));
 assert.deepEqual((await s.listDrafts(b,skill.id)).map(d=>d.id),[db.id]);
 const p=await s.previewDraftUpdate(b,{draftId:db.id,expectedRevision:db.revision,content:content('unsaved')});
 db=await s.saveDraft(b,{draftId:db.id,expectedRevision:db.revision,content:content('newer saved')});
 await assert.rejects(s.applyDraftUpdate(b,{draftId:db.id,expectedRevision:p.draftRevision,targetVersionId:p.targetVersionId,confirmationToken:p.confirmationToken,resolvedContent:p.candidateContent,idempotencyKey:randomUUID()}),{code:'STALE_REVISION'});
 const p2=await s.previewDraftUpdate(b,{draftId:db.id,expectedRevision:db.revision,content:db.content});
 da=await s.saveDraft(a,{draftId:da.id,expectedRevision:da.revision,content:content('new version')});await s.publishDraft(a,publish(da));
 await assert.rejects(s.applyDraftUpdate(b,{draftId:db.id,expectedRevision:db.revision,targetVersionId:p2.targetVersionId,confirmationToken:p2.confirmationToken,resolvedContent:p2.candidateContent,idempotencyKey:randomUUID()}),{code:'STALE_REVISION'});
 assert.deepEqual((await s.getDraft(b,db.id)).content,content('newer saved'));
 const incomplete=await s.saveDraft(b,{draftId:db.id,expectedRevision:db.revision,content:content('')});
 assert.equal(incomplete.content.files[0].content,'');
 const empty=await s.createSkill(a,{name:'incomplete',description:'',maintainerIds:[],content:content('')});
 await assert.rejects(s.publishDraft(a,publish(empty.draft)),{code:'VALIDATION'});
 const expectedEvents=(await s.listUpdateEvents(a,0)).length;
 assert.equal(expectedEvents,2);
 await assert.rejects(s.saveDraft(b,{draftId:db.id,expectedRevision:incomplete.revision,content:{files:[{path:'../bad',content:'x',mediaType:'text/plain'}]}}),{code:'VALIDATION'});
 await assert.rejects(s.createSkill(a,{name:'script',description:'',maintainerIds:[],content:{files:[...content().files,{path:'run.py',content:'print(1)',mediaType:'text/plain'}]}}),{code:'FORBIDDEN'});
});

test('same Pool runtime pins old resources, child/retry, preferences, archive, revocation',{skip:!url},async t=>{
 const {pool,service:s,a,b}=await fixture(t);
 const {createPostgresRuntimeService}=await import('../runtime.ts');const r=createPostgresRuntimeService({pool});
 const {skill,draft}=await s.createSkill(a,{name:'runtime',description:'',maintainerIds:[],content:content('v1')});
 const v1=await s.publishDraft(a,publish(draft));const session=await r.createSession(a);
 const old=await r.createTask(a,session.id,randomUUID());await r.recordInvocation(a,old.taskId,skill.id);
 let d=await s.createDraft(a,skill.id);d=await s.saveDraft(a,{draftId:d.id,expectedRevision:d.revision,content:content('v2')});const v2=await s.publishDraft(a,publish(d));
 assert.equal((await r.resolveSkill(a,old.taskId,skill.id)).id,v1.id);
 assert.deepEqual(await r.createTask(a,session.id,old.taskId),old);
 const child=await r.createChildTask(a,old.taskId,randomUUID());assert.equal(child.versions[skill.id],v1.id);
 assert.equal((await r.createTask(a,session.id,randomUUID())).versions[skill.id],v2.id);
 assert.equal((await r.getSessionUpdates(a,session.id))[0].latestVersionId,v2.id);
 const p=await r.setPreference(a,{sessionId:session.id,skillId:skill.id,mode:'pinned',targetVersionId:v1.id,expectedRevision:0});
 assert.equal((await r.createTask(a,session.id,randomUUID())).versions[skill.id],v1.id);
 await assert.rejects(r.setPreference(a,{sessionId:session.id,skillId:skill.id,mode:'latest',targetVersionId:v2.id,expectedRevision:0}),{code:'STALE_REVISION'});
 await r.setPreference(a,{sessionId:session.id,skillId:skill.id,mode:'latest',targetVersionId:v2.id,expectedRevision:p.revision});
 await s.archiveSkill(a,{skillId:skill.id,expectedRevision:(await s.getSkill(a,skill.id)).revision});
 assert.deepEqual((await r.createTask(a,session.id,randomUUID())).versions,{});
 assert.equal((await r.resolveSkill(a,old.taskId,skill.id)).id,v1.id);
 await assert.rejects(r.getTask(b,old.taskId),{code:'FORBIDDEN'});
 await pool.query("UPDATE users SET status='disabled' WHERE id=$1",[a.userId]);
 await assert.rejects(r.getTask(a,old.taskId),{code:'FORBIDDEN'});
});

test('SQLite import preserves legacy versions, raw records, task references, and rolls back atomically',{skip:!url},async t=>{
 const {pool,service:s,a}=await fixture(t);
 const {DatabaseSync}=await import('node:sqlite');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {importSqlite}=await import('../import-sqlite.ts');const {checksum,createPostgresRuntimeService}=await import('../index.ts');
 const dir=mkdtempSync(join(tmpdir(),'sqlite-import-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const servicePath=join(dir,'service.sqlite'),runtimePath=join(dir,'runtime.sqlite');
 const db=new DatabaseSync(servicePath);db.exec('CREATE TABLE service_schema(version INTEGER); INSERT INTO service_schema VALUES(1)');
 for(const table of ['skills','versions','drafts','audit','proposals'])db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,team TEXT,data TEXT)`);
 const createdAt=new Date().toISOString();const version={id:'legacy-version',skillId:'legacy-skill',teamId:'old-team',number:1,parentVersionId:null,content:content('original'),checksum:checksum(content('original')),changeSummary:'legacy review',authorId:'old-user',reviewerId:'old-reviewer',createdAt};
 const skill={id:'legacy-skill',teamId:'old-team',creatorId:'old-user',name:'imported',description:'',maintainerIds:[],currentVersionId:version.id,createdAt};
 const draft={id:'legacy-draft',skillId:skill.id,teamId:skill.teamId,authorId:'old-user',baseVersionId:version.id,revision:2,content:content('saved old draft'),updatedAt:createdAt};
 for(const [table,value] of [['skills',skill],['versions',version],['drafts',draft]] as const)db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(value.id,value.teamId,JSON.stringify(value));
 db.close();
 const rd=new DatabaseSync(runtimePath);rd.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,team TEXT,owner TEXT,epoch INTEGER); CREATE TABLE tasks(id TEXT PRIMARY KEY,session TEXT,snapshot TEXT,checksums TEXT); CREATE TABLE invocations(seq INTEGER PRIMARY KEY,id TEXT,session TEXT,task TEXT,value TEXT)');
 rd.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('old-session','old-team','old-user',0);
 const snap={taskId:'old-task',sessionId:'old-session',teamId:'old-team',actorId:'old-user',versions:{[skill.id]:version.id},preferenceRevisions:{},createdAt};
 rd.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(snap.taskId,snap.sessionId,JSON.stringify(snap),JSON.stringify({[skill.id]:version.checksum}));rd.close();
 const options={pool,sourceKey:'legacy-backup',servicePath,runtimePath,users:{'old-user':a.userId},teams:{'old-team':a.teamId}};
 await assert.rejects(importSqlite({...options,faultInjector:()=>{throw new Error('rollback import')}}),/rollback import/);
 assert.equal((await pool.query('SELECT count(*) FROM versions')).rows[0].count,'0');
 const result=await importSqlite(options);assert.equal((await importSqlite(options)).replayed,true);
 const vid=result.idMap['version:'+version.id],sid=result.idMap['skill:'+skill.id],taskId=result.idMap['task:old-task'];
 assert.deepEqual((await s.getVersion(a,vid)).content,version.content);
 assert.equal((await s.getVersion(a,vid)).checksum,version.checksum);
 const runtime=createPostgresRuntimeService({pool});assert.equal((await runtime.resolveSkill(a,taskId,sid)).id,vid);
 assert.equal((await s.listDrafts(a,sid))[0].content.files[0].content,'saved old draft');
 const raw=(await pool.query("SELECT raw_text FROM legacy_records WHERE source_table='service.versions'")).rows[0].raw_text;
 assert.equal(JSON.parse(raw).data,JSON.stringify(version));
 const reviewer=(await pool.query('SELECT status FROM users WHERE id=$1',[result.idMap['user:old-reviewer']])).rows[0];assert.equal(reviewer.status,'disabled');
 await s.publishDraft(a,publish((await s.listDrafts(a,sid))[0]));
 assert.equal((await runtime.resolveSkill(a,taskId,sid)).id,vid);
});

test('migration detects modified ledger and unknown versions; DDL failure recovers',{skip:!url},async t=>{
 const root=new pg.Pool({connectionString:url});const schema='migration_'+randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});t.after(async()=>{await pool.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end()});
 await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)');await assert.rejects(migrate(pool));
 assert.equal((await pool.query("SELECT to_regclass('production_migrations') AS table_name")).rows[0].table_name,null);
 await pool.query('DROP TABLE users');await migrate(pool);
 await pool.query("UPDATE production_migrations SET checksum='tampered'");await assert.rejects(migrate(pool),/modified/);
 await pool.query('UPDATE production_migrations SET version=99');await assert.rejects(migrate(pool),/Unsupported/);
});

test('independent Node processes serialize publication and durable event order',{skip:!url},async t=>{
 const {pool,service:s,a,b}=await fixture(t);const {fork}=await import('node:child_process');
 const {skill,draft}=await s.createSkill(a,{name:'processes',description:'',maintainerIds:[],content:content()});await s.publishDraft(a,publish(draft));
 const inputs:ReturnType<typeof publish>[]=[];
 for(const actor of [a,b]){let d=await s.createDraft(actor,skill.id);d=await s.saveDraft(actor,{draftId:d.id,expectedRevision:d.revision,content:content(actor.userId)});inputs.push(publish(d))}
 const workers=[a,b].map((actor,i)=>fork(new URL('./process-worker.ts',import.meta.url),[JSON.stringify({connectionString:url,options:(pool as any).options.options,actor,input:inputs[i]})],{stdio:['ignore','ignore','inherit','ipc']}));
 t.after(()=>{for(const worker of workers)if(!worker.killed)worker.kill()});
 await Promise.all(workers.map(worker=>new Promise<void>((resolve,reject)=>{worker.once('message',()=>resolve());worker.once('error',reject)})));
 const results=workers.map(worker=>new Promise<any>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)}));
 for(const worker of workers)worker.send('go');
 const values=await Promise.all(results);assert.equal(values.filter(v=>v.id).length,1);assert.equal(values.filter(v=>v.code==='STALE_REVISION').length,1);
 const events=await s.listUpdateEvents(a,0);assert.equal(events.length,2);assert.ok(events[1].sequence>events[0].sequence);
 assert.equal((await s.getSkill(a,skill.id)).currentVersionId,events[1].versionId);
});
