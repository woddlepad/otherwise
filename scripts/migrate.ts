import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(sql);
await client.end();
console.log('schema applied');
