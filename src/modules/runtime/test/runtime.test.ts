import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createRuntimeService, contentChecksum } from '../index.ts';
import { DomainError } from '../../../contracts/index.ts';
import type { Actor, RuntimeHost, SkillVersion } from '../../../contracts/index.ts';
const actor: Actor = {userId:'u',teamId:'team',role:'viewer'};
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'skill-runtime-')); const path=join(dir,'runtime.sqlite');
  const versions = new Map<string,SkillVersion>(); let current: Record<string,string> = {}; let revoked=false;
  const publish = (skillId='s', number=1) => {
    const content={files:[{path:'SKILL.md',content:'Use [guide](guide.txt)',mediaType:'text/markdown'},{path:'guide.txt',content:`guide ${number}`,mediaType:'text/plain'},{path:'run.js',content:`// version ${number}`,mediaType:'text/javascript'}]};
    const v: SkillVersion={id:`${skillId}${number}`,skillId,teamId:'team',number,parentVersionId:number>1?`${skillId}${number-1}`:null,content,checksum:contentChecksum(content),changeSummary:'更新',authorId:'a',reviewerId:'r',createdAt:new Date().toISOString()};
    versions.set(v.id,v); current[skillId]=v.id; return v;
  };
  const authorize = (a: Actor) => { if(revoked || a.teamId!=='team') throw new DomainError('FORBIDDEN','无权限'); };
  const host: RuntimeHost={async catalogSnapshot(a) {authorize(a); return {teamId:a.teamId,versions:{...current},capturedAt:new Date().toISOString()};}, async getVersion(a,id) {authorize(a); const v=versions.get(id); if(!v) throw new DomainError('NOT_FOUND','不存在'); return structuredClone(v);}};
  publish(); publish('other');
  const runtime=createRuntimeService({databasePath:path,host});
  return {runtime,host,path,versions,publish,setRevoked(){revoked=true;},cleanup(){runtime.close();rmSync(dir,{recursive:true,force:true});}};
}
const rejects = (p: Promise<unknown>,code:string) => assert.rejects(p,(e: unknown) => e instanceof DomainError && e.code===code);

test('full catalog freezes resources, children and idempotent retries; new tasks follow host',async()=>{
 const f=fixture(); try {
 const s=await f.runtime.createSession(actor); const original=await f.runtime.createTask(actor,s.id,'old');
 assert.deepEqual({...original.versions},{s:'s1',other:'other1'});
 original.versions.s='tampered';
 f.publish(); f.publish('s',2); f.publish('new',1);
 assert.equal((await f.runtime.resolveSkill(actor,'old','s')).content.files[1]!.content,'guide 1');
 assert.equal((await f.runtime.createTask(actor,s.id,'old')).versions.s,'s1');
 assert.equal((await f.runtime.createChildTask(actor,'old','child')).versions.s,'s1');
 assert.equal((await f.runtime.resolveSkill(actor,'child','s')).content.files[2]!.content,'// version 1');
 assert.equal((await f.runtime.createTask(actor,s.id,'fresh')).versions.s,'s2');
 await rejects(f.runtime.resolveSkill(actor,'old','new'),'NOT_FOUND');
 await rejects(f.runtime.createChildTask(actor,'fresh','child'),'CONFLICT');
 const second=await f.runtime.createSession(actor); await rejects(f.runtime.createTask(actor,second.id,'old'),'CONFLICT');
 } finally {f.cleanup();}
});

test('actual invocations rebuild latest prompts after missed, repeated and continuous updates',async()=>{
 const f=fixture(); try {
 const s=await f.runtime.createSession(actor); await f.runtime.createTask(actor,s.id,'t'); f.publish('s',2);
 assert.deepEqual(await f.runtime.getSessionUpdates(actor,s.id),[]);
 await f.runtime.recordInvocation(actor,'t','s');
 assert.equal((await f.runtime.getSessionUpdates(actor,s.id))[0]!.latestVersionId,'s2');
 f.publish('s',3);
 for(let i=0;i<3;i++) {const u=await f.runtime.getSessionUpdates(actor,s.id);assert.equal(u.length,1);assert.equal(u[0]!.latestVersionId,'s3');}
 await rejects(f.runtime.setPreference(actor,{sessionId:s.id,skillId:'s',mode:'latest',targetVersionId:'s2',expectedRevision:0}),'STALE_REVISION');
 await f.runtime.setPreference(actor,{sessionId:s.id,skillId:'s',mode:'pinned',targetVersionId:'s1',expectedRevision:0});
 assert.equal((await f.runtime.createTask(actor,s.id,'pinned')).versions.s,'s1');
 const other=await f.runtime.createSession(actor);assert.equal((await f.runtime.createTask(actor,other.id,'separate')).versions.s,'s3');
 await f.runtime.setPreference(actor,{sessionId:s.id,skillId:'s',mode:'latest',targetVersionId:'s3',expectedRevision:1});
 assert.deepEqual(await f.runtime.getSessionUpdates(actor,s.id),[]);
 f.publish('s',4);assert.equal((await f.runtime.getSessionUpdates(actor,s.id))[0]!.latestVersionId,'s4');
 assert.equal((await f.runtime.createTask(actor,s.id,'latest')).versions.s,'s4');
 assert.equal((await f.runtime.resolveSkill(actor,'t','s')).id,'s1');
 } finally {f.cleanup();}
});

