/** 对话改文档 + 增量修订归一化（集成，需 DB）：GenerateService 旁路与既有流归一化双链断言 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import type { AiMessageResult, AiProvider, AiSession } from '../ai/ai-provider.interface.js';
import { PolicyService } from '../policy/policy.service.js';
import { ReqDocsService } from './docs.service.js';
import { GenerateService, genTiming } from './generate.service.js';

const PID = '00000000-0000-0000-0000-0000000000e1';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };

/** 假 pi provider：createSession 返回预置全文（kind='pi' 才走 driveReal） */
class FakePiProvider implements AiProvider {
  readonly kind = 'pi' as const;
  text = '';
  async createSession(): Promise<AiSession> {
    const text = this.text;
    return {
      sessionId: 'fake-pi',
      stream: () => ({
        deltas: (async function* () { yield text; })(),
        result: Promise.resolve({ text, usage: { inputTokens: 1, outputTokens: 1 } } satisfies AiMessageResult),
      }),
      steer: () => {},
      stop: () => {},
    };
  }
}

async function infraUp(): Promise<boolean> {
  try { await query('SELECT 1 FROM req_documents LIMIT 1'); return true; } catch { return false; }
}

describe('对话改文档/归一化（集成，需 DB）', async () => {
  if (!(await infraUp())) { it.skip('postgres 未就绪', () => {}); return; }
  genTiming.chunkDelayMs = 0;
  const docs = new ReqDocsService(new PolicyService());
  const gen = new GenerateService();
  const fakePi = new FakePiProvider();
  const genPi = new GenerateService(fakePi);
  resetCommands();
  docs.onModuleInit();
  gen.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'pe-e1') ON CONFLICT (id) DO NOTHING", [PID]);
    await docs.listDocs(PID, CTX); // provisioning 模板 v1
  });
  afterAll(async () => {
    await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_documents WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_links WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_health WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  interface DocView { cur: number; contentFingerprint: string; secs: Array<{ id: string; title: string; md: string }> }
  const view = async (kind: 'crd' | 'prd') => (await docs.getDoc(PID, kind)) as unknown as DocView;
  /** 写入两节 CR 内容并提交为新版本（清 modified，让指纹/补丁流可预期） */
  async function seedSections(): Promise<void> {
    const d = await view('crd');
    await docs.saveDraft(PID, 'crd', {
      secId: d.secs[0]!.id,
      md: '引言\n\n## CR-001 门户首页\n\n承接：R-001\n\n旧正文。\n\n## CR-002 检索\n\n承接：R-002',
      baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX);
    const d2 = await view('crd');
    await docs.commit(PID, 'crd', 'seed', d2.cur, CTX);
  }

  it('既有增量修订流挂归一化：命中 CR-001 的 AI 产出转 modify，不再重复追加', async () => {
    await seedSections();
    fakePi.text = '## CR-001 门户首页\n\n承接：R-001\n\n新正文（支持手柄）。';
    const started = await genPi.start(PID, 'crd', { referenceFileIds: [], referenceFingerprints: {}, instruction: '把 CR-001 改为支持手柄' }, CTX);
    const r = await genPi.drive(started.operationId, CTX, () => {});
    expect(r.status).toBe('done');
    const patches = (await docs.listPatches(PID, 'crd')) as {
      items: Array<{ patchId: string; type: string; secId: string; status: string }>;
    };
    const pend = patches.items.filter((p) => p.status === 'pending');
    expect(pend).toHaveLength(1);
    expect(pend[0]!.type).toBe('modify'); // 归一化生效：非 add 重复追加
    await docs.rejectPatch(PID, 'crd', pend[0]!.patchId, CTX, '归一化验证完毕');
  });
});
