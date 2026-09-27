import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api';
import { useSession } from '../../store';
import { Modal } from '../../ui/Modal';
import { toast } from '../../ui/toast';
import { platformApi, STAGE_NAMES, type ProjectRow } from './api';
import './projects.css';

/**
 * 项目列表页（LLD-6 §3.1 DSG-U03-1；REQ-701、BR-15）：
 * 项目卡网格（图标/名称/阶段 tag/描述/五段进度条/本月成本/编辑·打开）；
 * 新建=projModal 弹窗；归档=语义确认 modal（不删除）；打开按 stage 落对应阶段；
 * 空态虚线新建卡；示例数据独立分组。
 */

const STAGE_ROUTES: Record<string, string> = {
  material: '/material', req: '/req', design: '/design', dev: '/dev', test: '/test',
};

export function ProjectsPage() {
  const [items, setItems] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProjectRow | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ProjectRow | null>(null);
  const [monthCost, setMonthCost] = useState<Record<string, number>>({});
  const currentId = useSession((s) => s.projectId);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      setItems(await platformApi.listProjects());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 本月成本（按项目聚合，卡片展示）
    platformApi.usageSummary('current')
      .then((r) => {
        const map: Record<string, number> = {};
        for (const row of r.items) {
          if (row.project_id) map[row.project_id] = (map[row.project_id] ?? 0) + Number(row.cost);
        }
        setMonthCost(map);
      })
      .catch(() => undefined);
  }, [refresh]);

  /** 打开：按 stage 字段落到对应阶段（首个未达标门；全部达标落测试验收；U-004：无门禁数据=未启动，落资料阶段） */
  const enter = (p: ProjectRow) => {
    useSession.getState().setProject(p.id, p.name);
    const gates = Array.isArray(p.stage_gates) ? p.stage_gates : [];
    if (gates.length === 0) { navigate('/material'); return; }
    const firstGap = gates.find((g) => !g.ok);
    navigate(STAGE_ROUTES[firstGap?.stage ?? 'test'] ?? '/material');
  };

  const doArchive = async () => {
    if (!archiveTarget) return;
    try {
      await platformApi.archiveProject(archiveTarget.id);
      toast(`项目「${archiveTarget.name}」已归档`, 'success');
      setArchiveTarget(null);
      await refresh();
    } catch (e) {
      toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn');
    }
  };

  const group = (demo: boolean) => items.filter((p) => p.is_demo === demo && p.status === 'active');
  const archived = items.filter((p) => p.status === 'archived');

  const card = (p: ProjectRow) => {
    const gates = Array.isArray(p.stage_gates) ? p.stage_gates : [];
    const okCount = gates.filter((g) => g.ok).length;
    const currentStage = gates.find((g) => !g.ok)?.stage ?? (gates.length === 5 ? 'test' : null);
    return (
      <div key={p.id} className={`proj-card${p.id === currentId ? ' current' : ''}`}>
        <div className="pc-head">
          <span className="pc-icon">{p.is_demo ? '🧪' : '🏭'}</span>
          <span className="pc-name" title={p.name}>{p.name}</span>
          {p.is_demo && <span className="tag tag-demo">示例数据</span>}
          {p.id === currentId && <span className="tag tag-current">当前</span>}
        </div>
        <div className="pc-stage">
          {currentStage
            ? <span className="tag">阶段：{STAGE_NAMES[currentStage] ?? currentStage}</span>
            : <span className="tag">未启动</span>}
          <span className="pc-cost">💰 ${(monthCost[p.id] ?? 0).toFixed(4)}/月</span>
        </div>
        <div className="pc-desc">{p.description || '（无描述）'}</div>
        <div className="proj-stagebar" title={`五阶段进度 ${okCount}/5`}>
          {['material', 'req', 'design', 'dev', 'test'].map((st) => {
            const g = gates.find((x) => x.stage === st);
            return <i key={st} className={g ? (g.ok ? 'ok' : 'gap') : ''} />;
          })}
        </div>
        <div className="pc-foot">
          <span className="pc-date">{p.created_at?.slice(0, 10)}</span>
          <button className="sm" onClick={() => setEditTarget(p)}>编辑</button>
          <button className="sm primary" onClick={() => enter(p)}>
            {p.id === currentId ? '进入工作台' : '打开'}
          </button>
          <button className="sm danger-ghost" onClick={() => setArchiveTarget(p)}>归档</button>
        </div>
      </div>
    );
  };

  return (
    <div className="full-wrap">
      <div className="full-inner proj-inner">
        <div className="proj-titlebar">
          <div>
            <h1 className="tasks-title">项目</h1>
            <p className="tasks-sub">选择或创建一个软件工厂项目；打开后按阶段准入落到对应阶段。</p>
          </div>
          <button className="primary proj-new" onClick={() => setCreateOpen(true)}>＋ 新建项目</button>
        </div>
        {error && <p style={{ color: 'var(--red)' }}>{error}</p>}

        {loading && (
          <div className="proj-grid">
            {[1, 2, 3].map((i) => <div key={i} className="proj-card skeleton" />)}
          </div>
        )}

        {!loading && (
          <>
            <h3 className="proj-group">正式项目（{group(false).length}）</h3>
            <div className="proj-grid">
              {group(false).map(card)}
              <button className="newcard" onClick={() => setCreateOpen(true)}>
                ＋ 新建项目
              </button>
            </div>

            {group(true).length > 0 && (
              <>
                <h3 className="proj-group">示例数据（{group(true).length}）</h3>
                <p className="proj-note">示例项目用于体验与演示，与正式数据隔离展示（BR-15）。</p>
                <div className="proj-grid">{group(true).map(card)}</div>
              </>
            )}

            {archived.length > 0 && (
              <>
                <h3 className="proj-group">已归档（{archived.length}）</h3>
                <div className="proj-grid">
                  {archived.map((p) => (
                    <div key={p.id} className="proj-card archived">
                      <div className="pc-head">
                        <span className="pc-icon">{p.is_demo ? '🧪' : '🏭'}</span>
                        <span className="pc-name">{p.name}</span>
                        <span className="tag">已归档</span>
                      </div>
                      <div className="pc-desc">{p.description || '（无描述）'}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {createOpen && (
          <ProjectModal
            title="新建项目"
            onClose={() => setCreateOpen(false)}
            onSaved={async () => { setCreateOpen(false); toast('项目已创建', 'success'); await refresh(); }}
          />
        )}
        {editTarget && (
          <ProjectModal
            title={`编辑项目「${editTarget.name}」`}
            initial={editTarget}
            onClose={() => setEditTarget(null)}
            onSaved={async () => { setEditTarget(null); toast('已保存', 'success'); await refresh(); }}
          />
        )}
        {archiveTarget && (
          <Modal
            title="归档项目"
            onClose={() => setArchiveTarget(null)}
            footer={
              <>
                <button className="sm" onClick={() => setArchiveTarget(null)}>取消</button>
                <button className="sm danger-ghost" onClick={() => void doArchive()}>确认归档</button>
              </>
            }
          >
            <p>归档「<strong>{archiveTarget.name}</strong>」？</p>
            <p style={{ color: 'var(--ink2)' }}>
              归档不删除任何数据：文档、基线、批次、审计与证据全部保留，项目从活跃列表移入「已归档」分组，随时可查看。
            </p>
          </Modal>
        )}
      </div>
    </div>
  );
}

/** 新建/编辑项目弹窗（projModal 口径） */
function ProjectModal(props: {
  title: string;
  initial?: ProjectRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(props.initial?.name ?? '');
  const [description, setDescription] = useState(props.initial?.description ?? '');
  const [isDemo, setIsDemo] = useState(props.initial?.is_demo ?? false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (props.initial) {
        await platformApi.updateProject(props.initial.id, { name: name.trim(), description });
      } else {
        const created = await platformApi.createProject(name.trim(), isDemo, description);
        // U-003：创建即切换为当前项目并落资料阶段（新项目从第一段开始）
        useSession.getState().setProject(created.id, name.trim());
        navigate('/material');
      }
      await props.onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button className="sm" onClick={props.onClose}>取消</button>
          <button className="sm primary" disabled={!name.trim() || busy} onClick={() => void save()}>
            {props.initial ? '保存' : '创建'}
          </button>
        </>
      }
    >
      <div className="pm-field">
        <label>项目名称</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="pm-field">
        <label>描述</label>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {!props.initial && (
        <label className="pm-check">
          <input type="checkbox" checked={isDemo} onChange={(e) => setIsDemo(e.target.checked)} />
          示例数据（与正式数据隔离展示，BR-15）
        </label>
      )}
    </Modal>
  );
}
