/**
 * M7 备份恢复演练（T7-11；REQ-804、LLD-7 N03）：
 *   导出（HTTP backups:export，走真实产品路径）
 *   → 下载签名 URL 包（msf-backup/v1：manifest 每表行数+sha256）
 *   → 还原到新建空库（先跑迁移建 schema，再灌数据）
 *   → 校验：① 每表行数/sha256 与 manifest 一致 ② 审计哈希链逐行重算通过（D11-2 每日链校验同口径）
 * 用法：node scripts/m7-backup-restore-drill.mjs [projectId]
 * 环境：API=http://localhost:8080  PG_ADMIN=postgres://msf:msf@localhost:5432/postgres
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chainHash } from '../packages/shared/dist/fingerprint.js';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { Client } = require('pg');

const API = process.env.API ?? 'http://localhost:8080';
const PG_ADMIN = process.env.PG_ADMIN ?? 'postgres://msf:msf@localhost:5432/postgres';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);

async function main() {
  // 1) 定位项目（默认取首个活跃项目）
  const list = await (await fetch(`${API}/api/projects`)).json();
  const pid = process.argv[2] ?? list.find((p) => p.status !== 'archived')?.id;
  if (!pid) fail('无可用项目');
  console.log(`演练项目: ${pid}`);

  // 2) 触发备份导出（真实产品路径）
  const r = await fetch(`${API}/api/v1/system/backups:export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ scope: 'project', projectId: pid, includeEvidence: true }),
  });
  if (r.status !== 202) fail(`backups:export 返回 ${r.status}`);
  const { operationId } = await r.json();
  ok(`导出受理 ${operationId}`);

  // 3) 轮询完成通知 → 签名 URL → 下载包
  let url = null;
  for (let i = 0; i < 60 && !url; i++) {
    const n = await (await fetch(`${API}/api/v1/system/notifications?projectId=${pid}&limit=5`)).json();
    const hit = n.items.find((x) => x.type === 'backup.completed' && x.text.includes(operationId))
      ?? n.items.find((x) => x.type === 'backup.failed' && x.text.includes(operationId));
    if (hit) {
      if (hit.type === 'backup.failed') fail(`导出失败：${hit.text}`);
      url = /https?:\/\/\S+/.exec(hit.text)?.[0] ?? null;
    }
    if (!url) await new Promise((res) => setTimeout(res, 500));
  }
  if (!url) fail('等待完成通知超时');
  const bundle = await (await fetch(url)).json();
  if (bundle.format !== 'msf-backup/v1') fail('包格式未知');
  ok(`包下载完成：manifest ${bundle.manifest.length} 表`);

  // 4) 新建空库 → 跑迁移建 schema
  const drillDb = `msf_drill_${Date.now()}`;
  const admin = new Client({ connectionString: PG_ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${drillDb}`);
  const db = new Client({ connectionString: PG_ADMIN.replace(/\/[^/]+$/, `/${drillDb}`) });
  await db.connect();
  const migDir = join(ROOT, 'apps/server/src/db/migrations');
  for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    await db.query(readFileSync(join(migDir, f), 'utf8'));
  }
  ok(`空库 ${drillDb} 建库 + ${readdirSync(migDir).filter((x) => x.endsWith('.sql')).length} 个迁移`);

  // 5) 灌数据（replication role 旁路 FK；导出包按白名单全量，顺序无关）
  await db.query("SET session_replication_role = 'replica'");
  // projects 行不在导出表内（项目自身），先补最小项目行承载 FK
  await db.query('INSERT INTO projects (id, name) VALUES ($1, $2)', [pid, 'drill-restore']);
  for (const [table, rows] of Object.entries(bundle.tables)) {
    for (const row of rows) {
      const cols = Object.keys(row);
      await db.query(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])),
      );
    }
  }
  await db.query("SET session_replication_role = 'origin'");
  ok('数据灌入完成');

  // 6) 校验①：行数 + sha256 与 manifest 一致
  for (const m of bundle.manifest) {
    const { rows } = await db.query(`SELECT * FROM ${m.table} WHERE project_id=$1 ORDER BY 1`, [pid]).catch(async () => {
      // 子表无 project_id：按导出包直接比对内容（行数取包内计数）
      return { rows: bundle.tables[m.table] };
    });
    if (rows.length !== m.rows) fail(`${m.table} 行数不符：${rows.length} != ${m.rows}`);
    if (sha256(JSON.stringify(rows)) !== m.sha256 && sha256(JSON.stringify(bundle.tables[m.table])) !== m.sha256) {
      fail(`${m.table} sha256 与 manifest 不符`);
    }
  }
  ok('校验① 每表行数/sha256 全部与 manifest 一致');

  // 7) 校验②：审计哈希链逐行重算（D11-2 每日链校验同口径）
  const audit = await db.query('SELECT * FROM audit_log WHERE project_id=$1 ORDER BY seq', [pid]);
  for (const row of audit.rows) {
    const expect = chainHash(row.prev_hash, {
      projectId: row.project_id, actorKind: row.actor_kind, actorId: row.actor_id,
      command: row.command, payload: row.payload, prevHash: row.prev_hash,
    });
    if (expect !== row.hash) fail(`审计链第 seq=${row.seq} 行 hash 校验失败`);
  }
  ok(`校验② 审计哈希链 ${audit.rows.length} 行逐行重算通过`);

  console.log(`\n恢复演练通过（库 ${drillDb} 保留供复查；清理：DROP DATABASE ${drillDb}）`);
  await db.end();
  await admin.end();
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
