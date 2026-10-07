import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../api';
import { Modal } from '../../ui/Modal';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { toast } from '../../ui/toast';
import { useSession } from '../../store';

/** 模板条目（套件内条目或代码默认，结构同形） */
interface TemplateDraftShape {
  label?: string;
  standard: string;
  quality: string;
  writingRules: string[];
  chapters: Array<{ title: string; requires: string }>;
}
interface TemplateSetRow {
  id: string; name: string; description: string;
  items: Array<{ kind: string; label: string }>;
}

const KIND_LABELS: Record<string, string> = {
  crd: 'CRD 客户需求文档', prd: 'PRD 产品需求文档',
  hld: 'HLD 概要设计', mod: 'MOD 模块设计', alg: 'ALG 算法与流程', cls: 'CLS 类与数据结构',
  db: 'DB 数据库设计', api: 'API 接口', ui: 'UI 设计', nfr: 'NFR 非功能规则',
};
const BUILTIN_KINDS = Object.keys(KIND_LABELS);

const base = (p: string) => `/api/v1/projects/${p}`;

/**
 * 文档模板套件管理（2026-10-07 拍板：版本管理=命名套件，按项目绑定、全局复用；自定义类别可 AI 起草）：
 * 「默认模板」只读（代码基线）；套件可新建/克隆/重命名/删除；条目逐项编辑保存（专业度闸服务端把关）；
 * 绑定控件决定当前项目生成链用哪套。AI 起草只出草案，人工审改后保存（纪律不破）。
 */
