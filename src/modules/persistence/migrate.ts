import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
/** All pending DDL and the ledger commit together. A failed upgrade is safe to retry. */
export async function migrate(pool: Pool): Promise<void> {
 const directory=new URL('./migrations/',import.meta.url);
 const files=(await readdir(directory)).filter(name=>/^\d+-[a-z0-9-]+\.sql$/.test(name)).sort();
 const migrations=await Promise.all(files.map(async name=>{
  const sql=await readFile(new URL(name,directory),'utf8');
  return {version:Number(name.split('-')[0]),sql,checksum:createHash('sha256').update(sql).digest('hex')};
 }));
 if(!migrations.length||migrations.some((m,i)=>m.version!==i+1))throw new Error('Migration files must have consecutive versions starting at 1');
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(731402661)');
  await client.query('CREATE TABLE IF NOT EXISTS production_migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const rows=(await client.query('SELECT version,checksum FROM production_migrations ORDER BY version')).rows;
  if(rows.some((r,i)=>r.version!==i+1||!migrations[i]||r.checksum!==migrations[i].checksum))throw new Error('Unsupported or modified production migration');
  for(const migration of migrations.slice(rows.length)){
   await client.query(migration.sql);
   await client.query('INSERT INTO production_migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);
  }
  await client.query('COMMIT');
 } catch(error){await client.query('ROLLBACK');throw error}
 finally{client.release()}
}
