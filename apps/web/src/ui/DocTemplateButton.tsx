import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Modal } from './Modal';
import { toast } from './toast';

/** 文档模板条目（服务端 doc-templates 直出：三级解析链=类别级指定→项目套件→代码默认） */
interface TemplateItem {
  kind: string;
  domain: string;
  standard: string;
  quality: string;
  writingRules: string[];
  chapters: Array<{ title: string; requires: string }>;
  customized: boolean;
  source: 'kind' | 'set' | 'default';
  sourceSetId: string | null;
}
interface SetLite { id: string; name: string; items: Array<{ kind: string; label: string }> }

/**
 * 「📄 模板」查看+换源入口（2026-10-06 可见化；2026-10-07 拍板：弹窗内可按文档类别换源——
 * 跟随项目套件 / 系统默认 / 其他套件（须含该类条目）——三级解析链：类别级指定→项目套件→代码默认）
 */
export function DocTemplateButton({ projectId, kind, label }: { projectId: string; kind: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState<TemplateItem | null>(null);
  const [sets, setSets] = useState<SetLite[]>([]);
  const [note, setNote] = useState('');
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const loadAll = async () => {
    const [t, s] = await Promise.all([
      api.get<{ items: TemplateItem[]; note: string; activeSetId: string | null }>(`/api/v1/projects/${projectId}/doc-templates`).catch(() => null),
      api.get<{ sets: SetLite[] }>(`/api/v1/system/template-sets`).catch(() => null),
    ]);
    if (t) { setItem(t.items.find((x) => x.kind === kind) ?? null); setNote(t.note); setActiveSetId(t.activeSetId); }
    if (s) setSets(s.sets);
  };
  useEffect(() => {
    if (!open) return;
    void loadAll();
  }, [open, projectId, kind]);
  /** 换源：'' = 删除类别级指定（回退跟随项目套件/默认）；setId = 指定套件（须含该类条目） */
  const switchSource = async (setId: string) => {
    setSwitching(true);
    try {
      await api.put(`/api/v1/projects/${projectId}/template-binding/${kind}`, { setId: setId || null });
      toast(setId ? '本文档已改用所选套件的模板（之后生成/重写生效）' : '本文档已恢复跟随项目套件/默认模板', 'success');
      await loadAll();
    } catch (e) {
      toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn');
    } finally {
      setSwitching(false);
    }
  };
  const switchable = sets.filter((s) => s.items.some((i) => i.kind === kind));
  const setName = (id: string | null) => sets.find((s) => s.id === id)?.name ?? '所选套件';
  const sourceText = item?.source === 'kind'
    ? `本文档单独指定（${setName(item.sourceSetId)}）`
    : item?.source === 'set'
      ? `跟随项目绑定套件（${setName(item.sourceSetId)}）`
      : activeSetId
        ? `系统默认（项目套件「${setName(activeSetId)}」未覆盖本文档类别）`
        : '系统默认（国际标准）';
  return (
    <>
      <button
        className="act"
        title="查看本文档的默认模板（国际标准结构+质量要求；可换源到其他套件/默认）"
        onClick={() => setOpen(true)}
      >
        📄 模板
      </button>
      {open && (
        <Modal title={`📄 模板 · ${label ?? kind.toUpperCase()}`} onClose={() => setOpen(false)} size="wide">
          {item === null ? (
            <p>加载中…</p>
          ) : item ? (
            <div className="tpl-view">
              <p>
                <strong>当前来源：</strong>
                {sourceText}
              </p>
              <p>
                <strong>模板来源：</strong>
                <select
                  disabled={switching}
                  value={item.source === 'kind' ? (item.sourceSetId ?? '') : ''}
                  onChange={(e) => void switchSource(e.target.value)}
                >
                  <option value="">跟随项目套件 / 系统默认</option>
                  {switchable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </p>
              <p><strong>依据标准：</strong>{item.standard}</p>
              <p><strong>质量要求：</strong>{item.quality}</p>
              <p><strong>编写规则：</strong></p>
              <ul>
                {item.writingRules.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
              <p><strong>结构（大章 ⇢ 内容要求）：</strong></p>
              <ul>
                {item.chapters.map((c) => (
                  <li key={c.title}><strong>{c.title}</strong>：{c.requires}</li>
                ))}
              </ul>
              <p className="pop-tip">{note}</p>
            </div>
          ) : (
            <p>该文档类型暂无默认模板。</p>
          )}
        </Modal>
      )}
    </>
  );
}
