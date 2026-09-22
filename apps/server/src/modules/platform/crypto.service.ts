import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * 平台对称加密（AES-256-GCM）：webhook secret / 模型 key 等密文落库（REQ-710/803 口径）。
 * 密钥来源 env MSF_SECRET_KEY（缺省开发值，仅本地）；密文格式 v1.<iv>.<tag>.<data>（base64）。
 */
const key = (): Buffer =>
  createHash('sha256').update(process.env.MSF_SECRET_KEY ?? 'msf-dev-secret-local-only').digest();

export function encryptText(plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.from(`v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${data.toString('base64')}`);
}

export function decryptText(enc: Buffer): string {
  const [v, iv, tag, data] = enc.toString().split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('密文格式不支持');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
