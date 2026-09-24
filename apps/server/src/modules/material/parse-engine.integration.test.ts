/** AI 解析引擎集成测试（实机验收修复，需 DB+MinIO）：本地抽取 + parsing 路由 AI 整理 + 兜底 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { pool, query } from '../../db/pool.js';
import { resetCommands } from '../evidence/command-bus.js';
import type { AiMessageResult, AiProvider, AiSession } from '../ai/ai-provider.interface.js';
import { AiUsageService } from '../ai/usage.service.js';
import { StorageService } from '../platform/storage.service.js';
import { normalizeUploadExt } from './ext.js';
import { AiParseEngine, extractText } from './parse-engine.js';
import { ParseService } from './parse.service.js';
import { UploadsService } from './uploads.service.js';
import type { MatFile } from './types.js';

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const PID = '00000000-0000-0000-0000-0000000000e9';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };

/** 假 pi 提供器：固定产出结构化稿，登记收到的 prompt */
class FakePiProvider implements AiProvider {
  readonly kind = 'pi' as const;
  seen: string[] = [];
  async createSession(): Promise<AiSession> {
    const seen = this.seen;
    return {
      sessionId: 'fake-pi',
      stream(prompt: string) {
        seen.push(prompt);
        const result = Promise.resolve<AiMessageResult>({
          text: '# 结构化标题\n\n| 列1 | 列2 |\n| --- | --- |\n| a | b |',
          usage: { inputTokens: 100, outputTokens: 20 },
          modelId: undefined,
        });
        return { deltas: (async function* () { yield '# 结构化标题'; })(), result };
      },
      steer() {},
      stop() {},
    };
  }
}

function xlsxBuffer(seed = '需求表'): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['编号', '需求'], ['R1', '支持 docx 上传'], ['R2', '解析为 Markdown'], ['SX', seed],
  ]), '需求表');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM mat_files LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

describe('normalizeUploadExt（纯函数）', () => {
  it('docx/markdown/xls 归一到白名单族', () => {
    expect(normalizeUploadExt('需求说明书.docx')).toBe('doc');
    expect(normalizeUploadExt('README.markdown')).toBe('md');
    expect(normalizeUploadExt('台账.XLS')).toBe('xlsx');
    expect(normalizeUploadExt('a.pdf')).toBe('pdf');
    expect(normalizeUploadExt('无扩展名')).toBe('');
  });
});

describe('AiParseEngine（集成，需 DB+MinIO）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  const storage = new StorageService();
  const uploads = new UploadsService(storage);
  const svc = new ParseService(storage);
  resetCommands();
  uploads.onModuleInit();
  svc.onModuleInit();
  new AiUsageService().onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'w9-parse-engine') ON CONFLICT (id) DO NOTHING", [PID]);
  });
  const modelIds: string[] = [];
  afterAll(async () => {
    await query('DELETE FROM ai_usage WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_parsed WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_uploads WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    for (const id of modelIds) await query('DELETE FROM ai_models WHERE id=$1', [id]); // 须在 ai_usage 之后（FK）
    await pool.end();
  });

  async function uploadFile(name: string, content: Buffer): Promise<string> {
    const s = await uploads.create(PID, { fileName: name, size: content.length, sha256: sha256(content) }, CTX);
    await uploads.uploadPart(PID, s.uploadId, 1, content);
    return ((await uploads.complete(PID, s.uploadId, CTX)) as { file: { id: string; ext: string } }).file.id;
  }
  async function parseWith(fileId: string, engine: AiParseEngine): Promise<void> {
    svc.engine = engine;
    const op = (await svc.parse(PID, fileId, CTX, false, { autoRun: false })) as { operationId: string };
    await svc.runParse(PID, fileId, op.operationId, CTX);
  }
  const fileRow = async (fileId: string) =>
    (await query<MatFile>('SELECT * FROM mat_files WHERE id=$1', [fileId])).rows[0]!;
  const parsedBody = async (fileId: string) =>
    (await query<{ body_md: string }>(
      "SELECT body_md FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'", [fileId],
    )).rows[0]?.body_md ?? '';

  it('xlsx 真实抽取：工作表转 Markdown 表；无 AI 提供器时原文兜底成稿', async () => {
    const id = await uploadFile('需求台账.xlsx', xlsxBuffer());
    await parseWith(id, new AiParseEngine(undefined));
    expect((await fileRow(id)).parse_status).toBe('parsed');
    const body = await parsedBody(id);
    expect(body).toContain('工作表：需求表');
    expect(body).toContain('| 编号 | 需求 |');
    expect(body).toContain('支持 docx 上传');
    expect(body).toContain('本地抽取稿');
  });

  it('parsing 路由已配：AI 结构化整理 + 用量落账（purpose=parsing）', async () => {
    // 插一个真实模型行使 ai_usage.model_id 可落（有 FK 时）
    const mid = (await query<{ id: string }>(
      `INSERT INTO ai_models (name, provider, base_url, model_code, created_by)
       VALUES ('w9-parse-model', 'gateway', 'http://127.0.0.1:9', 'm', 't') RETURNING id`, [])).rows[0]!.id;
    modelIds.push(mid);
    class WithModel extends FakePiProvider {
      override async createSession(): Promise<AiSession> {
        const s = await super.createSession();
        const seen = this.seen;
        return { ...s, stream: (prompt: string) => {
          seen.push(prompt);
          return {
            deltas: (async function* () { yield '# 结构化标题'; })(),
            result: Promise.resolve<AiMessageResult>({
              text: '# 结构化标题\n\n| 列1 | 列2 |\n| --- | --- |\n| a | b |',
              usage: { inputTokens: 100, outputTokens: 20 }, modelId: mid,
            }),
          };
        } };
      }
    }
    const engine = new AiParseEngine(new WithModel());
    const id = await uploadFile('规格.xlsx', xlsxBuffer('第二份'));
    await parseWith(id, engine);
    expect((await fileRow(id)).parse_status).toBe('parsed');
    const body = await parsedBody(id);
    expect(body).toContain('# 结构化标题'); // AI 产出，非兜底
    const usage = await query<{ purpose: string; tokens_in: number }>(
      'SELECT purpose, tokens_in FROM ai_usage WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [PID]);
    expect(usage.rows[0]).toMatchObject({ purpose: 'parsing', tokens_in: 100 });
  });

  it('docx 上传归一为 doc；旧版 .doc（OLE2）解析失败带可行动提示', async () => {
    const id = await uploadFile('老文档.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Buffer.alloc(64)]));
    expect((await fileRow(id)).ext).toBe('doc');
    await parseWith(id, new AiParseEngine(undefined));
    const f = await fileRow(id);
    expect(f.parse_status).toBe('failed');
    expect(f.parse_error).toContain('docx');
  });

  it('extractText：md/txt 直通；未知扩展返回 null', async () => {
    expect(await extractText('md', Buffer.from('# 标题'))).toBe('# 标题');
    expect(await extractText('pptx', Buffer.from('x'))).toBeNull();
  });

  it('extractText：pdf 真实抽取（#1 回归：pdf-parse v2 为 PDFParse 类命名导出）', async () => {
    const text = await extractText('pdf', pdfBuffer('Hello MSF'));
    expect(text).toContain('Hello MSF');
  });
});

/** 程序化构造最小合法单页 PDF（含 xref 偏移表），避免引入二进制夹具 */
function pdfBuffer(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
