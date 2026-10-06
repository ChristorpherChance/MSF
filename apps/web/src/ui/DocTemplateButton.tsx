import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';

/** 默认文档模板条目（服务端 platform/doc-templates 直出） */
interface TemplateItem {
  kind: string;
  domain: string;
  standard: string;
  quality: string;
  chapters: Array<{ title: string; requires: string }>;
}

/**
 * 「📄 模板」查看入口（2026-10-06 用户「我没看到模板呢」——模板此前只注入生成 prompt 不可见）。
 * 按当前文档 kind 展示默认模板：依据标准 / 质量要求 / 大章⇢内容要求 / 用户模板优先说明。
 */
export function DocTemplateButton({ projectId, kind, label }: { projectId: string; kind: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TemplateItem[] | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!open || items) return;
    void api.get<{ items: TemplateItem[]; note: string }>(`/api/v1/projects/${projectId}/doc-templates`)
      .then((r) => { setItems(r.items); setNote(r.note); })
      .catch(() => setItems([]));
  }, [open, items, projectId]);
  const item = items?.find((t) => t.kind === kind) ?? null;
  return (
    <>
      <button
        className="act"
        title="查看本文档的默认模板（国际标准结构+质量要求；未提供自定义模板时按此生成，用户模板优先）"
        onClick={() => setOpen(true)}
      >
        📄 模板
      </button>
      {open && (
        <Modal title={`📄 默认模板 · ${label ?? kind.toUpperCase()}`} onClose={() => setOpen(false)} size="wide">
          {items === null ? (
            <p>加载中…</p>
          ) : item ? (
            <div className="tpl-view">
              <p><strong>依据标准：</strong>{item.standard}</p>
              <p><strong>质量要求：</strong>{item.quality}</p>
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
