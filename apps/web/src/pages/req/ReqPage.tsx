import { useEffect } from 'react';
import { useDockStore } from '../../assistant/dock-store';
import { GateBanner } from '../../ui/GateBanner';
import { DocPanel } from './DocPanel';
import { RtmPanel } from './RtmPanel';
import { useReqView } from './store';
import './req.css';

/** 需求页（route: /req；LLD-6 §3.3 DSG-U03-3，REQ-201~210）
 *  V2.0：页签条已收编左侧二级列（layout/SubNav），本页只渲染当前 subTab 面板 */
export function ReqPage() {
  const { subTab, setSubTab, init } = useReqView();
  useEffect(() => {
    void init();
  }, [init]);
  // 「🔗 RTM」直达：?tab=rtm 一次性读入（DSG-U02-2；V2.0 起二级列 🔗 RTM 项即此入口）
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'rtm') void setSubTab('rtm');
  }, [setSubTab]);
  // RTM 页签不内嵌 dock（hasDock L1090-1093）；离页恢复
  useEffect(() => {
    useDockStore.getState().setHidden(subTab === 'rtm');
    return () => useDockStore.getState().setHidden(false);
  }, [subTab]);
  return (
    <main>
      <GateBanner stage="req" />
      {subTab === 'rtm' ? <RtmPanel /> : <DocPanel kind={subTab} />}
    </main>
  );
}
