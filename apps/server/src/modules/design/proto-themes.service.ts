import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import {
  AI_THEME_ID,
  PROTO_THEME_PRESETS,
  sanitizeThemeTokens,
  type ProtoThemePreset,
} from './prototype-pages.js';

/**
 * 原型主题方案库（0034，用户拍板「生成页前可选配色/风格：多套基础默认+可自定义添加」）。
 * 全局共享库（跨项目复用，用户 2026-10-18 拍板）：内置方案=代码基线 PROTO_THEME_PRESETS 不入库
 * （同 doc-templates 哲学），自定义方案存 proto_themes 表；内置不可改删（可另存为自定义）。
 * 'ai'=特殊选项：AI 按项目类型定制（0033 懒派生链不变）。
 * 写路径全走命令链留痕；令牌校验单一源=sanitizeThemeTokens（键白名单+hex/px 值形态）。
 */

export interface ProtoThemeItem {
  id: string; // builtin:* | 'ai' | uuid
  name: string;
  desc: string;
  tokens: Record<string, string>;
  builtin: boolean;
}

const AI_THEME_ITEM: ProtoThemeItem = {
  id: AI_THEME_ID,
  name: 'AI 按项目定制',
  desc: '按项目类型与 PRD 内容自动提炼一套配色（首次生成页面时派生，随规划冻结）',
  tokens: {},
  builtin: true,
};

/** 按 id 解析方案（模块级纯函数，service 与换肤链共用）：'ai'/builtin:* 走代码基线，其余查 DB；查无 → null */
export async function resolveProtoTheme(themeId: string): Promise<ProtoThemeItem | null> {
  if (themeId === AI_THEME_ID) return AI_THEME_ITEM;
  const preset = PROTO_THEME_PRESETS.find((p) => p.id === themeId);
  if (preset) return { ...preset, builtin: true };
  const r = await query<{ id: string; name: string; tokens: Record<string, string> }>(
    'SELECT id, name, tokens FROM proto_themes WHERE id=$1', [themeId]);
  const row = r.rows[0];
  return row
    ? { id: row.id, name: row.name, desc: '自定义方案', tokens: sanitizeThemeTokens(row.tokens), builtin: false }
    : null;
}

@Injectable()
export class ProtoThemesService {
  onModuleInit(): void {
    registerCommand('design.theme.create', async (client, payload, ctx) => {
      const { name, tokens } = payload as { name: string; tokens: Record<string, string> };
      try {
        const r = await client.query<{ id: string }>(
          'INSERT INTO proto_themes (name, tokens, created_by) VALUES ($1,$2,$3) RETURNING id',
          [name, JSON.stringify(tokens), ctx.actorId]);
        return { themeId: r.rows[0]!.id };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new DomainError('VALIDATION_FAILED', '方案名称已存在，换一个名字', name);
        }
        throw e;
      }
    });
    registerCommand('design.theme.update', async (client, payload) => {
      const { themeId, name, tokens } = payload as { themeId: string; name: string; tokens: Record<string, string> };
      let r;
      try {
        r = await client.query(
          'UPDATE proto_themes SET name=$2, tokens=$3, updated_at=now() WHERE id=$1',
          [themeId, name, JSON.stringify(tokens)]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new DomainError('VALIDATION_FAILED', '方案名称已存在，换一个名字', name);
        }
        throw e;
      }
      if (r.rowCount !== 1) throw new DomainError('NOT_FOUND', '方案不存在（内置方案不可修改，可另存为自定义方案）', themeId);
      return { themeId };
    });
    registerCommand('design.theme.delete', async (client, payload) => {
      const { themeId } = payload as { themeId: string };
      const r = await client.query('DELETE FROM proto_themes WHERE id=$1', [themeId]);
      if (r.rowCount !== 1) throw new DomainError('NOT_FOUND', '方案不存在（内置方案不可删除）', themeId);
      return { themeId };
    });
  }

  /** 方案清单：AI 定制 + 内置预设 + 自定义（DB），按此序展示 */
  async list(): Promise<{ items: ProtoThemeItem[] }> {
    const r = await query<{ id: string; name: string; tokens: Record<string, string> }>(
      'SELECT id, name, tokens FROM proto_themes ORDER BY created_at');
    const custom: ProtoThemeItem[] = r.rows.map((x) => ({
      id: x.id, name: x.name, desc: '自定义方案', tokens: sanitizeThemeTokens(x.tokens), builtin: false,
    }));
    const presets: ProtoThemePreset[] = [...PROTO_THEME_PRESETS];
    return { items: [AI_THEME_ITEM, ...presets.map((p) => ({ ...p, builtin: true })), ...custom] };
  }

  /** 按 id 解析方案（应用/展示同源）——模块级 resolveProtoTheme 的实例转发 */
  async resolve(themeId: string): Promise<ProtoThemeItem | null> {
    return resolveProtoTheme(themeId);
  }

  async create(input: { name: string; tokens: Record<string, string> }, ctx: CommandContext): Promise<{ themeId: string }> {
    const name = this.assertName(input.name);
    this.assertNotBuiltinName(name);
    return executeCommand('design.theme.create', { name, tokens: sanitizeThemeTokens(input.tokens) }, ctx) as Promise<{ themeId: string }>;
  }

  async update(themeId: string, input: { name: string; tokens: Record<string, string> }, ctx: CommandContext): Promise<{ themeId: string }> {
    this.assertCustomId(themeId);
    const name = this.assertName(input.name);
    this.assertNotBuiltinName(name);
    return executeCommand('design.theme.update', { themeId, name, tokens: sanitizeThemeTokens(input.tokens) }, ctx) as Promise<{ themeId: string }>;
  }

  async remove(themeId: string, ctx: CommandContext): Promise<{ themeId: string }> {
    this.assertCustomId(themeId);
    return executeCommand('design.theme.delete', { themeId }, ctx) as Promise<{ themeId: string }>;
  }

  private assertCustomId(themeId: string): void {
    if (!themeId || themeId === AI_THEME_ID || themeId.startsWith('builtin:')) {
      throw new DomainError('VALIDATION_FAILED', '内置方案不可修改/删除——可在其基础上另存为自定义方案', themeId || '(空)');
    }
  }

  private assertName(name: string): string {
    const n = (name ?? '').trim();
    if (!n || n.length > 40) throw new DomainError('VALIDATION_FAILED', '方案名称必填且不超过 40 字', 'name');
    return n;
  }

  /** 自定义方案不得与内置方案同名（列表同名混淆来源） */
  private assertNotBuiltinName(name: string): void {
    if (name === AI_THEME_ITEM.name || PROTO_THEME_PRESETS.some((p) => p.name === name)) {
      throw new DomainError('VALIDATION_FAILED', '不能与内置方案同名', name);
    }
  }
}
