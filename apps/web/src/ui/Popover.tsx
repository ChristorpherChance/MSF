import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

/** Popover：锚点定位、底部出界自动翻转、点击外部/Esc 关闭（DSG-U02-5） */
export function Popover(props: {
  anchor: DOMRect;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); props.onClose(); }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [props.onClose]);

  const a = props.anchor;
  const flip = a.bottom + 320 > window.innerHeight;
  const style: React.CSSProperties = flip
    ? { bottom: window.innerHeight - a.top + 6, left: Math.min(a.left, window.innerWidth - 240) }
    : { top: a.bottom + 6, left: Math.min(a.left, window.innerWidth - 240) };

  return createPortal(
    <div className="popover" ref={ref} style={style}>{props.children}</div>,
    document.body,
  );
}
