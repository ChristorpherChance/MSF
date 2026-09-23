import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api';
import { useSession } from '../../store';
import { platformApi, type AuditItem } from './api';

/** 审计页（T7-09；A10-3、U07-2）：只读游标查询 + 导出（无任何改删入口） */
export function AuditPage() {
  const projectId = useSession((s) => s.projectId);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null); // 下一页游标
  const [curUsed, setCurUsed] = useState<string | null>(null); // 本页所用游标
  const [prevCursors, setPrevCursors] = useState<Array<string | null>>([]);
  const [actor, setActor] = useState('');
  const [command, setCommand] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (cur: string | null, prevs: Array<string | null>) => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (actor) q.set('actor', actor);
    if (command) q.set('command', command);
    if (cur) q.set('cursor', cur);
    q.set('limit', '50');
    try {
      const r = await platformApi.audit(`?${q.toString()}`);
      setItems(r.items);
      setCursor(r.nextCursor);
      setCurUsed(cur);
      setPrevCursors(prevs);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  }, [projectId, actor, command]);

  useEffect(() => { void load(null, []); }, [load]);

  const exportJson = async () => {
    try {
      const data = await platformApi.auditExport(projectId ?? undefined);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `audit-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h2>审计查询</h2>
      <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: -8 }}>
        哈希链追加存储，只读导出；不提供任何修改/删除端点（REQ-706、BR-04）。
      </p>
      {err && <p style={{ color: 'var(--red)' }}>{err}</p>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input placeholder="操作者" value={actor} onChange={(e) => setActor(e.target.value)} />
        <input placeholder="命令（如 doc.finalize）" value={command} onChange={(e) => setCommand(e.target.value)} />
        <button onClick={() => void load(null, [])}>查询</button>
        <button onClick={() => void exportJson()}>导出 JSON</button>
        <span style={{ fontSize: 12, color: 'var(--ink2)' }}>{projectId ? '范围：当前项目' : '范围：全部（未选项目）'}</span>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--ink2)' }}>
            <th>事件</th><th>时间</th><th>操作者</th><th>命令</th><th>输入指纹</th><th>链上前驱</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.eventId} style={{ borderTop: '1px solid #eee' }}>
              <td><code>{r.eventId}</code></td>
              <td>{r.at.slice(0, 19).replace('T', ' ')}</td>
              <td>{r.actor}（{r.actorType}）</td>
              <td><code>{r.command}</code></td>
              <td title={r.inputFingerprint}><code>{r.inputFingerprint.slice(0, 20)}…</code></td>
              <td title={r.hashChainPrev ?? ''}><code>{r.hashChainPrev ? `${r.hashChainPrev.slice(0, 20)}…` : '（链首）'}</code></td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--ink2)' }}>无记录</td></tr>}
        </tbody>
      </table>

      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button
          disabled={prevCursors.length === 0}
          onClick={() => {
            const prevs = [...prevCursors];
            const prev = prevs.pop() ?? null;
            void load(prev, prevs);
          }}
        >上一页</button>
        <button disabled={!cursor} onClick={() => void load(cursor, [...prevCursors, curUsed])}>下一页</button>
      </div>
    </div>
  );
}
