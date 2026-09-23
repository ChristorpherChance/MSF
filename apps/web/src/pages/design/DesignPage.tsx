import { useEffect } from 'react';
import { DesignDocPanel } from './DesignDocPanel';
import { PrototypePanel } from './PrototypePanel';
import { ReviewPanel } from './ReviewPanel';
import { useDesignView, type DesignSubTab } from './store';
import '../req/req.css';
import { GateBanner } from '../../ui/GateBanner';
import './design.css';

const DETAIL_KINDS = ['mod', 'alg', 'cls', 'db', 'api', 'ui', 'nfr'] as const;

/** 设计页（route: /design；LLD-6 §3.4，REQ-301~312） */
export function DesignPage() {
  const { subTab, setSubTab, init, openReviews } = useDesignView();
  useEffect(() => {
    void init();
  }, [init]);
  const tabs: Array<{ key: DesignSubTab; label: string }> = [
    { key: 'hld', label: '📐 概要设计' },
    { key: 'detail', label: '📚 详细设计' },
    { key: 'prototype', label: '🖥 原型 UI' },
    { key: 'review', label: `🔍 自检评审${openReviews > 0 ? `（${openReviews}）` : ''}` },
  ];
  return (
    <main>
      <GateBanner stage="design" />
      <div className="subtabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={subTab === t.key}
            className={subTab === t.key ? 'on' : ''}
            onClick={() => void setSubTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {subTab === 'hld' && <DesignDocPanel kinds={['hld']} />}
      {subTab === 'detail' && <DesignDocPanel kinds={[...DETAIL_KINDS]} />}
      {subTab === 'prototype' && <PrototypePanel />}
      {subTab === 'review' && <ReviewPanel />}
    </main>
  );
}
