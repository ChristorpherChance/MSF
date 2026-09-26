import type { ReactNode } from 'react';
import { Modal } from './Modal';

/**
 * 危险/定稿类操作二次确认弹窗（DSG-U07-2：危险操作一律 modal 二次确认，禁原生 confirm）。
 * body 为字符串时按 \n 拆段显示。
 */
export function ConfirmModal(props: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button className="sm" onClick={props.onClose}>取消</button>
          <button
            className="sm primary"
            onClick={() => { props.onClose(); props.onConfirm(); }}
          >
            {props.confirmLabel ?? '确认'}
          </button>
        </>
      }
    >
      {typeof props.body === 'string'
        ? props.body.split('\n').map((line, i) => <p key={i}>{line}</p>)
        : props.body}
    </Modal>
  );
}
