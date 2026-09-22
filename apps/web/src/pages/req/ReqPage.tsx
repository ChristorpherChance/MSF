import { useEffect } from 'react';
import { DocPanel } from './DocPanel';
import { RtmPanel } from './RtmPanel';
import { useReqView, type ReqSubTab } from './store';
import './req.css';

const SUB_TABS: Array<{ key: ReqSubTab; label: string }> = [
  { key: 'crd', label: '📝 CRD' },
  { key: 'prd', label: '📦 PRD' },
  { key: 'rtm', label: '🔗 RTM' },
];

/** 需求页（route: /req；LLD-6 §3.3 DSG-U03-3，REQ-201~210） */
export function ReqPage() {
  const { subTab, setSubTab, init } = useReqView();
  useEffect(() => {
    void init();
  }, [init]);
  return (
    <main>
      <div className="subtabs" role="tablist">
        {SUB_TABS.map((t) => (
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
      {subTab === 'rtm' ? <RtmPanel /> : <DocPanel kind={subTab} />}
    </main>
  );
}
