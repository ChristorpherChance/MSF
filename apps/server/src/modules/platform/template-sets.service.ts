import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { lockCodeGen } from '../../db/seq.js';
import {
  codeDefaultTemplate, refreshTemplateOverrides, setItemTemplate, validateTemplate, CUSTOM_KIND_RE,
  type DocTemplate,
} from './doc-templates.js';

/**
 * 模板套件（2026-10-07 拍板：模板版本管理=命名套件，按项目绑定、全局可复用）：
 * - sys_template_sets（全局，与 ai_models 同口径）+ sys_template_set_items（按 kind）+ prj_template_binding
 * - 「基于默认模板创建一整套」= 空套件（kind 回退代码默认）+逐项编辑；克隆=从既有套件复制条目
 * - 自定义类别（x- 前缀命名空间）走同一套件条目，AI 起草（ai 域 template-draft）出草案人工改后保存
 * - 全部写操作命令化记审计；保存条目过 validateTemplate 专业度闸（与代码默认同标）
 */

export interface TemplateSetRow {
  id: string; name: string; description: string; created_by: string; created_at: string; updated_at: string;
}

@Injectable()
export class TemplateSetsService {
  onModuleInit(): void {
    registerCommand('template_set.create', async (client, payload, ctx) => {
      const p = payload as { name: string; description?: string; cloneFrom?: string };
      const name = p.name?.trim();
      if (!name) throw new DomainError('VALIDATION_FAILED', '套件名称必填', 'name');
      const r = await client.query<TemplateSetRow>(
        `INSERT INTO sys_template_sets (name, description, created_by) VALUES ($1,$2,$3) RETURNING *`,
        [name, p.description?.trim() ?? '', ctx.actorId])
        .catch((e: unknown) => {
          if (e instanceof Error && /unique/i.test(e.message)) throw new DomainError('INVALID_STATE', '套件名称已存在', name);
          throw e;
        });
      const set = r.rows[0]!;
      // 克隆：从既有套件复制全部条目（'default'=空套件，kind 回退代码默认，无需复制）
      if (p.cloneFrom && p.cloneFrom !== 'default') {
        await client.query(
          `INSERT INTO sys_template_set_items (set_id, kind, label, standard, quality, writing_rules, chapters, updated_by)
           SELECT $1, kind, label, standard, quality, writing_rules, chapters, $3 FROM sys_template_set_items WHERE set_id=$2`,
          [set.id, p.cloneFrom, ctx.actorId]);
      }
      return { setId: set.id, name: set.name };
    });

    registerCommand('template_set.rename', async (client, payload) => {
      const p = payload as { setId: string; name: string; description?: string };
      const r = await client.query(
        'UPDATE sys_template_sets SET name=$2, description=$3, updated_at=now() WHERE id=$1 RETURNING id',
        [p.setId, p.name?.trim() ?? '', p.description?.trim() ?? '']);
      if (!r.rows[0]) throw new DomainError('NOT_FOUND', '套件不存在', p.setId);
      return { setId: p.setId };
    });

    registerCommand('template_set.delete', async (client, payload) => {
      const p = payload as { setId: string };
      const bound = await client.query('SELECT project_id FROM prj_template_binding WHERE set_id=$1', [p.setId]);
      if (bound.rows.length > 0) {
        throw new DomainError('INVALID_STATE', `仍有 ${bound.rows.length} 个项目绑定该套件，先解绑再删除`, p.setId);
      }
      const r = await client.query('DELETE FROM sys_template_sets WHERE id=$1', [p.setId]);
      if (r.rowCount === 0) throw new DomainError('NOT_FOUND', '套件不存在', p.setId);
      return { setId: p.setId, deleted: true };
    });

    registerCommand('template_set.update_item', async (client, payload, ctx) => {
      const p = payload as { setId: string; kind: string; template: DocTemplate };
      const problems = validateTemplate(p.kind, p.template);
      if (problems.length > 0) {
        throw new DomainError('VALIDATION_FAILED', `模板未过专业度校验：${problems.join('；')}`, 'template');
      }
      const set = await client.query('SELECT id FROM sys_template_sets WHERE id=$1', [p.setId]);
      if (!set.rows[0]) throw new DomainError('NOT_FOUND', '套件不存在', p.setId);
      await client.query(
        `INSERT INTO sys_template_set_items (set_id, kind, label, standard, quality, writing_rules, chapters, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (set_id, kind) DO UPDATE SET label=$3, standard=$4, quality=$5, writing_rules=$6, chapters=$7, updated_by=$8, updated_at=now()`,
        [p.setId, p.kind, p.template.label?.trim() ?? '', p.template.standard, p.template.quality,
          JSON.stringify(p.template.writingRules), JSON.stringify(p.template.chapters), ctx.actorId]);
      return { setId: p.setId, kind: p.kind, saved: true };
    });

    registerCommand('template_set.delete_item', async (client, payload) => {
      const p = payload as { setId: string; kind: string };
      const r = await client.query(
        'DELETE FROM sys_template_set_items WHERE set_id=$1 AND kind=$2', [p.setId, p.kind]);
      if (r.rowCount === 0) throw new DomainError('NOT_FOUND', '该套件中此文档类别无自定义条目（本就在用代码默认）', p.kind);
      return { setId: p.setId, kind: p.kind, deleted: true };
    });

    registerCommand('template_set.bind', async (client, payload, ctx) => {
      const p = payload as { projectId: string; setId: string | null };
      await lockCodeGen(client, `msf:tplbind:${p.projectId}`);
      if (p.setId === null) {
        await client.query('DELETE FROM prj_template_binding WHERE project_id=$1', [p.projectId]);
        return { projectId: p.projectId, setId: null };
      }
      const set = await client.query('SELECT id FROM sys_template_sets WHERE id=$1', [p.setId]);
      if (!set.rows[0]) throw new DomainError('NOT_FOUND', '套件不存在', p.setId);
      await client.query(
        `INSERT INTO prj_template_binding (project_id, set_id, updated_by) VALUES ($1,$2,$3)
         ON CONFLICT (project_id) DO UPDATE SET set_id=$2, updated_by=$3, updated_at=now()`,
        [p.projectId, p.setId, ctx.actorId]);
      return { projectId: p.projectId, setId: p.setId };
    });
  }

