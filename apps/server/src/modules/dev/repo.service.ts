import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { DevWorkspaceService } from './workspace.service.js';

/**
 * A06-9 代码仓只读视图（REQ-406）：文件树 + 选中文件内容 + 最近提交。
 * 两态（2026-10-18 开发域真化）：
 * - 工作区已存在（AI 真写码产物）：树=git ls-files、内容=真实文件、提交=git log —— 所见即实物
 * - 无工作区（mock/未开真化）：树与内容从任务池 writeScopes/deliverables 派生（只读预览）
 */

export interface RepoTreeNode { path: string; kind: 'dir' | 'file'; taskCode?: string }
export interface RepoChange { commitId: string; taskCode: string; title: string; by: string; at: string; basis: string }

@Injectable()
export class DevRepoService {
  constructor(@Optional() @Inject(DevWorkspaceService) private readonly ws?: DevWorkspaceService) {}

  /** GET repo/tree?path= —— 工作区真实树优先；无工作区回退派生预览 */
  async tree(projectId: string, path?: string) {
    if (this.ws) {
      const files = await this.ws.listDir(projectId);
      if (files.length > 0) return this.realTree(projectId, files, path);
    }
    return this.derivedTree(projectId, path);
  }

  /** 真实工作区树（git ls-files 口径） */
  private async realTree(projectId: string, files: string[], path?: string) {
    const nodes = new Map<string, RepoTreeNode>();
    for (const f of files) {
      const segs = f.split('/');
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join('/');
        if (!nodes.has(dir)) nodes.set(dir, { path: dir, kind: 'dir' });
      }
      nodes.set(f, { path: f, kind: 'file' });
    }
    const tree = [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path));
    const sel = path && nodes.get(path)?.kind === 'file' ? path : tree.find((n) => n.kind === 'file')?.path ?? null;
    let file: { path: string; content: string; taskCode: string | null } | null = null;
    if (sel) {
      const content = await this.ws!.readFile(projectId, sel).catch((e) => `// 读取失败：${e instanceof Error ? e.message : e}`);
      file = { path: sel, content, taskCode: null };
    }
    return { tree, file, lint: { ok: true, issues: [] as string[] }, real: true };
  }

  /** 派生预览（无真实工作区时的旧口径） */
  private async derivedTree(projectId: string, path?: string) {
    const tasks = await query<{
      code: string; title: string; kind: string; write_scopes: string[]; deliverables: string[]; col: string;
    }>(
      `SELECT code, title, kind, write_scopes, deliverables, col FROM dev_tasks
       WHERE project_id=$1 AND archived=false AND excluded=false ORDER BY code`, [projectId]);
    const nodes = new Map<string, RepoTreeNode>();
    for (const t of tasks.rows) {
      const paths = [...t.write_scopes, ...t.deliverables];
      for (const p of paths) {
        const clean = String(p).replace(/\/+$/, '');
        if (!clean || clean.startsWith('/') || clean.includes('..')) continue;
        // 逐级补目录节点
        const segs = clean.split('/');
        for (let i = 1; i < segs.length; i++) {
          const dir = segs.slice(0, i).join('/');
          if (!nodes.has(dir)) nodes.set(dir, { path: dir, kind: 'dir' });
        }
        const isFile = /\.[a-z0-9]+$/i.test(clean);
        nodes.set(clean, { path: clean, kind: isFile ? 'file' : 'dir', taskCode: t.code });
      }
    }
    const tree = [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path));
    const sel = path && nodes.get(path)?.kind === 'file' ? path : tree.find((n) => n.kind === 'file')?.path ?? null;
    let file: { path: string; content: string; taskCode: string | null } | null = null;
    if (sel) {
      const owner = tasks.rows.find((t) => [...t.write_scopes, ...t.deliverables].some((p) => String(p).replace(/\/+$/, '') === sel));
      const header = `// ${sel}\n// 派生预览（A06-9）：真实工作区由执行器维护，此处展示任务规格摘要\n`;
      const body = owner
        ? `// 任务 ${owner.code} · ${owner.title}\n// 分工 ${owner.kind} · 看板列 ${owner.col}\nexport {};\n`
        : 'export {};\n';
      file = { path: sel, content: header + body, taskCode: owner?.code ?? null };
    }
    // lint 汇总：写范围非法路径计数（上游 save 已挡，此处兜底报告）
    const bad = tasks.rows.flatMap((t) =>
      t.write_scopes.filter((s) => s.startsWith('/') || s.includes('..')).map((s) => `${t.code}: ${s}`));
    return { tree, file, lint: { ok: bad.length === 0, issues: bad } };
  }

  /** GET repo/changes?taskId= —— 工作区存在时=真实 git log；否则合并 PR 派生（可按任务过滤） */
  async changes(projectId: string, taskId?: string) {
    if (this.ws) {
      const log = await this.ws.gitLog(projectId, 30);
      if (log.length > 0) {
        return {
          real: true,
          changes: log.map((c) => ({
            commitId: c.sha.slice(0, 12),
            taskCode: (c.message.match(/^feat\((T-\d+)\)/)?.[1]) ?? '—',
            title: c.message, by: 'msf-codegen', at: c.at, basis: 'git',
          })),
        };
      }
    }
    if (taskId) {
      const t = await query('SELECT id FROM dev_tasks WHERE id=$1 AND project_id=$2', [taskId, projectId])
        .catch(() => ({ rows: [] as unknown[] })); // 非法 UUID 视同不存在
      if (!t.rows[0]) throw new DomainError('NOT_FOUND', '任务不存在', taskId);
    }
    const params: unknown[] = [projectId];
    let where = "p.project_id=$1 AND p.status='merged'";
    if (taskId) {
      params.push(taskId);
      where += ' AND p.task_id=$2';
    }
    const r = await query<{
      commit_id: string; code: string; title: string; created_by: string; updated_at: string;
      merge_basis: { type?: string };
    }>(
      `SELECT p.commit_id, t.code, t.title, p.created_by, p.updated_at, p.merge_basis
       FROM dev_prs p JOIN dev_tasks t ON t.id=p.task_id
       WHERE ${where} ORDER BY p.updated_at DESC LIMIT 30`, params);
    const changes: RepoChange[] = r.rows.map((p) => ({
      commitId: p.commit_id, taskCode: p.code, title: `feat(${p.code}): ${p.title}`,
      by: p.created_by, at: p.updated_at, basis: p.merge_basis?.type ?? '—',
    }));
    return { changes };
  }
}
