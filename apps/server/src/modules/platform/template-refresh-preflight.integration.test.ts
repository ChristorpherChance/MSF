/** preflight 核对报告（集成，需 DB）：report 形态四断言——对版空报告/结构问题带章名/上游滞后第四维/防误报+report=null（设计 §2/§4） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { TemplateRefreshService } from './template-refresh.service.js';
import { resolveTemplate } from './doc-templates.js';
import { anchorPrefixOf } from './template-refresh.js';

const PA = '00000000-0000-0000-0000-0000000000fa'; // 对版 CRD + 无内容册
const PB = '00000000-0000-0000-0000-0000000000fb'; // 结构问题 CRD
const PC = '00000000-0000-0000-0000-0000000000fc'; // 上游滞后链（CRD→PRD→HLD）
const PD = '00000000-0000-0000-0000-0000000000fd'; // 上游不滞后（防误报）
const PE = '00000000-0000-0000-0000-0000000000fe'; // 结构问题 2+ 行 + 滞后行混合（尾部约定多元素钉）
const PIDS = [PA, PB, PC, PD, PE];

async function infraUp(): Promise<boolean> {
  try { await query('SELECT 1 FROM req_documents LIMIT 1'); return true; } catch { return false; }
}

/** 与默认模板对版的内容：大章全齐同序+一条锚点条目节（编号自 1 连续）——auditSkeleton 三维全过 */
function conforming(domain: 'req' | 'design', kind: string): string {
  const t = resolveTemplate(domain, kind)!;
  const anchor = `## ${anchorPrefixOf(kind)}-${domain === 'req' ? '001' : '1'} 示例条目\n条目内容`;
  const chapters = t.chapters.map((c) => `## ${c.title}\n章节内容`);
  chapters.splice(2, 0, anchor); // 条目节插第三章前（条目节不算大章）
  return chapters.join('\n\n');
}

/** 造数：文档行+若干版本行（末版为当前版本，submitted_at 显式可控——滞后派生只比 submitted_at） */
async function seedDoc(pid: string, domain: 'req' | 'design', kind: string,
  versions: Array<{ content: string; at: string }>): Promise<void> {
  const req = domain === 'req';
  const d = req
    ? await query<{ id: string }>(
        'INSERT INTO req_documents (project_id, doc_kind, created_by) VALUES ($1,$2,\'t\') RETURNING id', [pid, kind])
    : await query<{ id: string }>( // dsg_documents name/chapter_prefix 非空（镜像 design docs.service ensureDoc）
        `INSERT INTO dsg_documents (project_id, doc_kind, name, chapter_prefix, created_by)
         VALUES ($1,$2,$3,$4,'t') RETURNING id`, [pid, kind, kind, anchorPrefixOf(kind)]);
  let cur: string | null = null;
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]!;
    const r = req
      ? await query<{ id: string }>(
          `INSERT INTO req_versions (document_id, version_no, content, content_fingerprint, governing_fingerprint, submitted_by, submitted_at)
           VALUES ($1,$2,$3,'fp','gf','t',$4) RETURNING id`, [d.rows[0]!.id, i + 1, v.content, v.at])
      : await query<{ id: string }>(
          `INSERT INTO dsg_versions (document_id, version_no, content, content_fingerprint, governing_fingerprint, refs, submitted_by, submitted_at)
           VALUES ($1,$2,$3,'fp','gf','[]','t',$4) RETURNING id`, [d.rows[0]!.id, i + 1, v.content, v.at]);
    cur = r.rows[0]!.id;
  }
  await query(`UPDATE ${req ? 'req_documents' : 'dsg_documents'} SET current_version_id=$2 WHERE id=$1`,
    [d.rows[0]!.id, cur]);
}

