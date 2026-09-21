/** 迁移执行器：顺次执行 src/db/migrations/*.sql（M0 最简形态，幂等由 SQL IF NOT EXISTS 保证） */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './pool.js';

async function main(): Promise<void> {
  // 以包根为基准（dist 不含 .sql；pnpm migrate 在 apps/server 下运行）
  const dir = join(process.cwd(), 'src/db/migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    console.warn(`[migrate] ${f}`);
    await pool.query(readFileSync(join(dir, f), 'utf8'));
  }
  await pool.end();
}

void main();
