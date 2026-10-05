import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DesignDocPanel } from './DesignDocPanel';
import { PrototypePanel } from './PrototypePanel';
import { ReviewPanel } from './ReviewPanel';
import { useDesignView } from './store';
import '../req/req.css';
import { GateBanner } from '../../ui/GateBanner';
import './design.css';

const DETAIL_KINDS = ['mod', 'alg', 'cls', 'db', 'api', 'ui', 'nfr'] as const;

/** 设计页（route: /design；LLD-6 §3.4，REQ-301~312）
 *  V2.0：页签条已收编左侧二级列（layout/SubNav，review 未决计数徽随同迁移），本页只渲染当前 subTab 面板 */
export function DesignPage() {
  const { subTab, setSubTab, init } = useDesignView();
  const [params] = useSearchParams();
  useEffect(() => {
    void init();
  }, [init]);
  // dock 工具卡「前往审阅」直达：?tab=hld|detail&focus=pending ——focus=pending 时目标册落位
  // 已由 msf:dsg-proposed 监听完成（含 selKind），此处不再用页签默认值覆盖（ReqPage 同构口径）
  useEffect(() => {
    if (params.get('focus') === 'pending') return;
    const tab = params.get('tab');
    if (tab === 'hld' || tab === 'detail' || tab === 'prototype' || tab === 'review') void setSubTab(tab);
  }, [params, setSubTab]);
  return (
    <main>
      <GateBanner stage="design" />
      {subTab === 'hld' && <DesignDocPanel kinds={['hld']} />}
      {subTab === 'detail' && <DesignDocPanel kinds={[...DETAIL_KINDS]} />}
      {subTab === 'prototype' && <PrototypePanel />}
      {subTab === 'review' && <ReviewPanel />}
    </main>
  );
}
