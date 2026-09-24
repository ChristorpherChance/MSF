import { useState, type ReactNode } from 'react';

export interface StatusChipItem {
  key: string;
  tone: 'ok' | 'warn' | 'info' | 'err';
  label: string;
  /** 点开后 popover 里的完整说明（可含操作按钮） */
  detail: ReactNode;
}

/**
 * 状态 chip 条：把横幅收进工具栏，保持固定区简洁（实机走查反馈）。
 * 点击 chip 在下方弹 popover 看详情/操作，再点或 ✕ 收起；同一时间只展开一条。
 */
export function StatusChips({ items }: { items: StatusChipItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return null;
  const cur = items.find((i) => i.key === open);
  return (
    <span className="status-chips pop-wrap">
      {items.map((i) => (
        <button
          key={i.key}
          className={`status-chip ${i.tone}${open === i.key ? ' on' : ''}`}
          onClick={() => setOpen(open === i.key ? null : i.key)}
        >
          {i.label}
        </button>
      ))}
      {cur && (
        <span className="popover chip-detail" role="status">
          <span className="pop-head">
            <strong>{cur.label}</strong>
            <button className="act mini" onClick={() => setOpen(null)}>✕</button>
          </span>
          <span className="chip-detail-body">{cur.detail}</span>
        </span>
      )}
    </span>
  );
}
