import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api';
import { useSession } from '../../store';
import { platformApi, type ProjectRow } from './api';

/**
 * 项目列表页（T7-06；U03-1、BR-15）：
 * - 列表/新建/归档（不删除）；示例数据（is_demo）徽标 + 独立分组
 * - 「进入」写会话当前项目并整页刷新（各域 store 重新 init）
 */
export function ProjectsPage() {
  const [items, setItems] = useState<ProjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [isDemo, setIsDemo] = useState(false);
  const currentId = useSession((s) => s.projectId);

  const refresh = useCallback(async () => {
    try {
      setItems(await platformApi.listProjects());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    if (!name.trim()) return;
    try {
      await platformApi.createProject(name.trim(), isDemo);
      setName('');
      setIsDemo(false);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  };

  const archive = async (p: ProjectRow) => {
    if (!window.confirm(`归档项目「${p.name}」？归档不删除，可随时在列表查看。`)) return;
    try {
      await platformApi.archiveProject(p.id);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  };

  const enter = (p: ProjectRow) => {
    useSession.getState().setProject(p.id, p.name);
    window.location.href = '/material'; // 整页刷新：各域 store 重置并 init 到新项目
  };

  const group = (demo: boolean) =>
    items.filter((p) => p.is_demo === demo && p.status === 'active');
  const archived = items.filter((p) => p.status === 'archived');

  const renderRow = (p: ProjectRow) => (
    <tr key={p.id} style={{ opacity: p.status === 'archived' ? 0.55 : 1 }}>
      <td>
        {p.name}
        {p.is_demo && (
          <span style={{ marginLeft: 8, fontSize: 12, padding: '1px 6px', borderRadius: 4, background: 'var(--orange-soft)', color: 'var(--orange)' }}>
            示例数据
          </span>
        )}
        {p.id === currentId && (
          <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--blue)' }}>当前</span>
        )}
      </td>
      <td style={{ fontSize: 12, color: 'var(--ink2)' }}>{p.created_at?.slice(0, 10) ?? ''}</td>
      <td>{p.status === 'archived' ? '已归档' : '活跃'}</td>
      <td style={{ textAlign: 'right' }}>
        {p.status === 'active' && (
          <>
            <button onClick={() => enter(p)} disabled={p.id === currentId}>进入</button>{' '}
            <button onClick={() => void archive(p)}>归档</button>
          </>
        )}
      </td>
    </tr>
  );

  const table = (rows: ProjectRow[]) => (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <tbody>{rows.map(renderRow)}</tbody>
    </table>
  );

  return (
    <div style={{ padding: 20, maxWidth: 880 }}>
      <h2>项目</h2>
      {error && <p style={{ color: 'var(--red)' }}>{error}</p>}

      <section style={{ marginBottom: 20, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新项目名称"
          style={{ padding: '6px 8px', minWidth: 240 }}
        />
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={isDemo} onChange={(e) => setIsDemo(e.target.checked)} /> 示例数据
        </label>
        <button onClick={() => void create()} disabled={!name.trim()}>新建项目</button>
      </section>

      <h3>正式项目（{group(false).length}）</h3>
      {group(false).length ? table(group(false)) : <p style={{ color: 'var(--ink2)' }}>暂无</p>}

      <h3>示例数据（{group(true).length}）</h3>
      <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: -8 }}>示例项目用于体验与演示，与正式数据隔离展示（BR-15）。</p>
      {group(true).length ? table(group(true)) : <p style={{ color: 'var(--ink2)' }}>暂无</p>}

      {archived.length > 0 && (
        <>
          <h3>已归档（{archived.length}）</h3>
          {table(archived)}
        </>
      )}
    </div>
  );
}
