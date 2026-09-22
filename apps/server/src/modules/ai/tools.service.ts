import { Injectable, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';

/**
 * ToolBridge 工具注册表（DSG-D08-3；A08-5/6；REQ-605/606/613）：
 * - 封闭注册表：未注册 TOOL_UNREGISTERED；参数校验失败 TOOL_ARGS_INVALID
 * - 越界工具（定稿/放行/写类）编排层直接拒绝：ai_tool_calls 记 denied + TOOL_DENIED（不执行、不转发）
 * - 允许集本期为只读三件套：nav.goto / read_context / propose_next_step（规则引擎，SQL 直读他域表）
 * - 一切调用经 ai.tool.invoke 命令：append-only 留痕（REQ-613）
 */

interface ToolDef {
  name: string;
  kind: 'read' | 'nav';
  description: string;
  /** JSON Schema 简式：required 键 + 各键类型 */
  argsSchema: Record<string, 'string' | 'number' | 'boolean'>;
  required: string[];
  run: (client: PoolClient, projectId: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** 越界工具名单（定稿/放行/写类；出现在请求即 denied—— REQ-606 编排层拒绝） */
const WRITE_TOOLS = new Set([
  'doc.finalize', 'req.doc.finalize', 'design.prototype.finalize', 'test.release',
  'dev.plan.approve', 'tst.plan.approve', 'tst.report.finalize', 'dev.transfer.handoff',
  'file.write', 'shell.exec', 'git.push',
]);

const ROUTES: Record<string, string> = {
  material: '/material', req: '/req', design: '/design', proto: '/proto',
  dev: '/dev', test: '/test', delegate: '/delegate',
};

const TOOLS: ToolDef[] = [
  {
    name: 'nav.goto',
    kind: 'nav',
    description: '跳转到指定阶段页签',
    argsSchema: { tab: 'string' },
    required: ['tab'],
    async run(_c, _p, args) {
      const tab = String(args['tab']);
      if (!(tab in ROUTES)) throw new DomainError('TOOL_ARGS_INVALID', `tab 枚举 ${Object.keys(ROUTES).join('|')}`, 'tab');
      return { route: ROUTES[tab] };
    },
  },
  {
    name: 'read_context',
    kind: 'read',
    description: '读取项目当前阶段状态摘要（各域 SQL 直读）',
    argsSchema: {},
    required: [],
    async run(client, projectId) {
      const one = async (sql: string) =>
        (await client.query<{ n: string }>(sql, [projectId])).rows[0]?.n ?? '0';
      return {
        materials: await one("SELECT count(*) AS n FROM mat_files WHERE project_id=$1 AND parse_status='content_final'"),
        reqDocsFinal: await one('SELECT count(*) AS n FROM req_documents WHERE project_id=$1 AND final_version_id IS NOT NULL'),
        designDocsFinal: await one('SELECT count(*) AS n FROM dsg_documents WHERE project_id=$1 AND final_version_id IS NOT NULL'),
        devTasks: await one('SELECT count(*) AS n FROM dev_tasks WHERE project_id=$1'),
        testBatches: await one('SELECT count(*) AS n FROM tst_batches WHERE project_id=$1'),
      };
    },
  },
  {
    name: 'propose_next_step',
    kind: 'read',
    description: 'next-steps 规则引擎：按项目状态给出下一步建议',
    argsSchema: {},
    required: [],
    async run(client, projectId) {
      const has = async (sql: string) =>
        Number((await client.query<{ n: string }>(sql, [projectId])).rows[0]?.n ?? 0) > 0;
      const suggestions: string[] = [];
      if (!(await has("SELECT count(*) AS n FROM mat_files WHERE project_id=$1 AND parse_status='content_final'"))) {
        suggestions.push('上传并内容定稿至少一份参考输入（资料页）');
      }
      if (!(await has("SELECT count(*) AS n FROM req_documents WHERE project_id=$1 AND doc_kind='crd' AND final_version_id IS NOT NULL"))) {
        suggestions.push('完成 CRD 定稿（需求页）');
      } else if (!(await has("SELECT count(*) AS n FROM req_documents WHERE project_id=$1 AND doc_kind='prd' AND final_version_id IS NOT NULL"))) {
        suggestions.push('完成 PRD 定稿（需求页；门禁 L0a≥0.95 且 L0b=1）');
      }
      if (await has("SELECT count(*) AS n FROM req_documents WHERE project_id=$1 AND doc_kind='prd' AND final_version_id IS NOT NULL")
        && !(await has("SELECT count(*) AS n FROM dsg_documents WHERE project_id=$1 AND doc_kind='hld' AND final_version_id IS NOT NULL"))) {
        suggestions.push('生成并定稿 HLD（设计页）');
      }
      if (suggestions.length === 0) suggestions.push('按阶段推进：设计→开发→测试交接');
      return { suggestions };
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

@Injectable()
export class AiToolsService implements OnModuleInit {
  onModuleInit(): void {
    registerCommand('ai.tool.invoke', async (client, payload, ctx) => {
      const p = payload as { sessionId?: string; toolName?: string; args?: Record<string, unknown> };
      if (!p.toolName) throw new DomainError('TOOL_ARGS_INVALID', 'toolName 必填', 'toolName');
      // 判别式结果：denied/unregistered/args_invalid 均先落 ai_tool_calls 再返回，
      // 由门面抛错——命令内抛错会回滚留痕行（REQ-606/613 要求拒绝也留痕）
      if (WRITE_TOOLS.has(p.toolName)) {
        await this.record(client, p, 'denied', { reason: '越界工具（写/定稿/放行类），编排层拒绝' });
        return { outcome: 'denied' as const, tool: p.toolName };
      }
      const tool = byName.get(p.toolName);
      if (!tool) {
        await this.record(client, p, 'denied', { reason: '未注册工具' });
        return { outcome: 'unregistered' as const, tool: p.toolName };
      }
      const args = p.args ?? {};
      const bad = (key: string, msg: string) => ({ outcome: 'args_invalid' as const, tool: tool.name, key, msg });
      for (const key of tool.required) {
        if (args[key] === undefined) {
          const r = bad(key, `缺参数 ${key}`);
          await this.record(client, p, 'failed', { error: r.msg });
          return r;
        }
      }
      for (const [key, ty] of Object.entries(tool.argsSchema)) {
        if (args[key] !== undefined && typeof args[key] !== ty) {
          const r = bad(key, `参数 ${key} 须为 ${ty}`);
          await this.record(client, p, 'failed', { error: r.msg });
          return r;
        }
      }
      try {
        const result = await tool.run(client, ctx.projectId!, args);
        await this.record(client, p, 'ok', result);
        return { outcome: 'ok' as const, tool: tool.name, result };
      } catch (e) {
        if (e instanceof DomainError && e.code === 'TOOL_ARGS_INVALID') {
          await this.record(client, p, 'failed', { error: e.message });
          return { outcome: 'args_invalid' as const, tool: tool.name, key: e.target ?? 'args', msg: e.message };
        }
        throw e; // 真异常整体回滚（审计失败零写口径）
      }
    });
  }

  private async record(
    client: PoolClient,
    p: { sessionId?: string; toolName?: string; args?: Record<string, unknown> },
    status: 'ok' | 'denied' | 'failed',
    result: Record<string, unknown>,
  ): Promise<void> {
    // session_id 列 NOT NULL：有会话落行；无会话调用仅以命令审计留痕
    if (!p.sessionId) return;
    await client.query(
      'INSERT INTO ai_tool_calls (session_id, tool_name, args, result_summary, status) VALUES ($1,$2,$3,$4,$5)',
      [p.sessionId, p.toolName, JSON.stringify(p.args ?? {}), JSON.stringify(result), status]);
  }

  /** 注册表元数据（A08-5 工具清单展示） */
  list() {
    return {
      tools: TOOLS.map((t) => ({ name: t.name, kind: t.kind, description: t.description })),
      denied: [...WRITE_TOOLS],
    };
  }

  async invoke(
    projectId: string,
    p: { sessionId?: string; toolName: string; args?: Record<string, unknown> },
    ctx: CommandContext,
  ): Promise<{ tool: string; result: Record<string, unknown> }> {
    const r = await executeCommand('ai.tool.invoke', p, { ...ctx, projectId }) as
      | { outcome: 'ok'; tool: string; result: Record<string, unknown> }
      | { outcome: 'denied' | 'unregistered'; tool: string }
      | { outcome: 'args_invalid'; tool: string; key: string; msg: string };
    if (r.outcome !== 'ok') {
      if (r.outcome === 'denied') {
        throw new DomainError('TOOL_DENIED', `工具 ${r.tool} 越界：定稿/放行/写类不可经助手触发`, r.tool);
      }
      if (r.outcome === 'unregistered') {
        throw new DomainError('TOOL_UNREGISTERED', `工具未注册: ${r.tool}`, r.tool);
      }
      const bad = r as { outcome: 'args_invalid'; tool: string; key: string; msg: string };
      throw new DomainError('TOOL_ARGS_INVALID', bad.msg, bad.key);
    }
    return { tool: r.tool, result: r.result };
  }

  /** 会话工具调用历史（A08-6 工具卡） */
  async callsOfSession(projectId: string, sessionId: string) {
    const s = await query<{ project_id: string }>('SELECT project_id FROM ai_sessions WHERE id=$1', [sessionId]);
    if (!s.rows[0]) throw new DomainError('NOT_FOUND', '会话不存在', sessionId);
    if (s.rows[0].project_id !== projectId) throw new DomainError('FORBIDDEN', '会话不属本项目', sessionId);
    const r = await query<{
      id: string; tool_name: string; args: unknown; result_summary: unknown;
      status: string; created_at: string;
    }>(
      'SELECT id, tool_name, args, result_summary, status, created_at FROM ai_tool_calls WHERE session_id=$1 ORDER BY created_at DESC LIMIT 100',
      [sessionId]);
    return { items: r.rows };
  }
}
