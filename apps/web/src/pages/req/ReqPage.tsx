import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDockStore } from '../../assistant/dock-store';
import { GateBanner } from '../../ui/GateBanner';
import { DocPanel } from './DocPanel';
import { RtmPanel } from './RtmPanel';
import { useReqView } from './store';
import './req.css';

/** 需求页（route: /req；LLD-6 §3.3 DSG-U03-3，REQ-201~210）
 *  V2.0：页签条已收编左侧二级列（layout/SubNav），本页只渲染当前 subTab 面板 */
export function ReqPage() {
  const { subTab, setSubTab, init, focusPatches } = useReqView();
  const [params] = useSearchParams();
  useEffect(() => {
    void init();
  }, [init]);
  // 「🔗 RTM」直达：?tab=rtm 一次性读入（DSG-U02-2；V2.0 起二级列 🔗 RTM 项即此入口）
  // dock 工具卡「前往审阅」直达：?tab=crd|prd&focus=pending ——切页签并定位第一条待确认补丁
  // useSearchParams 响应式：已在 /req 时搜索参数变化同样生效（mount-only 读法会漏页内跳转）
  useEffect(() => {
    const tab = params.get('tab');
    if (params.get('focus') === 'pending' && (tab === 'crd' || tab === 'prd')) {
      void focusPatches(tab);
    } else if (tab === 'rtm') {
      void setSubTab('rtm');
    }
  }, [params, setSubTab, focusPatches]);
  // RTM 页签不内嵌 dock（hasDock L1090-1093）；离页恢复
  useEffect(() => {
    useDockStore.getState().setHidden(subTab === 'rtm');
    return () => useDockStore.getState().setHidden(false);
  }, [subTab]);
  // 工件绑定（2026-10-08）：选中 CRD/PRD 即让 dock 加载该文档的会话组——人与 AI 共享「在改哪篇」
  useEffect(() => {
    void useDockStore.getState().setCtx('req', subTab === 'rtm' ? null : subTab);
  }, [subTab]);
  return (
    <main>
      <GateBanner stage="req" />
      {subTab === 'rtm' ? <RtmPanel /> : <DocPanel kind={subTab} />}
    </main>
  );
}
