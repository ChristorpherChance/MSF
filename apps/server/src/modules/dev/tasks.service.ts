import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { developGateIssues, latestBaseline } from './gate-common.js';

/**
 * 任务识别与任务池（A06-1~5；REQ-401/402/403）。
 * mock 识别口径：设计目录页面条目 → frontend 任务（逐页）+ common/integration 骨架任务；
 * 任务规格字段全量（kind/owner/scope/writeScopes/deps/acceptance/quality，REQ-402）；
 * 识别幂等：同基线指纹重复识别不产生重复任务（已存在的 code 跳过）。
 * W6：dev.task.save 扩全字段（rev++、覆盖重置 pending）；dev.task.create / dev.task.improve /
 * dev.plan.schedule 三命令承接原型手动操作条（识别/核对覆盖/完善任务/编排计划）。
 */

const KINDS = ['frontend', 'backend', 'common', 'integration'] as const;

/** 质量场景行（正常/边界/异常三场景；applicable=false 须带不适用理由） */
interface QualityScenario {
  type: string; applicable?: boolean; case?: string; expected?: string; pass?: string;
  notApplicableReason?: string;
}
/** 质量规格（dev_tasks.quality jsonb；L4b 起导出供准备建议共用） */
export interface QualitySpec { object: string; scenarios: QualityScenario[]; line: number; branch: number }

/** 规格补齐结果（dev.task.improve 与准备 patch 建议共用的字段集） */
export interface SpecPatch {
  goal: string; scope: string; boundary: string; owner: string; effort: string;
  work: unknown[]; inputs: unknown[]; deliverables: unknown[]; acceptance: unknown[];
  quality: QualitySpec;
}

