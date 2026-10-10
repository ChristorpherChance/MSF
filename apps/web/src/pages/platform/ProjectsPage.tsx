import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../../api';
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
 * 2026-10-07：卡片挂模板套件关联（一次绑定，全项目生成链自动套用；不选=系统默认）。
 */

interface TplSetLite { id: string; name: string; items: Array<{ kind: string; label: string }> }

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
  const [tplSets, setTplSets] = useState<TplSetLite[]>([]);
  const [tplBindings, setTplBindings] = useState<Record<string, string>>({});
  const [tplSwitching, setTplSwitching] = useState<string | null>(null);
  const [tplNewFor, setTplNewFor] = useState<ProjectRow | null>(null);
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

  /** 模板套件总览（卡片关联选择器数据源；系统级只读端点） */
  const loadTplSets = useCallback(async () => {
    const r = await api
      .get<{ sets: TplSetLite[]; bindings: Record<string, string> }>('/api/v1/system/template-sets')
      .catch(() => null);
    if (r) { setTplSets(r.sets); setTplBindings(r.bindings); }
  }, []);

  useEffect(() => {
    void refresh();
    void loadTplSets();
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

  /** 卡片套件关联：''=恢复系统默认；'__new__'=打开「新建套件并绑定」弹窗；其余=绑定该套件 */
  const onBindTpl = async (p: ProjectRow, v: string) => {
    if (v === '__new__') { setTplNewFor(p); return; }
    setTplSwitching(p.id);
    try {
      await api.put(`/api/v1/projects/${p.id}/template-binding`, { setId: v || null });
      setTplBindings((m) => {
        const n = { ...m };
        if (v) n[p.id] = v; else delete n[p.id];
        return n;
      });
      toast(
        v
          ? `项目「${p.name}」已关联模板套件「${tplSets.find((s) => s.id === v)?.name ?? ''}」，全部文档生成将自动套用`
          : `项目「${p.name}」已恢复系统默认模板`,
        'success',
      );
    } catch (e) {
      toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn');
    } finally {
      setTplSwitching(null);
    }
  };
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
        <div className="pc-tpl" title="模板套件：一次关联，本项目全部文档生成自动套用；不选=系统默认（国际标准）">
          📄
          <select
            value={tplBindings[p.id] ?? ''}
            disabled={tplSwitching === p.id}
            onChange={(e) => void onBindTpl(p, e.target.value)}
          >
            <option value="">系统默认模板</option>
            {tplSets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="__new__">＋ 新建套件并绑定…</option>
          </select>
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
            <h1 className="tasks-title">项目 <span className="tag tag-ok">101全链验证✓</span></h1>
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
        {tplNewFor && (
          <TplBindModal
            project={tplNewFor}
            onClose={() => setTplNewFor(null)}
            onBound={async () => { setTplNewFor(null); await loadTplSets(); }}
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

/** 「＋ 新建套件并绑定」弹窗：基于系统默认克隆一套空套件（逐项去设置页编辑），创建即绑定本项目 */
function TplBindModal(props: { project: ProjectRow; onClose: () => void; onBound: () => Promise<void> }) {
  const [name, setName] = useState(`${props.project.name} 专用套件`);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await api.post<{ setId: string }>(
        `/api/v1/projects/${props.project.id}/template-sets`,
        { name: name.trim(), description: '', cloneFrom: 'default' },
      );
      await api.put(`/api/v1/projects/${props.project.id}/template-binding`, { setId: created.setId });
      toast(`套件「${name.trim()}」已创建并绑定项目「${props.project.name}」，可去设置页逐类编辑模板`, 'success');
      await props.onBound();
    } catch (e) {
      toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`为「${props.project.name}」新建模板套件`}
      onClose={props.onClose}
      footer={
        <>
          <button className="sm" onClick={props.onClose}>取消</button>
          <button className="sm primary" disabled={!name.trim() || busy} onClick={() => void save()}>创建并绑定</button>
        </>
      }
    >
      <div className="pm-field">
        <label>套件名称</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <p style={{ color: 'var(--ink2)' }}>
        新套件基于系统默认模板（国际标准）创建，创建后即绑定本项目——之后该项目所有文档生成自动套用本套件的自定义项，未自定义的类别仍用系统默认。套件内容随时可在「设置 → 文档模板」里逐类编辑，也可被其他项目复用。
      </p>
    </Modal>
  );
}
