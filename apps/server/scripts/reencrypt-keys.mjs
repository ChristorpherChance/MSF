#!/usr/bin/env node
/** 密钥换根重加密（116 部署数据迁移用；2026-10-08）：
 *  本机库密文以默认 MSF_SECRET_KEY（msf-dev-secret-local-only）派生加密；116 用强随机新根。
 *  数据恢复后、应用首启前运行一次：旧根解密 → 新根重加密，明文只在内存不落盘。
 *  用法（apps/server 目录下，pg 依赖就地解析）：
 *    MSF_OLD_SECRET_KEY=msf-dev-secret-local-only MSF_SECRET_KEY=<新根> \
 *    MSF_DATABASE_URL=postgres://msf:***@127.0.0.1:5432/msf node scripts/reencrypt-keys.mjs
 *  幂等：旧根解不开的行（已是新根或他根）原样跳过并计数告警。 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const OLD = process.env.MSF_OLD_SECRET_KEY ?? 'msf-dev-secret-local-only';
const NEW = process.env.MSF_SECRET_KEY;
if (!NEW) {
  console.error('MSF_SECRET_KEY（新根）必填');
  process.exit(1);
}
const keyOf = (s) => createHash('sha256').update(s).digest();
const oldKey = keyOf(OLD);
const newKey = keyOf(NEW);

const dec = (encBuf) => {
  const [v, iv, tag, data] = Buffer.from(encBuf).toString().split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('密文格式不支持');
  const d = createDecipheriv('aes-256-gcm', oldKey, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
};
const enc = (plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', newKey, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.from(`v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${data.toString('base64')}`);
};

const c = new pg.Client({
  connectionString: process.env.MSF_DATABASE_URL ?? 'postgres://msf:msf@127.0.0.1:5432/msf',
});
await c.connect();
let ok = 0;
let skip = 0;

// ① ai_models.api_key_enc（bytea）
for (const row of (await c.query('SELECT id, api_key_enc FROM ai_models WHERE api_key_enc IS NOT NULL')).rows) {
  try {
    await c.query('UPDATE ai_models SET api_key_enc=$2 WHERE id=$1', [row.id, enc(dec(row.api_key_enc))]);
    ok++;
  } catch {
    skip++;
    console.warn(`跳过 ai_models ${row.id}（旧根解不开，可能已是新根）`);
  }
}
// ② sys_webhook_secrets.secret_enc（bytea）
for (const row of (await c.query('SELECT id, secret_enc FROM sys_webhook_secrets')).rows) {
  try {
    await c.query('UPDATE sys_webhook_secrets SET secret_enc=$2 WHERE id=$1', [row.id, enc(dec(row.secret_enc))]);
    ok++;
  } catch {
    skip++;
    console.warn(`跳过 sys_webhook_secrets ${row.id}`);
  }
}
// ③ ai_delegation_targets.config（jsonb，v1. 前缀串值）
for (const row of (await c.query('SELECT id, config FROM ai_delegation_targets WHERE config IS NOT NULL')).rows) {
  let dirty = false;
  const cfg = row.config;
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'string' && v.startsWith('v1.')) {
      try {
        cfg[k] = enc(dec(Buffer.from(v))).toString();
        dirty = true;
        ok++;
      } catch {
        skip++;
        console.warn(`跳过 ai_delegation_targets ${row.id} config.${k}`);
      }
    }
  }
  if (dirty) await c.query('UPDATE ai_delegation_targets SET config=$2 WHERE id=$1', [row.id, JSON.stringify(cfg)]);
}

await c.end();
console.log(`重加密完成：${ok} 处换新根，跳过 ${skip} 处`);
process.exit(0);