test('two database connections reject stale preference and serialize task against changed policy',async()=>{
 const f=fixture();const other=createRuntimeService({databasePath:f.path,host:f.host});try {
 const s=await f.runtime.createSession(actor); await f.runtime.createTask(actor,s.id,'t');await f.runtime.recordInvocation(actor,'t','s');f.publish('s',2);
 const input={sessionId:s.id,skillId:'s',mode:'pinned' as const,targetVersionId:'s1',expectedRevision:0};
 const results=await Promise.allSettled([f.runtime.setPreference(actor,input),other.setPreference(actor,input)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'STALE_REVISION');
 await other.setPreference(actor,{...input,mode:'latest',targetVersionId:'s2',expectedRevision:1});
 const get=f.host.getVersion;let changed=false;
 f.host.getVersion=async(a,id)=>{if(!changed){changed=true;await other.setPreference(actor,{...input,expectedRevision:2});}return get(a,id);};
 const t=await f.runtime.createTask(actor,s.id,'racing');assert.equal(t.versions.s,'s1');assert.equal(t.preferenceRevisions.s,3);
 const same=await Promise.all([f.runtime.createTask(actor,s.id,'same'),other.createTask(actor,s.id,'same')]);assert.deepEqual(same[0],same[1]);
 } finally {other.close();f.cleanup();}
});

test('ownership, team isolation, revoked host access and runtime input validation',async()=>{
 const f=fixture();try {
 const s=await f.runtime.createSession(actor);await f.runtime.createTask(actor,s.id,'t');
 const stranger={...actor,userId:'stranger'};
 await rejects(f.runtime.getTask(stranger,'t'),'FORBIDDEN');await rejects(f.runtime.listInvocations(stranger,s.id),'FORBIDDEN');await rejects(f.runtime.createTask({...actor,teamId:'else'},s.id,'bad'),'FORBIDDEN');
 await rejects(f.runtime.createTask(actor,s.id,''),'VALIDATION');
 await rejects(f.runtime.setPreference(actor,{sessionId:s.id,skillId:'s',mode:'pinned',targetVersionId:'s1',expectedRevision:0}),'VALIDATION');
 f.setRevoked();await rejects(f.runtime.resolveSkill(actor,'t','s'),'FORBIDDEN');await rejects(f.runtime.getTask(actor,'t'),'FORBIDDEN');await rejects(f.runtime.createSession(actor),'FORBIDDEN');
 } finally {f.cleanup();}
});

test('missing, corrupt, mutated and cross-team resource versions fail without fallback',async()=>{
 const f=fixture();try {
 const s=await f.runtime.createSession(actor);await f.runtime.createTask(actor,s.id,'t');const v=structuredClone(f.versions.get('s1')!);f.publish('s',2);
 f.versions.delete('s1');await rejects(f.runtime.resolveSkill(actor,'t','s'),'RESOURCE_MISSING');
 f.versions.set('s1',{...v,checksum:'bad'});await rejects(f.runtime.recordInvocation(actor,'t','s'),'RESOURCE_MISSING');
 const changed=structuredClone(v);changed.content.files[1]!.content='mutation';changed.checksum=contentChecksum(changed.content);f.versions.set('s1',changed);await rejects(f.runtime.resolveSkill(actor,'t','s'),'RESOURCE_MISSING');
 f.versions.set('s1',{...v,teamId:'else'});await rejects(f.runtime.resolveSkill(actor,'t','s'),'FORBIDDEN');
 assert.deepEqual(await f.runtime.listInvocations(actor,s.id),[]);
 const latest=f.versions.get('s2')!;latest.content.files.push({...latest.content.files[0]!});latest.checksum=contentChecksum(latest.content);
 await rejects(f.runtime.createTask(actor,s.id,'invalid'),'RESOURCE_MISSING');await rejects(f.runtime.getTask(actor,'invalid'),'NOT_FOUND');
 } finally {f.cleanup();}
});

test('database recovery and separate process retain snapshots, invocation and preference',async()=>{
 const f=fixture();try {
 const s=await f.runtime.createSession(actor);await f.runtime.createTask(actor,s.id,'t');await f.runtime.recordInvocation(actor,'t','s');await f.runtime.setPreference(actor,{sessionId:s.id,skillId:'s',mode:'pinned',targetVersionId:'s1',expectedRevision:0});f.publish('s',2);
 const recovered=createRuntimeService({databasePath:f.path,host:f.host});try {
 assert.equal((await recovered.createTask(actor,s.id,'t')).versions.s,'s1');assert.equal((await recovered.createTask(actor,s.id,'after')).versions.s,'s1');assert.equal((await recovered.listInvocations(actor,s.id)).length,1);
 }finally{recovered.close();}
 const script=`import {createRuntimeService} from ${JSON.stringify(new URL('../index.ts',import.meta.url).href)};const host={catalogSnapshot:async()=>({teamId:'team',versions:{s:'s2'},capturedAt:''}),getVersion:async()=>{throw Error('should not reread on retry')}};const r=createRuntimeService({databasePath:process.argv[1],host});console.log(JSON.stringify(await r.createTask(${JSON.stringify(actor)},process.argv[2],'t')));r.close();`;
 const process=spawnSync(globalThis.process.execPath,['--experimental-strip-types','--input-type=module','-e',script,f.path,s.id],{encoding:'utf8'});assert.equal(process.status,0,process.stderr);assert.equal(JSON.parse(process.stdout).versions.s,'s1');
 const db=new DatabaseSync(f.path);try{assert.throws(()=>db.exec("UPDATE tasks SET snapshot='{}'"),/immutable/);assert.throws(()=>db.exec('DELETE FROM invocations'),/immutable/);}finally{db.close();}
 } finally {f.cleanup();}
});

test('publication during latest-target resource validation rejects the outdated confirmation',async()=>{
 const f=fixture();try {
 const s=await f.runtime.createSession(actor);await f.runtime.createTask(actor,s.id,'t');await f.runtime.recordInvocation(actor,'t','s');f.publish('s',2);
 const get=f.host.getVersion;f.host.getVersion=async(a,id)=>{const v=await get(a,id);f.publish('s',3);return v;};
 await rejects(f.runtime.setPreference(actor,{sessionId:s.id,skillId:'s',mode:'latest',targetVersionId:'s2',expectedRevision:0}),'STALE_REVISION');
 assert.equal((await f.runtime.getSessionUpdates(actor,s.id))[0]!.preference,null);
 }finally{f.cleanup();}
});

test('writer process exit recovers committed session, invocation, preference and old resources',async()=>{
 const f=fixture();try {
 const path=join(f.path,'..','process.sqlite');
 const old=JSON.stringify([...f.versions.values()]);
 const script=`import {createRuntimeService} from ${JSON.stringify(new URL('../index.ts',import.meta.url).href)};const versions=${old};const host={catalogSnapshot:async()=>({teamId:'team',versions:{s:'s1',other:'other1'},capturedAt:''}),getVersion:async(a,id)=>versions.find(v=>v.id===id)};const r=createRuntimeService({databasePath:process.argv[1],host});const a=${JSON.stringify(actor)};const s=await r.createSession(a);await r.createTask(a,s.id,'process-task');await r.recordInvocation(a,'process-task','s');await r.setPreference(a,{sessionId:s.id,skillId:'s',mode:'pinned',targetVersionId:'s1',expectedRevision:0});console.log(s.id);process.exit(0);`;
 const writer=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,path],{encoding:'utf8'});assert.equal(writer.status,0,writer.stderr);
 f.publish('s',2);const recovered=createRuntimeService({databasePath:path,host:f.host});try {
 const sid=writer.stdout.trim();assert.equal((await recovered.getTask(actor,'process-task')).versions.s,'s1');assert.equal((await recovered.resolveSkill(actor,'process-task','s')).content.files[1]!.content,'guide 1');assert.equal((await recovered.listInvocations(actor,sid)).length,1);assert.equal((await recovered.createTask(actor,sid,'after-exit')).preferenceRevisions.s,1);assert.equal((await recovered.createChildTask(actor,'process-task','after-exit-child')).versions.s,'s1');
 }finally{recovered.close();}
 }finally{f.cleanup();}
});

test('resource validation rejects traversal, duplicate and missing entry point before acceptance',async()=>{
 const f=fixture();try {
 const s=await f.runtime.createSession(actor);const original=structuredClone(f.versions.get('s1')!);
 for(const path of ['../secret','a/../b','/absolute','a\\b','a//b','./SKILL.md']) {
 const v=structuredClone(original);v.content.files[0]!.path=path;v.checksum=contentChecksum(v.content);f.versions.set(v.id,v);await rejects(f.runtime.createTask(actor,s.id,`bad-${path}`),'RESOURCE_MISSING');
 }
 const v=structuredClone(original);v.content.files=v.content.files.filter(x=>x.path!=='SKILL.md');v.checksum=contentChecksum(v.content);f.versions.set(v.id,v);await rejects(f.runtime.createTask(actor,s.id,'missing-entry'),'RESOURCE_MISSING');
 }finally{f.cleanup();}
});
