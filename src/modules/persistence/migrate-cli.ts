import pg from 'pg';
import { migrate } from './migrate.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL});
try { await migrate(pool); console.log('PostgreSQL migrations applied'); } finally { await pool.end(); }
