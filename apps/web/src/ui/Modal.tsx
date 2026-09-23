import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

/**
 * 全局弹层设施（DSG-U02-5）：
 * Modal 单实例（调用方条件渲染）、点遮罩/Esc 关闭；Esc 优先关闭弹层（F1 等其余键不冲突）。
 */
export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'default' | 'wide' | 'wider';
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); props.onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props.onClose]);

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className={`modal${props.size && props.size !== 'default' ? ` ${props.size}` : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          {props.title}
          <button className="modal-x" title="关闭（Esc）" onClick={props.onClose}>×</button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
