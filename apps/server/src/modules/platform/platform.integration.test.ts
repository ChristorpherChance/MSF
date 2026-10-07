/** M7 平台域集成测试（T7-02~05/09/10：需 DB + MinIO，见 storage.service.test.ts 头注） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { executeCommand, resetCommands } from '../evidence/command-bus.js';
import { NotificationsService } from './notifications.service.js';
import { PlatformReadService } from './platform-read.service.js';
import { SettingsService } from './settings.service.js';
import { TemplateSetsService } from './template-sets.service.js';
import { BackupsService } from './backups.service.js';
import { StorageService } from './storage.service.js';

const PID = '00000000-0000-0000-0000-000000000007';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };
const SYS = { projectId: null, actorKind: 'human' as const, actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM sys_notifications LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

describe('M7 平台域（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  const storage = new StorageService();
  const notices = new NotificationsService();
  const read = new PlatformReadService();
  const settings = new SettingsService(notices);
  const tsets = new TemplateSetsService();
  const backups = new BackupsService(storage, notices);
  resetCommands();
  notices.onModuleInit();
  read.onModuleInit();
  settings.onModuleInit();
  tsets.onModuleInit();
  backups.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm7-platform-test') ON CONFLICT (id) DO NOTHING", [PID]);
  });
  afterAll(async () => {
    await query('DELETE FROM sys_notifications WHERE project_id=$1', [PID]);
    await query('DELETE FROM evd_events WHERE project_id=$1', [PID]);
    await query('DELETE FROM policy_gate_events WHERE project_id=$1', [PID]);
    await query('DELETE FROM policy_gates WHERE project_id=$1', [PID]);
    await query('DELETE FROM sys_settings WHERE key LIKE $1', ['m7test.%']);
    await query('DELETE FROM dev_tasks WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1', [PID]);
    await query("UPDATE projects SET stage_gates='{}' WHERE id=$1", [PID]);
    await storage.removePrefix(`backups/${PID}/`).catch(() => undefined);
    await query('DELETE FROM sys_backups WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  // ---- T7-02 阶段准入（A02-4） ----

  it('stages：空项目五门全不满足且缺口码具体', async () => {
    const r = await read.stages(PID, CTX);
    expect(r.stages.map((s) => s.stage)).toEqual(['material', 'req', 'design', 'dev', 'test']);
    expect(r.stages.every((s) => !s.ok)).toBe(true);
    expect(r.stages[0]!.issues[0]!.code).toBe('MATERIAL_EMPTY');
    expect(r.stages[1]!.issues.some((i) => i.code === 'PRD_NOT_FINAL')).toBe(true);
    expect(r.stages[2]!.issues[0]!.code).toBe('BASELINE_MISSING');
    expect(r.stages[3]!.issues[0]!.code).toBe('BUILD_MISSING');
    expect(r.stages[4]!.issues[0]!.code).toBe('RELEASE_MISSING');
  });

  it('stages：变化驱动快照——求值结果落 projects.stage_gates 且审计留痕；无变化不重复写', async () => {
    await query(
      `INSERT INTO mat_files (project_id, code, name, ext, size_bytes, object_key, content_fingerprint, source, parse_status, created_by)
       VALUES ($1, 'MF-T01', '招标文件.md', 'md', 10, 'm7test/a', $2, 'upload', 'content_final', 'local')`,
      [PID, 'a'.repeat(64)]);
    const before = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE command='platform.stage_gates.snapshot' AND project_id=$1", [PID]);
    const r = await read.stages(PID, CTX);
    expect(r.stages[0]!.ok).toBe(true);
    const pj = await query<{ stage_gates: Array<{ stage: string; ok: boolean }> }>(
      'SELECT stage_gates FROM projects WHERE id=$1', [PID]);
    expect(pj.rows[0]!.stage_gates.find((s) => s.stage === 'material')!.ok).toBe(true);
    const after1 = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE command='platform.stage_gates.snapshot' AND project_id=$1", [PID]);
    expect(after1.rows[0]!.n).toBe(before.rows[0]!.n + 1);
    await read.stages(PID, CTX); // 无变化
    const after2 = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE command='platform.stage_gates.snapshot' AND project_id=$1", [PID]);
    expect(after2.rows[0]!.n).toBe(after1.rows[0]!.n);
  });

  // ---- T7-03 任务中心 + 事件流（A02-5/6） ----

  it('tasks：sys_tasks_view 归并开发任务，stage/status 过滤与分页', async () => {
    await query(
      `INSERT INTO dev_tasks (project_id, code, title, kind, owner, quality, created_by)
       VALUES ($1,'T-M701','栏目空状态','frontend','local','{}','local')`,
      [PID]);
    const all = await read.tasks(PID, {});
    expect(all.total).toBe(1);
    expect(all.items[0]).toMatchObject({ stage: 'dev', code: 'T-M701', title: '栏目空状态' });
    expect(all.items[0]!.updatedAt).toBeTruthy();
    const empty = await read.tasks(PID, { stage: 'test' });
    expect(empty.total).toBe(0);
  });

  it('events：evidence.event.emit 后事件流可读（游标分页）', async () => {
    await notices.emitEvent(CTX, 'stage.material', { text: '招标文件.md 解析完成' });
    const r = await read.events(PID, {});
    expect(r.items.some((e) => e.type === 'stage.material')).toBe(true);
    const p2 = await read.events(PID, { cursor: r.items[0]!.at, limit: 10 });
    expect(p2.items.every((e) => e.at < r.items[0]!.at)).toBe(true);
  });

  // ---- T7-04 设置（A10-1） ----

  it('settings：点分层级键 UPSERT 并可读回；密钥类键拒绝', async () => {
    await settings.set('m7test.zip.limits.maxEntries', 500, SYS);
    await settings.set('m7test.zip.limits.maxEntries', 800, SYS);
    const all = await settings.getAll();
    expect(all['m7test.zip.limits.maxEntries']).toBe(800);
    await expect(settings.set('badkey', 1, SYS)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(settings.set('m7test.api.secret_key', 'x', SYS)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('policy-gates：默认 manual；无理由拒绝；切换留痕；unchanged 幂等', async () => {
    const g0 = await settings.listGates(PID);
    expect(g0.gates.length).toBe(7);
    expect(g0.gates.every((g) => g.mode === 'manual')).toBe(true);
    await expect(settings.setGateMode(PID, g0.gates[0]!.gateKey, 'auto', '', CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const gk = g0.gates[0]!.gateKey;
    const r1 = (await settings.setGateMode(PID, gk, 'auto', '演练授权', CTX)) as { mode: string };
    expect(r1.mode).toBe('auto');
    const r2 = (await settings.setGateMode(PID, gk, 'auto', '重复操作', CTX)) as { unchanged?: boolean };
    expect(r2.unchanged).toBe(true);
    const ev = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM policy_gate_events WHERE project_id=$1 AND gate_key=$2', [PID, gk]);
    expect(ev.rows[0]!.n).toBe(1); // unchanged 不产生留痕
    const g1 = await settings.listGates(PID);
    expect(g1.gates.find((g) => g.gateKey === gk)!.mode).toBe('auto');
    // W7：切换通知项目成员（sys_notifications 全员行）
    const nt = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM sys_notifications WHERE project_id=$1 AND type='policy.gate.switched'", [PID]);
    expect(nt.rows[0]!.n).toBe(1); // unchanged 幂等不重复通知
  });

  it('policy-gates：前置条件编辑（§3.9 放行策略卡）', async () => {
    const gk = 'dev.transfer';
    await settings.setPreconditions(PID, gk, ['自测报告通过', ' 单元测试达标 ', ''], CTX);
    const g = await settings.listGates(PID);
    expect(g.gates.find((x) => x.gateKey === gk)!.preconditions).toEqual(['自测报告通过', '单元测试达标']);
    await expect(settings.setPreconditions(PID, 'bad.gate', ['x'], CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const audit = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE command='policy.gate.set_preconditions'", []);
    expect(audit.rows[0]!.n).toBeGreaterThanOrEqual(1);
  });

  // ---- T7-05 通知（A10-2） ----

  it('notifications：emit 全员通知→list 未读→read/read_all', async () => {
    const id = await notices.emit(CTX, { type: 'm7test.ping', text: '平台域联调通知' });
    const l1 = await notices.list({ unreadOnly: true, projectId: PID }, 'local');
    expect(l1.items.some((n) => n.id === id && n.unread)).toBe(true);
    expect(l1.unreadCount).toBeGreaterThan(0);
    await notices.read(id, SYS);
    const l2 = await notices.list({ unreadOnly: false, projectId: PID }, 'local');
    expect(l2.items.find((n) => n.id === id)!.unread).toBe(false);
    const rc = await notices.readAll(SYS);
    expect(rc.count).toBeGreaterThanOrEqual(0);
  });

  it('notifications：eventKind 同事务落 evd_events', async () => {
    const id = await notices.emit(CTX, { type: 'm7test.with-event', text: 'x', eventKind: 'm7test.notice' });
    const ev = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM evd_events WHERE project_id=$1 AND kind='m7test.notice' AND payload->>'noticeId'=$2",
      [PID, id]);
    expect(ev.rows[0]!.n).toBe(1);
  });

  // ---- T7-09 审计查询（A10-3） ----

  it('audit：只读查询含哈希链字段；命令过滤生效', async () => {
    await executeCommand('system.settings.set', { key: 'm7test.audit.probe', value: 1 }, SYS);
    const r = await read.audit({ command: 'system.settings.set', limit: 10 });
    const row = r.items.find((i) => i.hashChainPrev !== undefined);
    expect(row).toBeTruthy();
    expect(row!.actorType).toBe('human');
    expect(row!.inputFingerprint).toMatch(/^sha256:/);
    expect(row!.result).toBe('ok');
    const exp = await read.auditExport({ projectId: PID });
    expect(exp.count).toBeGreaterThan(0);
  });

  // ---- T7-10 备份导出（A10-4） ----

  it('backups:export：202 operationId + 包落 MinIO + manifest sha256 + 完成通知', async () => {
    const { operationId } = await backups.export(PID, { scope: 'project', includeEvidence: true }, CTX);
    expect(operationId).toMatch(/^op_bak_/);
    // 同步触发异步执行：轮询完成通知
    let text = '';
    for (let i = 0; i < 40; i++) {
      const n = await query<{ text: string }>(
        "SELECT text FROM sys_notifications WHERE project_id=$1 AND type IN ('backup.completed','backup.failed') ORDER BY created_at DESC LIMIT 1",
        [PID]);
      if (n.rows[0]) { text = n.rows[0].text; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(text).toContain('备份导出完成');
    expect(text).toContain('http'); // 签名下载 URL
    const body = await storage.getObject(`backups/${PID}/${operationId}.json`);
    const bundle = JSON.parse(body.toString()) as {
      format: string; manifest: Array<{ table: string; rows: number; sha256: string }>;
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    expect(bundle.format).toBe('msf-backup/v1');
    expect(bundle.manifest.length).toBeGreaterThan(30);
    for (const m of bundle.manifest) expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.tables['ai_models']).toBeUndefined(); // 系统级登记不随项目导出
    expect(JSON.stringify(bundle)).not.toContain('api_key_enc'); // 密钥绝不导出（N02-3）
    expect(bundle.tables['audit_log']).toBeDefined(); // includeEvidence
    const ev = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM evd_events WHERE project_id=$1 AND kind='backup.exported'", [PID]);
    expect(ev.rows[0]!.n).toBeGreaterThanOrEqual(1);
    // W7：sys_backups 历史行 + list 附签名下载链接（§3.9 备份卡）
    const hist = await backups.list(PID);
    const row = hist.items.find((b) => b.operationId === operationId)!;
    expect(row.status).toBe('completed');
    expect(row.tableCount).toBeGreaterThan(30);
    expect(row.downloadUrl).toContain('http');
  }, 20000);

  it('backups:export：scope 非 project 拒绝；项目不存在 404', async () => {
    await expect(backups.export(PID, { scope: 'global' }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(backups.export('00000000-0000-0000-0000-000000000099', {}, CTX))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('模板套件：创建→条目保存→绑定项目生成链生效→kind 级换源→绑定态删套件级联解绑（自动回退默认）', async () => {
    const { buildTemplateGuide, refreshTemplateOverrides, codeDefaultTemplate, templateSourceOf } = await import('./doc-templates.js');
    await refreshTemplateOverrides();
    const setName = `测试套件-${Date.now()}`;
    let setId = '';
    try {
      // 专业度闸：水化条目被拒（与代码默认测试门槛同源）
      const created = (await tsets.createSet(setName, '测试用', undefined, CTX)) as { setId: string };
      setId = created.setId;
      await expect(tsets.saveItem(setId, 'crd', {
        standard: 'X', quality: '随意', writingRules: ['短'], chapters: [{ title: 'Chapter 1', requires: '少' }],
      }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // 合法条目保存 → 绑定 → 生成链注入块生效
      await tsets.saveItem(setId, 'crd', {
        standard: 'ACME 公司模板规范 v3',
        quality: '每条需求按公司模板三栏（描述/规则/验收）填写，违者退回。',
        writingRules: ['公司模板标题须带 ACME- 前缀且顺延', '每条需求须双语（中英）', '验收要点须给测量方法'],
        chapters: [
          { title: '一、公司背景', requires: '公司级业务背景与合规声明（按 ACME 模板第 2 节）' },
          { title: '二、公司需求', requires: 'ACME-nnn 条目三栏：描述/规则/验收（可测量）' },
          { title: '三、公司约束', requires: '合规/法务/数据驻留约束（按 ACME 法务清单）' },
          { title: '四、公司术语', requires: '公司术语表（中英对照，与集团术语库口径一致并注明出处）' },
        ],
      }, CTX);
      // 未绑定前：本项目仍走代码默认
      expect(buildTemplateGuide('req', 'crd', PID)).toContain('29148');
      await tsets.bind(PID, setId, CTX);
      const guide = buildTemplateGuide('req', 'crd', PID);
      expect(guide).toContain('ACME 公司模板规范 v3');
      expect(guide).toContain('一、公司背景');
      // 套件未覆盖的 kind 回退代码默认（「基于默认模板创建一整套」回退链）
      expect(buildTemplateGuide('req', 'prd', PID)).toContain('29148');
      expect(templateSourceOf(PID, 'crd')).toEqual({ source: 'set', setId });

      // ---- kind 级换源（2026-10-07：📄 弹窗按文档类别指定其他套件/默认） ----
      const setB = (await tsets.createSet(`测试套件B-${Date.now()}`, '', undefined, CTX)) as { setId: string };
      try {
        // 套件 B 不含 prd 条目：kind 级绑定被拒（守卫「绑了也是空解析」）
        await expect(tsets.bindKind(PID, 'prd', setB.setId, CTX))
          .rejects.toMatchObject({ code: 'INVALID_STATE' });
        await tsets.saveItem(setB.setId, 'prd', {
          standard: 'BETA 公司 PRD 规范 v1',
          quality: '每个功能点须给出验收标准与优先级两栏，缺一退回。',
          writingRules: ['功能点编号 FP-nnn 顺延不重号', '验收标准必须可测量可复核', '每条功能点给出依赖前置'],
          chapters: [
            { title: '一、产品概述', requires: '目标用户/核心价值/范围边界各一段（按 BETA 模板第 1 节）' },
            { title: '二、功能清单', requires: 'FP-nnn 两栏：验收标准+优先级（可测量）' },
            { title: '三、流程', requires: '主流程与异常流程分节描述，每节含分支条件与出口（可验收粒度）' },
            { title: '四、非功能', requires: '性能/安全/可用性条款各给目标值与测量方法（可验收粒度）' },
          ],
        }, CTX);
        await tsets.bindKind(PID, 'prd', setB.setId, CTX);
        // 三级解析链：kind 级指定 > 项目套件 > 代码默认
        expect(buildTemplateGuide('req', 'prd', PID)).toContain('BETA 公司 PRD 规范 v1');
        expect(templateSourceOf(PID, 'prd')).toEqual({ source: 'kind', setId: setB.setId });
        expect(buildTemplateGuide('req', 'crd', PID)).toContain('ACME'); // crd 仍走项目套件
        // 取消 kind 级指定 → 回退跟随项目套件（prd 套件 A 未覆盖 → 代码默认）
        await tsets.bindKind(PID, 'prd', null, CTX);
        expect(buildTemplateGuide('req', 'prd', PID)).toContain('29148');
      } finally {
        await query('DELETE FROM prj_template_kind_binding WHERE set_id=$1', [setB.setId]);
        await query('DELETE FROM sys_template_sets WHERE id=$1', [setB.setId]);
        await refreshTemplateOverrides();
      }

      // 绑定态删除=级联解绑（拍板：「新增的都应该可以删除」，绑定项目自动回退默认）
      const del = (await tsets.deleteSet(setId, CTX)) as { unboundProjects: number };
      setId = '';
      expect(del.unboundProjects).toBe(1); // 本项目绑定被同事务解除
      expect(buildTemplateGuide('req', 'crd', PID)).toContain('29148'); // 回基线
      expect(buildTemplateGuide('req', 'crd', PID)).not.toContain('ACME');
      expect(codeDefaultTemplate('crd')!.standard).toContain('29148'); // 代码基线零污染
    } finally {
      if (setId) {
        await query('DELETE FROM prj_template_binding WHERE set_id=$1', [setId]);
        await query('DELETE FROM prj_template_kind_binding WHERE set_id=$1', [setId]);
        await query('DELETE FROM sys_template_sets WHERE id=$1', [setId]);
        await refreshTemplateOverrides();
      }
      await query('DELETE FROM prj_template_binding WHERE project_id=$1', [PID]);
      await query('DELETE FROM prj_template_kind_binding WHERE project_id=$1', [PID]);
    }
  });
});
