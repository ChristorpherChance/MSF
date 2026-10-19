import { useCallback, useEffect, useState } from 'react';
import { devApi } from './api';
import { useDevStore } from './store';

/**
 * 运行预览面板（2026-10-18 二期，用户拍板「完整应用形态，人工可点开玩」）：
 * 工作区真实代码在沙箱长驻容器里跑（npm start），平台鉴权反代 /dev-preview/:pid/ 进出；
 * 容器内网零出向、看不到平台会话（Cookie 反代剥离 + Referer 隔离带）。
 */
export function PreviewPanel() {
  const s = useDevStore();
  const pid = s.projectId!;
  const [st, setSt] = useState<{ status: string; url?: string; ip?: string | null; startedAt?: string; lastError?: string | null; lastStatus?: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // iframe 重载用

  const refresh = useCallback(async () => {
    try {
      setSt(await devApi.previewStatus(pid));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [pid]);
  // 5s 轮询：别处启动/停止/容器死（对账自愈落 stopped）本面板都能自感知，不留陈旧「未运行」
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const start = () => s.act(async () => {
    setBusy('启动中（装依赖+容器就绪，约 10~60 秒）…');
    setErr(null);
    try {
      await devApi.previewStart(pid);
      setTick((t) => t + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  });
  const stop = () => s.act(async () => {
    setBusy('停止中…');
    try {
      await devApi.previewStop(pid);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  });

  const running = st?.status === 'running';
  return (
    <div className="dsg-card" style={{ margin: 12 }}>
      <div className="insp-head" style={{ borderBottom: 'none', padding: '0 0 8px' }}>
        <span>🖥 运行预览</span>
        <span className="dsg-prefix" style={{ fontWeight: 400 }}>
          {running
            ? `运行中 · 启动于 ${st.startedAt ? new Date(st.startedAt).toLocaleString() : '—'} · ${st.ip ?? ''}`
            : st?.status === 'stopped' ? '未运行' : '查询中…'}
        </span>
        <span style={{ flex: 1 }} />
        {running ? (
          <>
            <button className="act mini" disabled={busy !== null} onClick={start}>🔄 重启</button>
            <button className="act mini" disabled={busy !== null} onClick={stop}>■ 停止</button>
            <a className="act mini" href={st.url} target="_blank" rel="noreferrer">↗ 新窗口打开</a>
          </>
        ) : (
          <button className="act primary mini" disabled={busy !== null} onClick={start}>▶ 启动预览</button>
        )}
      </div>
      <p className="pop-tip" style={{ margin: '0 0 8px' }}>
        预览跑的是工作区里 AI 写出的真实代码（沙箱容器，内网零出向）。先把任务跑到「编码完成」让工作区有代码，
        再启动预览；代码更新后点 🔄 重启生效。预览里的数据是应用自身的模拟数据。
      </p>
      {busy && <div className="req-banner ok" style={{ margin: '0 0 8px' }}>⏳ {busy}</div>}
      {err && <div className="req-banner dev-bad" style={{ margin: '0 0 8px' }}>⛔ {err}</div>}
      {!running && st?.status === 'stopped' && (
        <div className="doc-empty" style={{ padding: '28px 12px' }}>
          <p style={{ margin: '0 0 6px' }}>预览当前未运行{st.lastError ? `（上次：${st.lastError}）` : ''}。</p>
          <p className="pop-tip" style={{ margin: '0 0 12px' }}>
            点「▶ 启动预览」把工作区最新代码装进沙箱容器跑起来（约 10~60 秒），启动后此处直接内嵌显示运行中的应用。
          </p>
          <button className="act primary" disabled={busy !== null} onClick={start}>▶ 启动预览</button>
        </div>
      )}
      {running && st?.url && (
        <iframe
          key={tick}
          title="运行预览"
          src={st.url}
          sandbox="allow-scripts allow-same-origin allow-forms"
          style={{ width: '100%', height: '68vh', border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }}
        />
      )}
    </div>
  );
}
