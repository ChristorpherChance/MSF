/**
 * AI 解析引擎（实机验收修复：mock 桩稿导致 doc/pdf/xlsx 流程走不下去）：
 * - 先本地抽取原始文本：mammoth（doc/docx）、pdf-parse（pdf）、xlsx（SheetJS 逐表转 Markdown 表）
 * - 已配置「解析」用途路由（设置 → 模型 → 用途路由 parsing）→ AI 整理为结构化 Markdown，
 *   用量经 ai.usage.record 落账（purpose='parsing'，REQ-612）
 * - 未配置路由 → 抽取原文直接成稿（真实内容兜底，不再产空桩）；AI 调用失败 → failed 可重试
 * md/txt 直通不走 AI（MockParseEngine 语义保留，测试注入点 PARSE_FAIL 同样保留）
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { executeCommand, type CommandContext } from '../evidence/command-bus.js';
import { AI_PROVIDER, type AiProvider } from '../ai/ai-provider.interface.js';
import type { MatFile, ParseEngine } from './types.js';

/** 喂给模型的原文上限（字符）；超出截断并在稿首注明 */
const AI_INPUT_CAP = 24000;

/** 本地文本抽取：返回 null 表示该格式不支持抽取 */
export async function extractText(ext: string, content: Buffer): Promise<string | null> {
  switch (ext) {
    case 'md':
    case 'txt':
      return content.toString('utf8');
    case 'doc': {
      // mammoth 仅支持 docx（OOXML）；二进制 .doc 提示转换
      if (!isDocx(content)) {
        throw new Error('旧版 .doc 二进制格式不支持解析，请另存为 .docx 后重新上传');
      }
      const m = await import('mammoth');
      const r = await m.default.extractRawText({ buffer: content });
      return r.value;
    }
    case 'pdf': {
      // pdf-parse v2：命名导出 PDFParse 类（无 default 函数），getText() 回 TextResult.text
      const mod = await import('pdf-parse');
      const PDFParse = (mod as unknown as {
        PDFParse: new (opts: { data: Buffer }) => { getText(): Promise<{ text: string }>; destroy(): Promise<void> };
      }).PDFParse;
      const parser = new PDFParse({ data: content });
      try {
        const r = await parser.getText();
        if (!r.text.trim()) {
          throw new Error('PDF 未抽取到文本（扫描件需 OCR，当前版本不支持）');
        }
        return r.text;
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    }
    case 'xlsx': {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(content, { type: 'buffer' });
      const parts: string[] = [];
      for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        if (!sheet) continue;
        const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
        const cells = rows.map((r) => r.map((c) => String(c ?? '').trim()));
        while (cells.length && cells[cells.length - 1]!.every((c) => !c)) cells.pop();
        if (!cells.length) continue;
        parts.push(`## 工作表：${name}\n\n${rowsToMd(cells)}`);
      }
      return parts.join('\n\n');
    }
    default:
      return null;
  }
}

/** docx=zip 容器（PK 头）；.doc 为 OLE2 复合文档（\xD0\xCF\x11\xE0） */
function isDocx(content: Buffer): boolean {
  return content.length > 2 && content[0] === 0x50 && content[1] === 0x4b;
}

/** 单元格二维数组 → Markdown 表（首行表头；空列名补 colN；| 转义） */
function rowsToMd(cells: string[][]): string {
  const width = Math.max(...cells.map((r) => r.length));
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const head = cells[0]!;
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => esc(r[i] ?? '') || (i < head.length ? '' : '')).join(' | ')} |`;
  const header = Array.from({ length: width }, (_, i) => esc(head[i] ?? '') || `列${i + 1}`);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...cells.slice(1).map(line),
  ].join('\n');
}

/** 原始抽取文本 → 兜底成稿（保留真实内容，附来源说明） */
function rawToMd(file: MatFile, raw: string, note?: string): string {
  return `# ${file.name}\n\n${note ? `> ${note}\n\n` : ''}${raw.trim()}\n`;
}

const PARSE_PROMPT = `你是文档解析器。把下面从「{name}」抽取的原始文本整理为结构良好的 Markdown：
- 还原文档标题层级（# / ## / ###），去除页眉页脚、页码、断行碎片
- 表格整理为 Markdown 表格；列表保留层级
- 不新增、不概括、不删减实质内容；拿不准的按原文保留
- 只输出 Markdown 正文，不要任何解释

原始文本：
"""
{text}
"""`;

@Injectable()
export class AiParseEngine implements ParseEngine {
  constructor(@Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider) {}

  async parse(file: MatFile, content: Buffer): Promise<string> {
    if (content.includes('PARSE_FAIL')) throw new Error('mock 解析失败（注入）'); // 测试注入点
    const raw = await extractText(file.ext, content);
    if (raw === null) throw new Error(`格式 ${file.ext} 不支持解析`);
    if (file.ext === 'md' || file.ext === 'txt') return raw; // 直通
    if (!raw.trim()) throw new Error('未抽取到文本内容');

    // 无 AI 编排（mock 环境）或未配解析路由 → 原文兜底成稿
    if (!this.ai || this.ai.kind !== 'pi') {
      return rawToMd(file, raw, '本地抽取稿（配置「解析」用途模型路由后可 AI 结构化整理）');
    }
    const projectId = file.project_id;
    const ctx: CommandContext = { projectId, actorKind: 'assistant', actorId: 'parse-engine' };
    let session;
    try {
      session = await this.ai.createSession({ projectId, purpose: 'parsing' });
    } catch {
      return rawToMd(file, raw, '本地抽取稿（未配置「解析」用途模型路由，设置 → 模型可配）');
    }
    const t0 = Date.now();
    const truncated = raw.length > AI_INPUT_CAP;
    const text = truncated ? `${raw.slice(0, AI_INPUT_CAP)}\n\n[原文过长，已截断]` : raw;
    const { deltas, result } = session.stream(PARSE_PROMPT.replace('{name}', file.name).replace('{text}', text));
    for await (const _d of deltas) { void _d; /* 排干 */ }
    const res = await result;
    if (!res.text.trim()) throw new Error('AI 解析返回空内容');
    if (res.modelId) {
      await executeCommand('ai.usage.record', {
        projectId, modelId: res.modelId, purpose: 'parsing',
        tokensIn: res.usage.inputTokens, tokensOut: res.usage.outputTokens,
        durationMs: Date.now() - t0, cost: res.usage.cost ?? 0,
      }, ctx);
    }
    return res.text.trim() + '\n';
  }
}