describe('preflight 核对报告（集成，需 DB）', async () => {
  if (!(await infraUp())) { it.skip('postgres 未就绪', () => {}); return; }
  const svc = new TemplateRefreshService(); // preflight 纯只读，无需 onModuleInit 注册命令

  beforeAll(async () => {
    for (const pid of PIDS) {
      await query("INSERT INTO projects (id, name) VALUES ($1,'tr-pf') ON CONFLICT (id) DO NOTHING", [pid]);
    }
    // PA：对版 CRD（其余九册无内容）
    await seedDoc(PA, 'req', 'crd', [{ content: conforming('req', 'crd'), at: '2026-01-01T00:00:00Z' }]);
    // PB：CRD 缺模板末章（六、术语表）→ 大章对照第①段「缺失」行
    const t = resolveTemplate('req', 'crd')!;
    const broken = t.chapters.slice(0, -1).map((c) => `## ${c.title}\n章节内容`).join('\n\n');
    await seedDoc(PB, 'req', 'crd', [{ content: broken, at: '2026-01-01T00:00:00Z' }]);
    // PC：CRD v1(T1)→PRD v1(T2)→CRD v2(T3) 当前版=T3 晚于 PRD；HLD v1(T0) 早于 PRD 当前版
    await seedDoc(PC, 'design', 'hld', [{ content: conforming('design', 'hld'), at: '2026-01-01T00:00:00Z' }]);
    await seedDoc(PC, 'req', 'crd', [
      { content: conforming('req', 'crd'), at: '2026-01-02T00:00:00Z' },
      { content: conforming('req', 'crd'), at: '2026-01-04T00:00:00Z' },
    ]);
    await seedDoc(PC, 'req', 'prd', [{ content: conforming('req', 'prd'), at: '2026-01-03T00:00:00Z' }]);
    // PD：CRD v1(T1) 早于 PRD v1(T2) → 不滞后
    await seedDoc(PD, 'req', 'crd', [{ content: conforming('req', 'crd'), at: '2026-01-02T00:00:00Z' }]);
    await seedDoc(PD, 'req', 'prd', [{ content: conforming('req', 'prd'), at: '2026-01-03T00:00:00Z' }]);
    // PE：PB 缺章夹具叠加滞后链——PRD 缺模板末两章（→ 两行「缺失」）且 CRD v2(T3) 晚于 PRD v1(T2)（→ 滞后行）
    const prdT = resolveTemplate('req', 'prd')!;
    const brokenPrd = prdT.chapters.slice(0, -2).map((c) => `## ${c.title}\n章节内容`).join('\n\n');
    await seedDoc(PE, 'req', 'crd', [
      { content: conforming('req', 'crd'), at: '2026-01-02T00:00:00Z' },
      { content: conforming('req', 'crd'), at: '2026-01-04T00:00:00Z' },
    ]);
    await seedDoc(PE, 'req', 'prd', [{ content: brokenPrd, at: '2026-01-03T00:00:00Z' }]);
  });
  afterAll(async () => {
    for (const pid of PIDS) {
      for (const dom of ['req', 'dsg'] as const) {
        await query(`DELETE FROM ${dom}_pendings WHERE document_id IN (SELECT id FROM ${dom}_documents WHERE project_id=$1)`, [pid]);
        await query(`DELETE FROM ${dom}_drafts WHERE document_id IN (SELECT id FROM ${dom}_documents WHERE project_id=$1)`, [pid]);
        await query(`UPDATE ${dom}_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1`, [pid]);
        await query(`DELETE FROM ${dom}_versions WHERE document_id IN (SELECT id FROM ${dom}_documents WHERE project_id=$1)`, [pid]);
        await query(`DELETE FROM ${dom}_documents WHERE project_id=$1`, [pid]);
      }
      await query('DELETE FROM projects WHERE id=$1', [pid]);
    }
    await pool.end();
  });

  it('对版册：report.issues 空且 upstreamStale=false；CRD 无上游恒 false；无内容册 report=null', async () => {
    const items = await svc.preflight(PA);
    const crd = items.find((i) => i.kind === 'crd')!;
    expect(crd.report).toEqual({ issues: [], upstreamStale: false });
    const hld = items.find((i) => i.kind === 'hld')!; // 无内容册不评
    expect(hld.hasContent).toBe(false);
    expect(hld.report).toBeNull();
    expect(items).toHaveLength(10); // 十册全量返回
  });

  it('结构问题册：issues 非空带章名行（缺失『六、术语表』）', async () => {
    const items = await svc.preflight(PB);
    const crd = items.find((i) => i.kind === 'crd')!;
    expect(crd.report).not.toBeNull();
    expect(crd.report!.issues.length).toBeGreaterThan(0);
    expect(crd.report!.issues.some((s) => s.includes('缺失') && s.includes('术语表'))).toBe(true);
    expect(crd.report!.upstreamStale).toBe(false); // CRD 恒 false（结构问题不引入上游维度）
  });

  it('上游滞后：CRD v2 晚于 PRD 当前 → PRD 尾部追加「上游 CRD 已提交 v2（本册基于 v1）」且 upstreamStale=true；设计册同链（上游=PRD）', async () => {
    const items = await svc.preflight(PC);
    const prd = items.find((i) => i.kind === 'prd')!;
    expect(prd.report!.upstreamStale).toBe(true);
    const tail = prd.report!.issues[prd.report!.issues.length - 1]!; // 滞后行恒在 issues 尾部（前端剔除法约定）
    expect(tail).toBe('上游 CRD 已提交 v2（本册基于 v1）——重排只动结构不动内容，建议先对话改文档同步内容再重排');
    expect(prd.report!.issues).toHaveLength(1); // 结构对版，仅滞后一行
    const hld = items.find((i) => i.kind === 'hld')!; // PRD→设计八册同口径（上游名=PRD）
    expect(hld.report!.upstreamStale).toBe(true);
    expect(hld.report!.issues[hld.report!.issues.length - 1]!).toContain('上游 PRD 已提交 v1（本册基于 v1）');
    const crd = items.find((i) => i.kind === 'crd')!; // CRD 无上游恒 false
    expect(crd.report).toEqual({ issues: [], upstreamStale: false });
  });

  it('上游不滞后：无滞后行且 upstreamStale=false（防误报回归）', async () => {
    const items = await svc.preflight(PD);
    const prd = items.find((i) => i.kind === 'prd')!;
    expect(prd.report).toEqual({ issues: [], upstreamStale: false });
  });

  it('混合场景：结构问题 2+ 行 + 滞后行——滞后行恒在 issues 尾部（多元素钉，前端剔除法依赖）', async () => {
    const items = await svc.preflight(PE);
    const prd = items.find((i) => i.kind === 'prd')!;
    expect(prd.report).not.toBeNull();
    const issues = prd.report!.issues;
    expect(prd.report!.upstreamStale).toBe(true);
    expect(issues).toHaveLength(3); // 两行「缺失」+ 一行滞后
    expect(issues[0]).toContain('缺失');
    expect(issues[1]).toContain('缺失');
    expect(issues[2]).toBe('上游 CRD 已提交 v2（本册基于 v1）——重排只动结构不动内容，建议先对话改文档同步内容再重排');
  });
});
