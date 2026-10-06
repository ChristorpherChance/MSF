import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../api';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { toast } from '../../ui/toast';
import { useSession } from '../../store';

/** 文档模板条目（服务端 doc-templates 直出：代码默认+DB 覆盖合并态） */
interface TemplateItem {
  kind: string;
  domain: string;
  standard: string;
  quality: string;
  writingRules: string[];
  chapters: Array<{ title: string; requires: string }>;
  overridden: boolean;
}
type Draft = Omit<TemplateItem, 'domain' | 'overridden'>;

const KIND_LABELS: Record<string, string> = {
  crd: 'CRD 客户需求文档', prd: 'PRD 产品需求文档',
  hld: 'HLD 概要设计', mod: 'MOD 模块设计', alg: 'ALG 算法与流程', cls: 'CLS 类与数据结构',
  db: 'DB 数据库设计', api: 'API 接口', ui: 'UI 设计', nfr: 'NFR 非功能规则',
};

const base = (p: string) => `/api/v1/projects/${p}`;

/**
 * 文档模板编辑器（2026-10-06 拍板）：编辑的是「代码默认之上的 DB 覆盖层」——
 * 保存过服务端 validateTemplate 专业度闸（编写规则≥3/大章≥4/中文数字顿号/内容要求≥20 字），
 * 「恢复默认」删覆盖行回代码基线；保存即命令记审计，生成链即时生效（覆盖缓存随保存刷新）。
 */
export function DocTemplatesGroup() {
  const { projectId } = useSession();
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [kind, setKind] = useState('crd');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    const r = await api.get<{ items: TemplateItem[] }>(`${base(projectId)}/doc-templates`).catch(() => null);
    if (r) setItems(r.items);
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const cur = items.find((t) => t.kind === kind) ?? null;
  // 选中项变化时以生效模板（覆盖或默认）填充表单
  useEffect(() => {
    if (cur) setDraft({ kind: cur.kind, standard: cur.standard, quality: cur.quality, writingRules: [...cur.writingRules], chapters: cur.chapters.map((c) => ({ ...c })) });
    else setDraft(null);
  }, [kind, items]);

  const loadDefault = async () => {
    if (!projectId) return;
    const t = await api.get<Draft>(`${base(projectId)}/doc-templates/${kind}:default`).catch((e) => {
      toast(e instanceof ApiError ? e.message : String(e), 'warn');
      return null;
    });
    if (t) {
      setDraft({ kind, standard: t.standard, quality: t.quality, writingRules: [...t.writingRules], chapters: t.chapters.map((c) => ({ ...c })) });
      toast('已载入代码默认模板到编辑区（未保存）', 'success');
    }
  };

  const save = async () => {
    if (!projectId || !draft || busy) return;
    setBusy(true);
    try {
      await api.put(`${base(projectId)}/doc-templates/${kind}`, {
        standard: draft.standard, quality: draft.quality, writingRules: draft.writingRules.filter((r) => r.trim()), chapters: draft.chapters.filter((c) => c.title.trim() || c.requires.trim()),
      });
      toast(`已保存 ${KIND_LABELS[kind]} 模板覆盖（生成链即时生效，已记审计）`, 'success');
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!projectId) return;
    setResetOpen(false);
    try {
      await api.del(`${base(projectId)}/doc-templates/${kind}`);
      toast(`已恢复 ${KIND_LABELS[kind]} 为系统默认模板`, 'success');
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn');
    }
  };

  if (!projectId) return null;
  return (
    <div className="set-card">
      <h3>📄 文档模板（默认模板 · 国际标准）</h3>
      <p className="set-note">
        编辑保存的是「默认模板之上的覆盖」：保存即生效于之后生成/重写的文档（命令记审计）；恢复默认随时可回系统基线。
        项目级临时自定义也可走「资料页上传模板→挂参考」（用户模板优先）。
      </p>
      <div className="tpl-editor">
        <div className="tpl-kinds">
          {items.map((t) => (
            <button key={t.kind} className={`tpl-kind${kind === t.kind ? ' on' : ''}`} onClick={() => setKind(t.kind)}>
              {KIND_LABELS[t.kind] ?? t.kind}
              {t.overridden && <span className="tag tag-warn" title="已被自定义覆盖">已自定义</span>}
            </button>
          ))}
        </div>
        {draft && (
          <div className="tpl-form">
            <label>依据标准<input value={draft.standard} onChange={(e) => setDraft({ ...draft, standard: e.target.value })} /></label>
            <label>质量要求<textarea rows={2} value={draft.quality} onChange={(e) => setDraft({ ...draft, quality: e.target.value })} /></label>
            <label>编写规则（每行一条，≥3 条）<textarea rows={5} value={draft.writingRules.join('\n')} onChange={(e) => setDraft({ ...draft, writingRules: e.target.value.split('\n') })} /></label>
            <div className="tpl-chapters">
              <div className="tpl-chapters-head">
                <strong>大章结构（标题须中文数字+顿号；内容要求写到可验收粒度）</strong>
                <button className="act sm" onClick={() => setDraft({ ...draft, chapters: [...draft.chapters, { title: '', requires: '' }] })}>＋ 添加章</button>
              </div>
              {draft.chapters.map((c, i) => (
                <div key={i} className="tpl-chapter">
                  <input placeholder="一、章标题" value={c.title} onChange={(e) => setDraft({ ...draft, chapters: draft.chapters.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
                  <textarea rows={2} placeholder="该章内容要求（≥20 字）" value={c.requires} onChange={(e) => setDraft({ ...draft, chapters: draft.chapters.map((x, j) => (j === i ? { ...x, requires: e.target.value } : x)) })} />
                  <button className="act sm" title="删除本章" disabled={draft.chapters.length <= 1} onClick={() => setDraft({ ...draft, chapters: draft.chapters.filter((_, j) => j !== i) })}>✕</button>
                </div>
              ))}
            </div>
            <div className="tpl-ops">
              <button className="act primary" disabled={busy} onClick={() => void save()}>💾 保存覆盖</button>
              <button className="act" onClick={() => void loadDefault()}>⬇ 载入默认</button>
              {cur?.overridden && (
                <button className="act" onClick={() => setResetOpen(true)}>↩ 恢复默认</button>
              )}
            </div>
          </div>
        )}
      </div>
      {resetOpen && (
        <ConfirmModal
          title="恢复默认模板"
          body={`将删除「${KIND_LABELS[kind]}」的自定义覆盖，恢复为系统默认模板（国际标准版）。\n此操作记审计，立即可再次编辑。`}
          confirmLabel="恢复默认"
          onClose={() => setResetOpen(false)}
          onConfirm={() => void reset()}
        />
      )}
    </div>
  );
}