export function DocTemplatesGroup() {
  const { projectId } = useSession();
  const [sets, setSets] = useState<TemplateSetRow[]>([]);
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [editSetId, setEditSetId] = useState<string>('default'); // 'default'=代码基线只读
  const [kind, setKind] = useState('crd');
  const [draft, setDraft] = useState<TemplateDraftShape | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    const r = await api.get<{ items: TemplateSetRow[]; activeSetId: string | null }>(`${base(projectId)}/template-sets`).catch(() => null);
    if (r) { setSets(r.items); setActiveSetId(r.activeSetId); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const editSet = sets.find((s) => s.id === editSetId) ?? null;
  const isDefaultView = editSetId === 'default';
  // 当前套件的 kind 清单：内置十类 + 套件内自定义类别（x- 前缀）
  const customKinds = editSet ? editSet.items.map((i) => i.kind).filter((k) => !BUILTIN_KINDS.includes(k)) : [];
  const kindList = [...BUILTIN_KINDS, ...customKinds];
  const kindLabel = (k: string) => KIND_LABELS[k] ?? editSet?.items.find((i) => i.kind === k)?.label ?? k;
  const kindHasItem = (k: string) => editSet?.items.some((i) => i.kind === k) ?? false;

  // 载入编辑初值：套件条目 ?? 代码默认
  useEffect(() => {
    setDraft(null);
    setDirty(false);
    if (!projectId) return;
    void (async () => {
      const url = isDefaultView
        ? `${base(projectId)}/doc-templates/${kind}:default`
        : `${base(projectId)}/template-sets/${editSetId}/items/${kind}`;
      const r = await api.get<TemplateDraftShape | { item: TemplateDraftShape | null }>(url).catch(() => null);
      const t = r && ('item' in r ? r.item : r);
      setDraft(t ? { label: t.label ?? '', standard: t.standard, quality: t.quality, writingRules: [...t.writingRules], chapters: t.chapters.map((c) => ({ ...c })) } : { label: '', standard: '', quality: '', writingRules: [], chapters: [] });
    })();
  }, [projectId, editSetId, kind, isDefaultView]);

  const bind = async (setId: string | null) => {
    if (!projectId) return;
    try {
      await api.put(`${base(projectId)}/template-binding`, { setId });
      setActiveSetId(setId);
      toast(setId ? '当前项目已绑定该套件（之后生成/重写按套件模板）' : '已取消绑定，回到系统默认模板', 'success');
    } catch (e) { toast(e instanceof ApiError ? e.message : String(e), 'warn'); }
  };

  const save = async () => {
    if (!projectId || !draft || isDefaultView) return;
    setBusy(true);
    try {
      await api.put(`${base(projectId)}/template-sets/${editSetId}/items/${kind}`, draft);
      toast(`已保存到套件（生成链即时生效，已记审计）`, 'success');
      setDirty(false);
      await load();
    } catch (e) { toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn'); }
    finally { setBusy(false); }
  };

  const dropItem = async () => {
    if (!projectId || isDefaultView) return;
    try {
      await api.del(`${base(projectId)}/template-sets/${editSetId}/items/${kind}`);
      toast('已删除套件内该条目（此文档类别回退系统默认）', 'success');
      await load();
    } catch (e) { toast(e instanceof ApiError ? e.message : String(e), 'warn'); }
  };

  const deleteSet = async () => {
    if (!projectId) return;
    setDeleteOpen(false);
    try {
      await api.post(`${base(projectId)}/template-sets/${editSetId}:delete`, {});
      if (activeSetId === editSetId) setActiveSetId(null);
      setEditSetId('default');
      toast('套件已删除', 'success');
      await load();
    } catch (e) { toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn'); }
  };

  if (!projectId) return null;
  return (
    <div className="set-card">
      <h3>📄 文档模板（套件管理 · 版本复用）</h3>
      <p className="set-note">
        套件=一整套模板的命名版本：按项目/公司各建一套、全局复用。「当前项目生效」决定本项目生成链用哪套；
        未绑定时按系统默认（国际标准）生成。条目逐项编辑，保存过专业度校验；项目级临时模板也可走资料挂参考。
      </p>
      <div className="tpl-setbar">
        <label>查看/编辑：
          <select value={editSetId} onChange={(e) => { setEditSetId(e.target.value); setKind('crd'); }}>
            <option value="default">系统默认（国际标准 · 只读）</option>
            {sets.map((s) => <option key={s.id} value={s.id}>{s.name}（{s.items.length} 项自定义）</option>)}
          </select>
        </label>
        <button className="act" onClick={() => setCreateOpen(true)}>＋ 新建套件</button>
        {!isDefaultView && (
          <>
            {activeSetId === editSetId
              ? <button className="act" onClick={() => void bind(null)}>取消当前项目生效</button>
              : <button className="act primary" onClick={() => void bind(editSetId)}>设为当前项目生效</button>}
            <button className="act" title="删除套件（有项目绑定时须先解绑）" onClick={() => setDeleteOpen(true)}>🗑 删除套件</button>
          </>
        )}
        {activeSetId && (
          <span className="tag tag-ok">当前项目生效：{sets.find((s) => s.id === activeSetId)?.name ?? activeSetId}</span>
        )}
      </div>
      <div className="tpl-editor">
        <div className="tpl-kinds">
          {kindList.map((k) => (
            <button key={k} className={`tpl-kind${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>
              {kindLabel(k)}
              {!BUILTIN_KINDS.includes(k) && <span className="tag tag-warn">自定义类别</span>}
              {kindHasItem(k) && <span className="tag tag-ok" title="套件内有自定义条目">套件自定义</span>}
            </button>
          ))}
          {!isDefaultView && (
            <button className="tpl-kind" onClick={() => setAiOpen(true)}>＋ 新增类别（可 AI 起草）</button>
          )}
        </div>
        {draft && (
          <div className="tpl-form">
            {(!BUILTIN_KINDS.includes(kind)) && (
              <label>类别显示名<input value={draft.label ?? ''} disabled={isDefaultView} onChange={(e) => { setDraft({ ...draft, label: e.target.value }); setDirty(true); }} /></label>
            )}
            <label>依据标准<input value={draft.standard} disabled={isDefaultView} onChange={(e) => { setDraft({ ...draft, standard: e.target.value }); setDirty(true); }} /></label>
            <label>质量要求<textarea rows={2} value={draft.quality} disabled={isDefaultView} onChange={(e) => { setDraft({ ...draft, quality: e.target.value }); setDirty(true); }} /></label>
            <label>编写规则（每行一条，≥3 条）<textarea rows={5} value={draft.writingRules.join('\n')} disabled={isDefaultView} onChange={(e) => { setDraft({ ...draft, writingRules: e.target.value.split('\n') }); setDirty(true); }} /></label>
            <div className="tpl-chapters">
              <div className="tpl-chapters-head">
                <strong>大章结构（标题须中文数字+顿号；内容要求写到可验收粒度）</strong>
                {!isDefaultView && (
                  <button className="act sm" onClick={() => { setDraft({ ...draft, chapters: [...draft.chapters, { title: '', requires: '' }] }); setDirty(true); }}>＋ 添加章</button>
                )}
              </div>
              {draft.chapters.map((c, i) => (
                <div key={i} className="tpl-chapter">
                  <input placeholder="一、章标题" value={c.title} disabled={isDefaultView} onChange={(e) => { setDraft({ ...draft, chapters: draft.chapters.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) }); setDirty(true); }} />
                  <textarea rows={2} placeholder="该章内容要求（≥20 字）" value={c.requires} disabled={isDefaultView} onChange={(e) => { setDraft({ ...draft, chapters: draft.chapters.map((x, j) => (j === i ? { ...x, requires: e.target.value } : x)) }); setDirty(true); }} />
                  {!isDefaultView && (
                    <button className="act sm" title="删除本章" disabled={draft.chapters.length <= 1} onClick={() => { setDraft({ ...draft, chapters: draft.chapters.filter((_, j) => j !== i) }); setDirty(true); }}>✕</button>
                  )}
                </div>
              ))}
            </div>
            <div className="tpl-ops">
              {isDefaultView ? (
                <button className="act primary" onClick={() => setCreateOpen(true)}>＋ 基于此新建套件…</button>
              ) : (
                <>
                  <button className="act primary" disabled={busy || !dirty} title="保存到套件（专业度校验：规则≥3/大章≥4/中文数字顿号/内容要求≥20 字）" onClick={() => void save()}>💾 保存到套件</button>
                  {kindHasItem(kind) && (
                    <button className="act" title="删除套件内该条目，此文档类别回退系统默认" onClick={() => void dropItem()}>↩ 回退默认</button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {createOpen && (
        <CreateSetModal
          projectId={projectId}
          sets={sets}
          onClose={() => setCreateOpen(false)}
          onCreated={async (id) => { setCreateOpen(false); await load(); setEditSetId(id); }}
        />
      )}
      {deleteOpen && editSet && (
        <ConfirmModal
          title="删除套件"
          body={`将删除套件「${editSet.name}」（含其全部自定义条目，不可恢复；有项目绑定时会被拒绝）。`}
          confirmLabel="删除套件"
          onClose={() => setDeleteOpen(false)}
          onConfirm={() => void deleteSet()}
        />
      )}
      {aiOpen && !isDefaultView && (
        <AiDraftModal
          projectId={projectId}
          existingKinds={kindList}
          onClose={() => setAiOpen(false)}
          onDraft={(slug, d) => {
            setAiOpen(false);
            setKind(slug);
            setDraft(d);
            setDirty(true);
            toast('AI 草案已填入编辑区——请人工审改后保存（专业度校验在保存时把关）', 'success');
          }}
        />
      )}
    </div>
  );
}

/** 新建套件 modal：名称+描述+起点（空白=全回退默认 / 克隆既有套件条目） */
function CreateSetModal({ projectId, sets, onClose, onCreated }: {
  projectId: string; sets: TemplateSetRow[]; onClose: () => void; onCreated: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [cloneFrom, setCloneFrom] = useState('default');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ setId: string }>(`${base(projectId)}/template-sets`, {
        name: name.trim(), description: desc.trim(), cloneFrom,
      });
      toast(`套件「${name.trim()}」已创建${cloneFrom === 'default' ? '（各文档类别暂用系统默认，逐项编辑即自定义）' : '（已克隆源套件条目）'}`, 'success');
      await onCreated(r.setId);
    } catch (e) { toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="＋ 新建模板套件" onClose={onClose} footer={
      <>
        <button className="act" onClick={onClose}>取消</button>
        <button className="act primary" disabled={busy || !name.trim()} onClick={() => void submit()}>创建</button>
      </>
    }>
      <label>套件名称（版本管理单位，如「ACME 公司 v1」「项目 A 专用」）<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>描述（可选）<input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <label>起点
        <select value={cloneFrom} onChange={(e) => setCloneFrom(e.target.value)}>
          <option value="default">空白套件（各类别先用系统默认，逐项编辑自定义）</option>
          {sets.map((s) => <option key={s.id} value={s.id}>克隆「{s.name}」的全部自定义条目</option>)}
        </select>
      </label>
    </Modal>
  );
}

/** 新增类别 + AI 起草 modal：slug/显示名/补充说明 → AI 出草案填表单，人工审改后保存 */
function AiDraftModal({ projectId, existingKinds, onClose, onDraft }: {
  projectId: string; existingKinds: string[];
  onClose: () => void; onDraft: (slug: string, d: TemplateDraftShape) => void;
}) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const slugOk = /^x-[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(slug) && !existingKinds.includes(slug);
  const draft = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; draft?: TemplateDraftShape; reason?: string }>(
        `${base(projectId)}/ai/template-draft`, { name: name.trim(), hint: hint.trim() });
      if (r.ok && r.draft) {
        onDraft(slug, r.draft);
      } else {
        toast(r.reason ?? 'AI 起草未产出可用草案，可重试或人工填写', 'warn');
      }
    } catch (e) { toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="＋ 新增模板类别（可 AI 起草）" onClose={onClose} footer={
      <>
        <button className="act" onClick={onClose}>取消</button>
        <button className="act" disabled={!slugOk} title="不起草，直接建空类别去手工填写" onClick={() => onDraft(slug, { label: name.trim(), standard: '', quality: '', writingRules: [], chapters: [{ title: '一、', requires: '' }] })}>建空类别</button>
        <button className="act primary" disabled={busy || !slugOk || !name.trim()} title="AI 按说明起草模板内容（草案填进编辑区，人工审改后保存）" onClick={() => void draft()}>{busy ? '⏳ AI 起草中…' : '✨ AI 起草'}</button>
      </>
    }>
      <label>类别标识（x- 前缀小写，如 x-acceptance 验收方案）<input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="x-" /></label>
      {slug && !slugOk && <p className="pop-tip err">标识须形如 x-xxx（小写字母数字连字符），且不与现有类别重复</p>}
      <label>类别显示名<input value={name} onChange={(e) => setName(e.target.value)} placeholder="验收方案" /></label>
      <label>给 AI 的补充说明（可选：这类文档在你们公司写什么、给谁看）<textarea rows={3} value={hint} onChange={(e) => setHint(e.target.value)} /></label>
      <p className="pop-tip">AI 起草只产出草案填进编辑区——人工审改并保存后才生效（专业度校验在保存时把关）。</p>
    </Modal>
  );
}
