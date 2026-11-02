import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { DomainError, type Actor } from '../../contracts/index.ts';
import { fail } from './content.ts';
export type Table = 'skills'|'versions'|'drafts'|'proposals'|'audit';
interface UnitOfWork { client: PoolClient; actor: Actor; write: boolean }
// All repositories sharing a Pool participate in the same async transaction.
// This lets execution acceptance compose existing runtime calls without a second commit.
const scopes = new WeakMap<Pool, AsyncLocalStorage<UnitOfWork>>();
export function createStore(pool: Pool) {
 let scope = scopes.get(pool);
 if (!scope) { scope = new AsyncLocalStorage<UnitOfWork>(); scopes.set(pool, scope); }
 const context = scope;
 const query = (sql: string, values: unknown[] = []) => {
  const client = context.getStore()?.client;
  if (!client) throw new Error('Repository requires transaction');
  return client.query(sql, values);
 };
 const transaction = async <T>(actor: Actor, write: boolean, body: (trusted: Actor)=>Promise<T>): Promise<T> => {
  if (!actor || !/^[0-9a-f-]{36}$/i.test(actor.userId) || !/^[0-9a-f-]{36}$/i.test(actor.teamId)) fail('FORBIDDEN','身份无效');
  const nested = context.getStore();
  if (nested) {
   if (nested.actor.userId !== actor.userId || nested.actor.teamId !== actor.teamId || (write && !nested.write))
    fail('FORBIDDEN', '事务身份或写入范围不一致');
   return body(nested.actor);
  }
  const client = await pool.connect();
  try {
   await client.query('BEGIN');
   // Serialize writers before reads, including event sequence allocation. Across processes,
   // a team cursor can never skip a later-committing publication with a lower sequence.
   if (write) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,731402662))',[actor.teamId]);
   // Match identity's teams-before-memberships lock order.
   const team = await client.query("SELECT id FROM teams WHERE id=$1 AND status='active' FOR SHARE",[actor.teamId]);
   if(!team.rowCount) fail('FORBIDDEN','团队不可访问');
   const result = await client.query(`SELECT m.role FROM team_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.team_id=$1 AND m.user_id=$2 AND m.status='active' AND u.status='active' FOR SHARE OF m,u`,[actor.teamId,actor.userId]);
   if (!result.rows.length) fail('FORBIDDEN','身份无效或团队权限已撤销');
   const trusted = {...actor, role:result.rows[0].role};
   const value = await context.run({client, actor:trusted, write},()=>body(trusted));
   await client.query('COMMIT');
   return value;
  } catch (error) {
   await client.query('ROLLBACK');
   if (error instanceof DomainError) throw error;
   const code = (error as {code?:string}).code;
   throw new DomainError(code==='22P02'?'VALIDATION':code==='23505'?'CONFLICT':'UNAVAILABLE','暂时无法完成数据库操作', {cause:code??'unknown'});
  } finally { client.release(); }
 };
 const all = async <T>(table:Table, actor:Actor):Promise<T[]> => (await query(`SELECT data FROM ${table} WHERE team_id=$1 ORDER BY created_at,id`,[actor.teamId])).rows.map(r=>r.data);
 const get = async <T>(table:Table, actor:Actor, key:string):Promise<T> => {
  const r = (await query(`SELECT data FROM ${table} WHERE id=$1 AND team_id=$2`,[key,actor.teamId])).rows[0];
  if (!r) fail('NOT_FOUND','内容不存在或不可访问');
  return r.data;
 };
 const insert = async <T extends {id:string;teamId:string}>(table:Table,value:T) => {
  await query(`INSERT INTO ${table}(id,team_id,data,created_at) VALUES($1,$2,$3,$4)`,[value.id,value.teamId,JSON.stringify(value),(value as any).createdAt??(value as any).updatedAt??new Date().toISOString()]);
 };
 const update = async <T extends {id:string;teamId:string}>(table:Table,value:T) => {
  await query(`UPDATE ${table} SET data=$1${table==='skills'?', archived_at=$4':''} WHERE id=$2 AND team_id=$3`,[JSON.stringify(value),value.id,value.teamId,...(table==='skills'?[(value as any).archivedAt]:[])]);
 };
 return {query,transaction,all,get,insert,update};
}