const lines = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean)
    : String(v ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/** 规格问题实时求值（原型 devSpecIssues 同口径；返回 {code,message} 列表） */
export function specIssues(t: Record<string, unknown>): Array<{ code: string; field: string; message: string }> {
  const issues: Array<{ code: string; field: string; message: string }> = [];
  const add = (code: string, field: string, message: string) => issues.push({ code, field, message });
  if (!String(t.title ?? '').trim()) add('SPEC_TITLE', 'title', '缺少任务名称');
  if (!String(t.goal ?? '').trim()) add('SPEC_GOAL', 'goal', '缺少明确目标');
  if (!String(t.scope ?? '').trim()) add('SPEC_SCOPE', 'scope', '缺少范围边界');
  if (!String(t.boundary ?? '').trim()) add('SPEC_BOUNDARY', 'boundary', '缺少执行边界');
  const sourceIds = lines(t.source_ids ?? t.sourceIds);
  if (sourceIds.length === 0) add('SPEC_SOURCE', 'sourceIds', '缺少版本化来源或技术决策');
  if (lines(t.work).length === 0) add('SPEC_WORK', 'work', '缺少具体工作');
  if (lines(t.inputs).length === 0) add('SPEC_INPUT', 'inputs', '缺少输入与依赖说明');
  if (lines(t.deliverables).length === 0) add('SPEC_DELIVERABLE', 'deliverables', '缺少交付物');
  const acc = t.acceptance;
  const accOk = Array.isArray(acc)
    ? acc.some((x) => String(typeof x === 'object' && x !== null ? (x as Record<string, unknown>).item ?? '' : x).trim())
    : lines(acc).length > 0;
  if (!accOk) add('SPEC_ACCEPTANCE', 'acceptance', '缺少验收条件');
  if (!KINDS.includes(t.kind as (typeof KINDS)[number])) add('SPEC_KIND', 'kind', '前后端分工必须明确');
  if (!String(t.owner ?? '').trim()) add('SPEC_OWNER', 'owner', '缺少承接人');
  if (!String(t.effort ?? '').trim()) add('SPEC_EFFORT', 'effort', '缺少工作量估算');
  const ws = lines(t.write_scopes ?? t.writeScopes);
  if (ws.length === 0) add('SPEC_WRITE_SCOPE', 'writeScopes', '缺少代码写入范围');
  else if (ws.some((s) => s.startsWith('/') || s.includes('..'))) {
    add('SPEC_WRITE_SCOPE', 'writeScopes', '代码写入范围必须是仓库内相对路径，且不能上跳');
  }
  const q = (t.quality ?? {}) as Partial<QualitySpec>;
  const scenarios = Array.isArray(q.scenarios) ? q.scenarios : [];
  if (!String(q.object ?? '').trim()) add('SPEC_QUALITY_OBJECT', 'quality.object', '缺少测试对象');
  if (!scenarios.some((x) => x.type === 'normal' && x.applicable !== false)) {
    add('SPEC_QUALITY_SCENARIO', 'quality.scenarios', '正常场景必须定义');
  }
  for (const x of scenarios.filter((s) => s.applicable !== false)) {
    if (!String(x.case ?? '').trim() || !String(x.expected ?? '').trim() || !String(x.pass ?? '').trim()
      || /待补充|待完善/.test(String(x.pass ?? ''))) {
      add('SPEC_QUALITY_DETAIL', 'quality.scenarios', '适用场景需包含可执行的用例、预期和通过条件');
      break;
    }
  }
  for (const type of ['boundary', 'exception']) {
    const rows = scenarios.filter((x) => x.type === type);
    if (rows.length === 0 || rows.every((x) => x.applicable === false && !String(x.notApplicableReason ?? '').trim())) {
      add('SPEC_QUALITY_APPLICABILITY', 'quality.scenarios', `${type} 场景缺失且没有不适用理由`);
    }
  }
  const line = Number(q.line); const branch = Number(q.branch);
  if (!Number.isFinite(line) || !Number.isFinite(branch) || line <= 0 || line > 100 || branch <= 0 || branch > 100) {
    add('SPEC_QUALITY_THRESHOLD', 'quality', '行/分支覆盖率须明确填写 1–100');
  }
  return issues;
}

/**
 * 缺失/不可执行规格字段的补齐计算（dev.task.improve 与 dev.plan.prepare 的 patch-task 建议共用同一口径；
 * 仅补缺，保留已有具体标准——原型 devImproveTasks 逐字段 CASE-WHEN 语义的纯函数化）
 */
export function improveSpecPatch(t: Record<string, unknown>): SpecPatch | null {
  if (specIssues(t).length === 0) return null;
  const q: Partial<QualitySpec> = { ...((t.quality ?? {}) as Partial<QualitySpec>) };
  if (!String(q.object ?? '').trim()) q.object = String(t.title);
  const scenarios = Array.isArray(q.scenarios) ? [...q.scenarios] : [];
  const DEFAULTS: Record<string, { case: string; expected: string; pass: string }> = {
    normal: { case: '按任务目标完成主要业务路径', expected: '产生规格中定义的交付结果', pass: '主要业务结果和状态断言全部通过' },
    boundary: { case: '输入处于边界值', expected: '给出明确且可恢复的反馈', pass: '状态一致且无崩溃' },
  };
  // 三场景逐一落位：缺失补默认、存在但字段空则仅补缺（保留已有具体标准）
  let normal = scenarios.find((x) => x.type === 'normal');
  if (!normal) { normal = { type: 'normal', applicable: true }; scenarios.push(normal); }
  normal.applicable = true;
  for (const k of ['case', 'expected', 'pass'] as const) {
    if (!String(normal[k] ?? '').trim() || (k === 'pass' && /待补充|待完善/.test(String(normal.pass)))) normal[k] = DEFAULTS.normal![k];
  }
  let boundary = scenarios.find((x) => x.type === 'boundary');
  if (!boundary) { boundary = { type: 'boundary', applicable: true }; scenarios.push(boundary); }
  if (boundary.applicable !== false) {
    for (const k of ['case', 'expected', 'pass'] as const) {
      if (!String(boundary[k] ?? '').trim()) boundary[k] = DEFAULTS.boundary![k];
    }
  } else if (!String(boundary.notApplicableReason ?? '').trim()) {
    boundary.notApplicableReason = '边界输入由上游校验层统一拦截';
  }
  let exception = scenarios.find((x) => x.type === 'exception');
  if (!exception) { exception = { type: 'exception', applicable: false }; scenarios.push(exception); }
  if (exception.applicable !== false) {
    for (const k of ['case', 'expected', 'pass'] as const) {
      if (!String(exception[k] ?? '').trim()) {
        exception[k] = { case: '依赖异常或输入非法', expected: '返回明确错误码', pass: '不留中间态且可重试' }[k];
      }
    }
  } else if (!String(exception.notApplicableReason ?? '').trim()) {
    exception.notApplicableReason = '异常由上游公共错误层统一覆盖';
  }
  if (!(Number(q.line) > 0)) q.line = 80;
  if (!(Number(q.branch) > 0)) q.branch = 70;

  const blank = (v: unknown) => !String(v ?? '').trim();
  const emptyArr = (v: unknown) => !Array.isArray(v) || v.length === 0;
  const ws = lines(t.write_scopes ?? t.writeScopes);
  return {
    goal: blank(t.goal) ? `按冻结输入完成「${String(t.title)}」，产物可独立验收` : String(t.goal),
    scope: blank(t.scope) ? (ws[0] ?? '待指定') : String(t.scope),
    boundary: blank(t.boundary) ? '仅修改列出的交付物；不改公共接口与冻结输入' : String(t.boundary),
    owner: blank(t.owner) ? 'mock-agent' : String(t.owner),
    effort: blank(t.effort) ? 'M' : String(t.effort),
    work: emptyArr(t.work) ? ['实现规格中的正常路径', '补齐边界处理与可观测日志'] : (t.work as unknown[]),
    inputs: emptyArr(t.inputs) ? ['已确认输入基线', '对应设计锚点与验收口径'] : (t.inputs as unknown[]),
    deliverables: emptyArr(t.deliverables) ? ws : (t.deliverables as unknown[]),
    acceptance: emptyArr(t.acceptance) ? [{ item: '正常路径符合来源条款', pass: false }] : (t.acceptance as unknown[]),
    quality: { object: String(q.object), scenarios, line: Number(q.line), branch: Number(q.branch) },
  };
}

/** 应用规格补丁（improve 与准备 patch-task 建议批准落池共用）：全字段写入 + rev++ + 覆盖重置 pending */
export async function applySpecPatch(
  client: PoolClient, projectId: string, taskId: string, patch: SpecPatch, actorId: string,
): Promise<void> {
  // SET 子句中列名引用旧值：rev=rev+1 先于 coverage 子查询内 rev 引用（同一旧值），故 task_rev 用 rev+1
  await client.query(
    `UPDATE dev_tasks SET
       goal=$3, scope=$4, boundary=$5, owner=$6, effort=$7,
       work=$8, inputs=$9, deliverables=$10, acceptance=$11, quality=$12,
       rev=rev+1,
       coverage=(SELECT COALESCE(jsonb_agg(jsonb_build_object('item_id',c->>'item_id','status','pending','task_rev',rev+1)),'[]'::jsonb)
                 FROM jsonb_array_elements(coverage) AS c),
       updated_by=$13, updated_at=now()
     WHERE id=$1 AND project_id=$2`,
    [taskId, projectId, patch.goal, patch.scope, patch.boundary, patch.owner, patch.effort,
      JSON.stringify(patch.work), JSON.stringify(patch.inputs), JSON.stringify(patch.deliverables),
      JSON.stringify(patch.acceptance), JSON.stringify(patch.quality), actorId]);
}

/** 依赖拓扑编排（原型 devDependencyPlan 同口径）：自依赖/缺失/循环 → 拒绝；写入范围重叠串行到后批次 */
export function scheduleBatches(tasks: Array<{ id: string; code: string; deps: string[]; write_scopes: string[] }>) {
  const byCode = new Map(tasks.map((t) => [t.code, t]));
  const issues: Array<{ code: string; message: string }> = [];
  for (const t of tasks) {
    for (const dep of t.deps) {
      if (dep === t.code) issues.push({ code: 'DEP_SELF', message: `${t.code} 自依赖` });
      else if (!byCode.has(dep)) issues.push({ code: 'DEP_MISSING', message: `${t.code} 依赖不存在的 ${dep}` });
    }
  }
  // 循环检测（DFS 三色）
  const visiting = new Set<string>(); const done = new Set<string>();
  const visit = (code: string, stack: string[]) => {
    if (visiting.has(code)) {
      issues.push({ code: 'DEP_CYCLE', message: `循环：${[...stack, code].join(' → ')}` });
      return;
    }
    if (done.has(code)) return;
    visiting.add(code);
    for (const dep of byCode.get(code)?.deps ?? []) if (byCode.has(dep) && dep !== code) visit(dep, [...stack, code]);
    visiting.delete(code); done.add(code);
  };
  for (const t of tasks) visit(t.code, []);
  if (issues.length > 0) return { ok: false as const, issues, assignments: new Map<string, number>() };

  const overlap = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const remaining = new Set(tasks.map((t) => t.code));
  const completed = new Set<string>();
  const assignments = new Map<string, number>();
  const conflicts: Array<{ scope: string; tasks: string[] }> = [];
  let batchNo = 0;
  while (remaining.size > 0) {
    const ready = [...remaining].filter((c) => (byCode.get(c)!.deps).every((d) => completed.has(d))).sort();
    if (ready.length === 0) break;
    batchNo++;
    const used = new Map<string, string>(); // scope → taskCode
    for (const code of ready) {
      const scopes = byCode.get(code)!.write_scopes;
      const clash = scopes.find((s) => [...used.keys()].some((o) => overlap(s, o)));
      if (clash) {
        const other = [...used.entries()].find(([o]) => overlap(clash, o))!;
        conflicts.push({ scope: clash, tasks: [other[1], code] });
        continue; // 冲突任务延后到下一批次
      }
      assignments.set(code, batchNo);
      for (const s of scopes) used.set(s, code);
      remaining.delete(code); completed.add(code);
    }
  }
  return { ok: true as const, issues, assignments, conflicts };
}

@Injectable()
export class DevTasksService {
  onModuleInit(): void {
    // A06-1 任务识别（前置 develop 门禁；绑定输入身份 REQ-420）
    registerCommand('dev.identify.complete', async (client, payload, ctx) => {
      const { projectId, baselineId, baselineFingerprint } = payload as {
        projectId: string; baselineId: string; baselineFingerprint: string;
      };
      const issues = await developGateIssues(client, projectId);
      if (issues.length > 0) throw new DomainError('GATE_BLOCKED', '任务识别门禁未通过', 'dev', { issues });
      const bl = await latestBaseline(client, projectId);
      if (!bl || bl.id !== baselineId || `sha256:${bl.baseline_fingerprint}` !== baselineFingerprint) {
        throw new DomainError('STALE_EVIDENCE', '基线身份与当前有效基线不符', baselineId);
      }
      const cat = await client.query<{ catalog_version: string }>(
        'SELECT catalog_version FROM dsg_catalog_items WHERE project_id=$1 ORDER BY catalog_version DESC LIMIT 1',
        [projectId]);
      const catVer = cat.rows[0]?.catalog_version;
      if (!catVer) throw new DomainError('GATE_BLOCKED', '无设计目录', 'dev', { issues: [{ code: 'PLAN_REQUIRED', message: '无设计目录' }] });
      const items = await client.query<{ item_type: string; code: string; payload: Record<string, unknown> }>(
        'SELECT item_type, code, payload FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 ORDER BY code',
        [projectId, catVer]);
      const existing = await client.query<{ title: string }>(
        'SELECT title FROM dev_tasks WHERE project_id=$1', [projectId]);
      const have = new Set(existing.rows.map((r) => r.title));
      const inputArtifacts = bl.items.map((i) => ({ doc_kind: i.artifact, version_id: i.version_id, fingerprint: i.fingerprint }));

      const specs = buildTaskSpecs(items.rows);
      let identified = 0;
      const taskIds: string[] = [];
      let seq = (await client.query<{ n: string }>('SELECT count(*) AS n FROM dev_tasks WHERE project_id=$1', [projectId])).rows[0]?.n ?? '0';
      for (const s of specs) {
        if (have.has(s.title)) continue; // 识别幂等：同基线重复识别不产生重复任务
        seq = String(Number(seq) + 1);
        const code = `T-${String(seq).padStart(3, '0')}`;
        await client.query(
          `INSERT INTO dev_tasks (project_id, code, title, kind, owner, asg_type, goal, scope, boundary,
             source_ids, input_artifacts, work, inputs, deliverables, acceptance, quality, deps, write_scopes, batch_no, effort, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [projectId, code, s.title, s.kind, 'mock-agent', s.asgType, s.goal, s.scope, s.boundary,
            JSON.stringify(s.sourceIds), JSON.stringify(inputArtifacts), JSON.stringify(s.work),
            JSON.stringify(s.inputs), JSON.stringify(s.deliverables), JSON.stringify(s.acceptance),
            JSON.stringify(s.quality), JSON.stringify(s.deps), JSON.stringify(s.writeScopes),
            s.batchNo, s.effort, ctx.actorId],
        );
        identified++;
        taskIds.push(code);
      }
      return { identified, taskIds, poolRevision: Number(seq) };
    });

    // 任务规格编辑（排队中可编辑；运行/评审/合并须先返工，LLD-6 §3.5）
    // W6 全字段：title/kind/owner/effort/goal/scope/boundary/sourceIds/work/inputs/deliverables/
    // acceptance/deps/writeScopes/quality；保存 rev++ 且覆盖核对全部重置 pending（原型 devSaveTask 同口径）
    registerCommand('dev.task.save', async (client, payload, ctx) => {
      const p = payload as Record<string, unknown>;
      const { projectId, taskId } = p as { projectId: string; taskId: string };
      const t = await client.query<Record<string, unknown>>(
        'SELECT * FROM dev_tasks WHERE id=$1 AND project_id=$2 FOR UPDATE', [taskId, projectId]);
      if (!t.rows[0]) throw new DomainError('NOT_FOUND', '任务不存在', taskId);
      if (t.rows[0].col !== 'queue') {
        throw new DomainError('INVALID_STATE', '仅排队中任务可编辑规格；运行/评审/合并须先返工', taskId);
      }
      if (p.kind !== undefined && !KINDS.includes(p.kind as (typeof KINDS)[number])) {
        throw new DomainError('VALIDATION_FAILED', 'kind 枚举 frontend|backend|common|integration', 'kind');
      }
      const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
      // SET 子句中列名引用旧值：rev=rev+1 先于 coverage 子查询内 rev 引用（同一旧值），故 task_rev 用 rev+1
      await client.query(
        `UPDATE dev_tasks SET
           title=COALESCE($3,title), kind=COALESCE($4,kind), owner=COALESCE($5,owner),
           asg_type=COALESCE($6,asg_type), effort=COALESCE($7,effort),
           goal=COALESCE($8,goal), scope=COALESCE($9,scope), boundary=COALESCE($10,boundary),
           source_ids=COALESCE($11,source_ids), work=COALESCE($12,work), inputs=COALESCE($13,inputs),
           deliverables=COALESCE($14,deliverables), acceptance=COALESCE($15,acceptance),
           quality=COALESCE($16,quality), deps=COALESCE($17,deps), write_scopes=COALESCE($18,write_scopes),
           rev=rev+1,
           coverage=(SELECT COALESCE(jsonb_agg(jsonb_build_object('item_id',s,'status','pending','task_rev',rev+1)),'[]'::jsonb)
                     FROM jsonb_array_elements_text(COALESCE($11,source_ids)) AS s),
           updated_by=$19, updated_at=now()
         WHERE id=$1 AND project_id=$2`,
        [taskId, projectId,
          p.title ?? null, p.kind ?? null, p.owner ?? null, p.asgType ?? null, p.effort ?? null,
          p.goal ?? null, p.scope ?? null, p.boundary ?? null,
          json(p.sourceIds), json(p.work), json(p.inputs), json(p.deliverables), json(p.acceptance),
          json(p.quality), p.deps ? JSON.stringify(p.deps) : null,
          p.writeScopes ? JSON.stringify(p.writeScopes) : null, ctx.actorId],
      );
      return { id: taskId };
    });

    // 人工新建草稿任务（原型 newDevTask/devCreateTask；先草稿入池，覆盖不会自动确认）
    registerCommand('dev.task.create', async (client, payload, ctx) => {
      const { projectId, title, kind } = payload as { projectId: string; title?: string; kind?: string };
      if (!title?.trim()) throw new DomainError('VALIDATION_FAILED', '任务名称必填', 'title');
      if (!KINDS.includes(kind as (typeof KINDS)[number])) {
        throw new DomainError('VALIDATION_FAILED', 'kind 枚举 frontend|backend|common|integration', 'kind');
      }
      const seq = (await client.query<{ n: string }>('SELECT count(*) AS n FROM dev_tasks WHERE project_id=$1', [projectId])).rows[0]?.n ?? '0';
      const code = `T-${String(Number(seq) + 1).padStart(3, '0')}`;
      const quality: QualitySpec = {
        object: '', line: 80, branch: 70,
        scenarios: [
          { type: 'normal', applicable: true, case: '', expected: '', pass: '' },
          { type: 'boundary', applicable: true, case: '', expected: '', pass: '' },
          { type: 'exception', applicable: false, notApplicableReason: '' },
        ],
      };
      const r = await client.query<{ id: string }>(
        `INSERT INTO dev_tasks (project_id, code, title, kind, owner, asg_type, goal, scope, boundary,
           source_ids, input_artifacts, work, inputs, deliverables, acceptance, quality, deps, write_scopes, effort, created_by)
         VALUES ($1,$2,$3,$4,$5,'human','','','','[]','[]','[]','[]','[]','[]',$6,'[]','[]','',$7) RETURNING id`,
        [projectId, code, title.trim(), kind, ctx.actorId, JSON.stringify(quality), ctx.actorId]);
      return { id: r.rows[0]!.id, code };
    });

    // 完善任务：批量补齐缺失/不可执行规格字段（原型 devImproveTasks；仅补缺，保留已有具体标准）
    registerCommand('dev.task.improve', async (client, payload, ctx) => {
      const { projectId } = payload as { projectId: string };
      const rows = await client.query<Record<string, unknown>>(
        'SELECT * FROM dev_tasks WHERE project_id=$1 AND archived=false AND excluded=false FOR UPDATE', [projectId]);
      let improved = 0;
      for (const t of rows.rows) {
        const patch = improveSpecPatch(t);
        if (!patch) continue;
        await applySpecPatch(client, projectId, String(t.id), patch, ctx.actorId);
        improved++;
      }
      return { improved };
    });

    // 编排计划：依赖拓扑批次 + 写入范围冲突串行（原型 devSchedule/devDependencyPlan）
    registerCommand('dev.plan.schedule', async (client, payload) => {
      const { projectId } = payload as { projectId: string };
      const rows = await client.query<{ id: string; code: string; deps: string[]; write_scopes: string[]; batch_no: number | null }>(
        'SELECT id, code, deps, write_scopes, batch_no FROM dev_tasks WHERE project_id=$1 AND archived=false AND excluded=false FOR UPDATE',
        [projectId]);
      if (rows.rows.length === 0) throw new DomainError('VALIDATION_FAILED', '任务池为空，无可编排任务', 'tasks');
      const plan = scheduleBatches(rows.rows.map((r) => ({ id: r.id, code: r.code, deps: r.deps, write_scopes: r.write_scopes })));
      if (!plan.ok) {
        throw new DomainError('GATE_BLOCKED', '依赖编排未通过', 'dev.plan', { issues: plan.issues });
      }
      let changed = 0;
      for (const r of rows.rows) {
        const next = plan.assignments.get(r.code);
        if (next !== undefined && next !== r.batch_no) {
          await client.query('UPDATE dev_tasks SET batch_no=$3, updated_at=now() WHERE id=$1 AND project_id=$2',
            [r.id, projectId, next]);
          changed++;
        }
      }
      return { batches: Math.max(...plan.assignments.values()), changed, conflicts: plan.conflicts ?? [] };
    });

    // 覆盖核对确认（单条/全部；REQ-403）
    const confirmCoverage = async (client: PoolClient, projectId: string, taskId: string, itemId: string | null, by: string) => {
      const t = await client.query<{ coverage: Array<{ item_id: string; status: string; task_rev: number }>; rev: number }>(
        'SELECT coverage, rev FROM dev_tasks WHERE id=$1 AND project_id=$2 FOR UPDATE', [taskId, projectId]);
      if (!t.rows[0]) throw new DomainError('NOT_FOUND', '任务不存在', taskId);
      const cov = t.rows[0].coverage.map((c) =>
        itemId === null || c.item_id === itemId ? { ...c, status: 'confirmed', task_rev: t.rows[0]!.rev } : c);
      await client.query('UPDATE dev_tasks SET coverage=$3, updated_by=$4, updated_at=now() WHERE id=$1 AND project_id=$2',
        [taskId, projectId, JSON.stringify(cov), by]);
      return { id: taskId, confirmed: itemId ?? 'all' };
    };
    registerCommand('dev.coverage.confirm', async (client, payload, ctx) => {
      const { projectId, taskId, itemId } = payload as { projectId: string; taskId: string; itemId: string };
      return confirmCoverage(client, projectId, taskId, itemId, ctx.actorId);
    });
    registerCommand('dev.coverage.confirm-all', async (client, payload, ctx) => {
      const { projectId, taskId } = payload as { projectId: string; taskId: string };
      return confirmCoverage(client, projectId, taskId, null, ctx.actorId);
    });
  }

  // ---------- 命令入口 ----------

  async identify(projectId: string, baselineId: string, baselineFingerprint: string, ctx: CommandContext) {
    return executeCommand('dev.identify.complete', { projectId, baselineId, baselineFingerprint }, { ...ctx, projectId });
  }

  async saveTask(projectId: string, taskId: string, patch: Record<string, unknown>, ctx: CommandContext) {
    return executeCommand('dev.task.save', { projectId, taskId, ...patch }, { ...ctx, projectId });
  }

  async createTask(projectId: string, title: string, kind: string, ctx: CommandContext) {
    return executeCommand('dev.task.create', { projectId, title, kind }, { ...ctx, projectId });
  }

  async improveTasks(projectId: string, ctx: CommandContext) {
    return executeCommand('dev.task.improve', { projectId }, { ...ctx, projectId });
  }

  async schedule(projectId: string, ctx: CommandContext) {
    return executeCommand('dev.plan.schedule', { projectId }, { ...ctx, projectId });
  }

  async confirmCoverage(projectId: string, taskId: string, itemId: string | null, ctx: CommandContext) {
    return executeCommand(itemId ? 'dev.coverage.confirm' : 'dev.coverage.confirm-all',
      itemId ? { projectId, taskId, itemId } : { projectId, taskId }, { ...ctx, projectId });
  }

  // ---------- 查询面 ----------

  /** A06-2 任务池查询（W6：携带规格问题计数 + 覆盖待核计数 + 最新单测/CI 证据摘要，供注意项模型与单测表） */
  async list(projectId: string, col?: string) {
    const params: unknown[] = [projectId];
    let where = 'project_id=$1 AND archived=false AND excluded=false';
    if (col) {
      params.push(col.split(','));
      where += ' AND col = ANY($2)';
    }
    const r = await query(
      `SELECT id, code, title, kind, owner, asg_type, col, run_status, prog, blocked, blocked_reason,
              rev, code_rev, batch_no, deps, write_scopes, quality, source_ids, acceptance,
              goal, scope, boundary, work, inputs, deliverables, effort, coverage
       FROM dev_tasks WHERE ${where} ORDER BY batch_no NULLS LAST, code`, params);
    // 最新单测证据（按任务 code 聚合：evd_records payload.taskId 存的是任务 UUID）
    const ids = r.rows.map((t) => (t as Record<string, unknown>).id as string);
    const unit = ids.length > 0 ? await query(
      `SELECT DISTINCT ON (payload->>'taskId') payload->>'taskId' AS task_id, payload
       FROM evd_records WHERE project_id=$1 AND kind='unit' AND payload->>'taskId' = ANY($2)
       ORDER BY payload->>'taskId', created_at DESC`, [projectId, ids]) : { rows: [] as Array<{ task_id: string; payload: Record<string, unknown> }> };
    const unitByTask = new Map(unit.rows.map((u) => [u.task_id, u.payload]));
    const codes = r.rows.map((t) => (t as Record<string, unknown>).code as string);
    const ci = codes.length > 0 ? await query(
      `SELECT DISTINCT ON (code) code, conclusion, commit_sha FROM (
         SELECT jsonb_array_elements_text(task_codes) AS code, conclusion, commit_sha, received_at
         FROM dev_ci_reports WHERE project_id=$1 AND matched=true
       ) x WHERE code = ANY($2) ORDER BY code, received_at DESC`, [projectId, codes]) : { rows: [] as Array<{ code: string; conclusion: string; commit_sha: string }> };
    const ciByCode = new Map(ci.rows.map((c) => [c.code, c]));
    return {
      items: r.rows.map((row) => {
        const t = row as Record<string, unknown>;
        const cov = Array.isArray(t.coverage) ? t.coverage as Array<{ status: string; task_rev: number }> : [];
        const u = unitByTask.get(t.id as string);
        const c = ciByCode.get(t.code as string);
        return {
          ...this.toView(t),
          effort: t.effort,
          specIssues: specIssues(t).map((i) => i.message),
          coveragePending: cov.filter((x) => x.status !== 'confirmed' || Number(x.task_rev) !== Number(t.rev)).length,
          coverageTotal: cov.length,
          unit: u ? { pass: !!u.pass, line: u.line, branch: u.branch, commitId: u.commitId, taskRev: u.taskRev } : null,
          ci: c ? { conclusion: c.conclusion, commitSha: c.commit_sha } : null,
        };
      }),
      total: r.rows.length,
    };
  }

  /** A06-3 任务详情（规格全字段+证据+PR+反查设计项） */
  async detail(projectId: string, taskId: string) {
    const t = await query('SELECT * FROM dev_tasks WHERE id=$1 AND project_id=$2', [taskId, projectId]);
    if (!t.rows[0]) throw new DomainError('NOT_FOUND', '任务不存在', taskId);
    const prs = await query(
      'SELECT code_rev, pr_ref, status, checklist, merge_basis, commit_id, created_at FROM dev_prs WHERE task_id=$1 ORDER BY code_rev DESC',
      [taskId]);
    const evd = await query(
      `SELECT seq, kind, payload, created_at FROM evd_records
       WHERE project_id=$1 AND payload->>'taskId'=$2 ORDER BY created_at DESC LIMIT 20`,
      [projectId, taskId]);
    const ci = await query(
      `SELECT commit_sha, conclusion, matched, received_at FROM dev_ci_reports
       WHERE project_id=$1 AND task_codes ? (SELECT code FROM dev_tasks WHERE id=$2)
       ORDER BY received_at DESC LIMIT 5`,
      [projectId, taskId]);
    const row = t.rows[0] as Record<string, unknown>;
    return { ...this.toView(row, true), effort: row.effort, specIssuesFull: specIssues(row), prs: prs.rows, evidence: evd.rows, ci: ci.rows };
  }

  /** A06-4 写入范围冲突（与进行中任务重叠可检出） */
  async conflicts(projectId: string) {
    const r = await query<{ write_scopes: string[]; code: string; col: string }>(
      "SELECT code, col, write_scopes FROM dev_tasks WHERE project_id=$1 AND col='ing'", [projectId]);
    const byScope = new Map<string, string[]>();
    for (const t of r.rows) {
      for (const s of t.write_scopes) {
        byScope.set(s, [...(byScope.get(s) ?? []), t.code]);
      }
    }
    const conflicts = [...byScope.entries()]
      .filter(([, codes]) => codes.length > 1)
      .map(([writeScope, taskIds]) => ({ writeScope, taskIds }));
    return { conflicts };
  }

  /** A06-5 计划覆盖检查（设计项 ↔ 任务双向；缺口可见） */
  async coverage(projectId: string): Promise<{ ok: boolean; uncoveredDesignItems: string[]; unmatchedTasks: string[] }> {
    const cat = await query<{ catalog_version: string }>(
      'SELECT catalog_version FROM dsg_catalog_items WHERE project_id=$1 ORDER BY catalog_version DESC LIMIT 1', [projectId]);
    const catVer = cat.rows[0]?.catalog_version ?? null;
    const items = catVer
      ? await query<{ code: string }>(
          "SELECT code FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 AND item_type IN ('page','flow')",
          [projectId, catVer])
      : { rows: [] as Array<{ code: string }> };
    const tasks = await query<{ code: string; source_ids: string[] }>(
      "SELECT code, source_ids FROM dev_tasks WHERE project_id=$1 AND archived=false AND excluded=false", [projectId]);
    const covered = new Set(tasks.rows.flatMap((t) => t.source_ids));
    const uncoveredDesignItems = items.rows.map((i) => i.code).filter((c) => !covered.has(c));
    const designCodes = new Set(items.rows.map((i) => i.code));
    const unmatchedTasks = tasks.rows
      .filter((t) => t.source_ids.length > 0 && t.source_ids.every((s) => !designCodes.has(s)))
      .map((t) => t.code);
    return { ok: uncoveredDesignItems.length === 0 && unmatchedTasks.length === 0, uncoveredDesignItems, unmatchedTasks };
  }

  private toView(t: Record<string, unknown>, full = false) {
    const base = {
      id: t.id, code: t.code, title: t.title, kind: t.kind, owner: t.owner, ownerType: t.asg_type,
      col: t.col, runStatus: t.run_status, prog: t.prog,
      blocked: t.blocked, blockedReason: t.blocked_reason,
      rev: t.rev, codeRev: t.code_rev, batchNo: t.batch_no,
      deps: t.deps, writeScopes: t.write_scopes, sourceIds: t.source_ids,
      quality: t.quality, acceptance: t.acceptance,
    };
    if (!full) return base;
    return { ...base, goal: t.goal, scope: t.scope, boundary: t.boundary, work: t.work, inputs: t.inputs, deliverables: t.deliverables, inputArtifacts: t.input_artifacts, coverage: t.coverage };
  }
}

/** mock 任务规格派生：页面条目 → frontend 任务；骨架 common/integration（REQ-402 规格全字段） */
/** 目录条目 → 任务规格（mock 识别口径；identify 与 dev.plan.prepare 的 create-task 建议共用） */
export function buildTaskSpecs(items: Array<{ item_type: string; code: string; payload: Record<string, unknown> }>) {
  const pages = items.filter((i) => i.item_type === 'page');
  const flows = items.filter((i) => i.item_type === 'flow'); // 流程条目由端到端联调承接（覆盖闭环 REQ-403）
  const quality = {
    object: '单元测试', line: 80, branch: 70,
    scenarios: [
      { type: 'normal', applicable: true, case: '正常路径', expected: '通过', pass: '主要业务结果和状态断言全部通过' },
      { type: 'boundary', applicable: true, case: '边界输入', expected: '通过', pass: '状态一致且无崩溃' },
      { type: 'exception', applicable: true, case: '异常处理', expected: '通过', pass: '异常路径有明确错误码且不留中间态' },
    ],
  };
  const specs: Array<{
    title: string; kind: string; asgType: string; goal: string; scope: string; boundary: string;
    sourceIds: string[]; work: unknown[]; inputs: unknown[]; deliverables: unknown[]; acceptance: unknown[];
    quality: typeof quality; deps: string[]; writeScopes: string[]; batchNo: number; effort: string;
  }> = [];
  pages.forEach((p, i) => {
    specs.push({
      title: `页面实现：${(p.payload.title as string) ?? p.code}`,
      kind: 'frontend', asgType: 'agent',
      goal: `实现页面 ${p.code}`, scope: `src/pages/${p.code}`, boundary: '不改动共享组件库',
      sourceIds: [p.code],
      work: [`按目录定义实现 ${p.code} 页面与状态`],
      inputs: [p.code], deliverables: [`src/pages/${p.code}/index.tsx`],
      acceptance: [{ item: `页面 ${p.code} 渲染符合目录定义`, pass: false }],
      quality, deps: [], writeScopes: [`src/pages/${p.code}`], batchNo: 1 + Math.floor(i / 3), effort: 'M',
    });
  });
  specs.push({
    title: '平台基线接线', kind: 'common', asgType: 'agent',
    goal: '公共基础设施接线', scope: 'src/platform', boundary: '不动页面代码',
    sourceIds: [], work: ['公共模块'], inputs: [], deliverables: ['src/platform/index.ts'],
    acceptance: [{ item: '公共模块可用', pass: false }], quality, deps: [], writeScopes: ['src/platform'], batchNo: 1, effort: 'S',
  });
  specs.push({
    title: '端到端联调', kind: 'integration', asgType: 'agent',
    goal: '全链路联调', scope: 'e2e', boundary: '只读页面产物',
    sourceIds: flows.map((f) => f.code), work: ['联调与冒烟脚本'], inputs: flows.map((f) => f.code), deliverables: ['e2e/smoke.ts'],
    acceptance: [{ item: '冒烟通过', pass: false }], quality,
    deps: [], writeScopes: ['e2e'], batchNo: 99, effort: 'M',
  });
  return specs;
}
