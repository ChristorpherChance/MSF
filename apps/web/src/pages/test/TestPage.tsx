import { useEffect, useState } from 'react';
import { BatchPlanPanel } from './BatchPlanPanel';
import { RunPanel } from './RunPanel';
import { DefectPanel } from './DefectPanel';
import { ReportPanel } from './ReportPanel';
import { useTstStore } from './store';
import { devApi } from '../dev/api';
import '../req/req.css';
import '../design/design.css';
import '../dev/dev.css';
import { GateBanner } from '../../ui/GateBanner';
import { StatusChips, type StatusChipItem } from '../../ui/StatusChips';
import './test.css';

const STATUS_NAME: Record<string, string> = {
  received: '已接收', planned: '已计划', approved: '已批准', executing: '执行中',
  reported: '已报告', released: '已放行', blocked: '已阻断',
};

/** 测试验收页（LLD-6 §3.6 四页签 + 批次条 .qa-batchbar；REQ-501~511）
 *  V2.0：页签已收编左侧二级列（layout/SubNav，defect 未关闭计数徽随同迁移），本工具条只留状态 */
export function TestPage() {
  const s = useTstStore();
  useEffect(() => {
    void s.init();
  }, []);
  // 运行预览入口（2026-10-18 二期）：轮询预览态——运行中才可点开新窗口；未运行提示去开发页启动
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!s.projectId) return;
    let alive = true;
    const poll = async () => {
      try {
        const st = await devApi.previewStatus(s.projectId!);
        if (alive) setPreviewUrl(st.status === 'running' ? (st.url ?? null) : null);
      } catch { /* 预览状态查询失败不挡主流程 */ }
    };
    void poll();
    const t = setInterval(() => void poll(), 5000);
    return () => { alive = false; clearInterval(t); };
  }, [s.projectId]);
  if (!s.projectId) return <main style={{ padding: 24 }}>加载中…</main>;

  const env = s.batchDetail?.snapshot.environment as { os?: string; browser?: string } | undefined;

  // 瞬时异常/回执收为图标点（与需求/设计页同口径：固定区只留操作，点开看详情）
  const flashItems: StatusChipItem[] = [];
  if (s.error) {
    flashItems.push({ key: 'error', tone: 'err', label: '⛔', detail: s.error });
  }
  if (s.notice) {
    flashItems.push({
      key: 'notice', tone: 'ok', label: '✓',
      detail: (
        <>
          {s.notice}
          <br />
          <button className="act" onClick={s.clearNotice}>知道了</button>
        </>
      ),
    });
  }

  return (
    <main className="proto-wrap qa-workbench">
      <GateBanner stage="test" />
      {/* T1 工作台头部：阶段眉标 + 主标题 + 环境 tag 独立区 */}
      <header className="qa-header">
        <div>
          <span className="qa-eyebrow">S4 / 独立测试</span>
          <h1>把交付结论建立在证据上</h1>
          <p>固定候选 → 确认范围 → 独立验证 → 人工交付</p>
        </div>
        <span className="qa-env-tag">
          {env ? `环境 ${env.os ?? '—'} / ${env.browser ?? '—'}` : '环境 —（接收批次后固定）'}
        </span>
      </header>
      {/* V2.0 页内工具条（页签已迁二级列；留 StatusChips） */}
      <div className="doc-toolbar">
        <strong>测试</strong>
        <StatusChips items={flashItems} />
        <span className="dsg-prefix">{s.loading ? '刷新中…' : ''}</span>
      </div>

      {/* 批次条 .qa-batchbar：当前批次下拉（TB-xxx · buildId）+ 环境 + 接收新交接 */}
      <div className="qa-batchbar">
        <label>当前批次</label>
        <select value={s.selBatchId ?? ''} onChange={(e) => void s.selectBatch(e.target.value || null)}>
          {s.batches.length === 0 && <option value="">尚未接收</option>}
          {s.batches.map((b) => (
            <option key={b.batchId} value={b.batchId}>
              {b.batchId} · {b.buildId ?? '—'}{b.current ? '（最新）' : ''}
            </option>
          ))}
        </select>
        {s.batchDetail && (
          <span className={`qa-status qa-status-${s.batchDetail.status}`}>
            {STATUS_NAME[s.batchDetail.status] ?? s.batchDetail.status}
          </span>
        )}
        <span className="dsg-prefix">
          {env ? `环境 ${env.os ?? '—'} / ${env.browser ?? '—'}` : '等待开发人工确认转测试'}
        </span>
        {s.batchDetail?.blockedReason && <span className="dev-bad">阻断：{s.batchDetail.blockedReason}</span>}
        {s.pendingHandoffs.length > 0 && (
          <button className="act" onClick={() => void s.setSubTab('plan')}>接收新交接</button>
        )}
        {previewUrl ? (
          <a className="act mini" href={previewUrl} target="_blank" rel="noreferrer" title="沙箱里跑着的真实代码（模拟数据）">
            🖥 运行预览 ↗
          </a>
        ) : (
          <span className="dsg-prefix" title="开发页「执行工作区 → 🖥 运行预览」可启动">🖥 预览未运行</span>
        )}
        <span className="dsg-prefix">历史批次只读；新构建=新批次</span>
      </div>

      {/* 面板区独立滚动：头部/页签/批次条固定不动（对齐 material 页固定骨架口径） */}
      <div className="qa-panels">
        {s.subTab === 'plan' && <BatchPlanPanel />}
        {s.subTab === 'run' && <RunPanel />}
        {s.subTab === 'defect' && <DefectPanel />}
        {s.subTab === 'report' && <ReportPanel />}
      </div>

      {/* T1 页脚说明 */}
      <footer className="qa-footer">报告定稿 ≠ 放行 ≠ 生产发布 · 历史批次只读，新构建=新批次</footer>
    </main>
  );
}