  // ---------- 包装（写后刷新覆盖缓存：生成链即时生效） ----------

  async createSet(name: string, description: string, cloneFrom: string | undefined, ctx: CommandContext) {
    const r = (await executeCommand('template_set.create', { name, description, ...(cloneFrom ? { cloneFrom } : {}) }, ctx)) as { setId: string };
    await refreshTemplateOverrides();
    return r;
  }
  async renameSet(setId: string, name: string, description: string, ctx: CommandContext) {
    return executeCommand('template_set.rename', { setId, name, description }, ctx);
  }
  async deleteSet(setId: string, ctx: CommandContext) {
    const r = await executeCommand('template_set.delete', { setId }, ctx);
    await refreshTemplateOverrides();
    return r;
  }
  async saveItem(setId: string, kind: string, template: DocTemplate, ctx: CommandContext) {
    const r = (await executeCommand('template_set.update_item', { setId, kind, template }, ctx)) as { saved: boolean };
    await refreshTemplateOverrides();
    return r;
  }
  async deleteItem(setId: string, kind: string, ctx: CommandContext) {
    const r = await executeCommand('template_set.delete_item', { setId, kind }, ctx);
    await refreshTemplateOverrides();
    return r;
  }
  async bind(projectId: string, setId: string | null, ctx: CommandContext) {
    const r = await executeCommand('template_set.bind', { projectId, setId }, { ...ctx, projectId });
    await refreshTemplateOverrides();
    return r;
  }

  // ---------- 读侧（只读直查不经命令，与 settings.getAll 同口径） ----------

  async listSets(): Promise<{ items: Array<TemplateSetRow & { items: Array<{ kind: string; label: string }> }> }> {
    const sets = await query<TemplateSetRow>('SELECT * FROM sys_template_sets ORDER BY created_at');
    const items = await query<{ set_id: string; kind: string; label: string }>(
      'SELECT set_id, kind, label FROM sys_template_set_items ORDER BY kind');
    return {
      items: sets.rows.map((s) => ({
        ...s,
        items: items.rows.filter((i) => i.set_id === s.id).map((i) => ({ kind: i.kind, label: i.label })),
      })),
    };
  }

  /** 套件内某 kind 的编辑初值：套件条目 ?? 代码默认（自定义类别无默认→空骨架待 AI 起草/人工填） */
  editSeed(setId: string | null, kind: string): DocTemplate | undefined {
    if (setId) {
      const item = setItemTemplate(setId, kind);
      if (item) return item;
    }
    return codeDefaultTemplate(kind);
  }
}

export { CUSTOM_KIND_RE };
