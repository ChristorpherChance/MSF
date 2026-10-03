import { useEffect } from 'react';
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
  const { subTab, init } = useDesignView();
  useEffect(() => {
    void init();
  }, [init]);
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
