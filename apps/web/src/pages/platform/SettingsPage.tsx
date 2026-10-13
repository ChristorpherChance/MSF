import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api';
import { Modal } from '../../ui/Modal';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { toast } from '../../ui/toast';
import { useSession } from '../../store';
import {
  platformApi,
  promptsApi,
  reflectionsApi,
  toolsApi,
  type AgentBaselineRow,
  type PromptVersionRow,
  type ReflectionListItem,
  type ReflectionProposal,
} from './api';
import { AuditGroup, BackupGroup, ModelsGroup, PolicyGroup, SystemGroup } from './SettingsGroups';
import { DocTemplatesGroup } from './DocTemplatesGroup';
import './settings.css';

/**
 * 设置页 Agent 区（Task 7，设计 §5）：
 * - 名册数据源 = GET /api/v1/system/agent-baseline（stage-guides DEFAULT_AGENTS 只读镜像）——
 *   前端不再内置 AGENTS 常量；旧 ag-* 六员退役不展示（库中版本行保留可读，服务端不管）
 * - 生效全文口径与服务端 agent-prompts.resolveAgentPrompt 同源：overlay 非空 = base + 空行 + overlay
 */
const effectiveText = (v: PromptVersionRow) => (v.overlay_text ? `${v.base_prompt}\n\n${v.overlay_text}` : v.base_prompt);

type NavKey = 'agents' | 'models' | 'templates' | 'policy' | 'audit' | 'backup' | 'system';
const NAV: Array<[NavKey, string]> = [
  ['agents', '🤖 Agent 配置'],
  ['models', '🧩 模型配置'],
  ['templates', '📄 文档模板'],
  ['policy', '🛂 放行策略'],
  ['audit', '🧾 审计'],
  ['backup', '💾 备份'],
  ['system', '⚙️ 系统设置'],
];

/**
 * 设置页（LLD-6 §3.9 DSG-U03-9；C1-C8）：
 * 左 .set-nav 七组 + 右 .set-body；Agent 配置 = 两层名册树（全局助手 + 六阶段主 + 各阶段子分组）+ 右侧 Agent 卡。
 */
export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const navParam = params.get('nav') as NavKey | null;
  const [nav, setNav] = useState<NavKey>(NAV.some(([k]) => k === navParam) ? navParam! : 'agents');
  const [roster, setRoster] = useState<AgentBaselineRow[]>([]);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  /** key → 当前生效用户版本号（名册树版本角标；无=代码默认基底生效） */
  const [currentMap, setCurrentMap] = useState<Record<string, number>>({});
  const [selAgent, setSelAgent] = useState<string>('assistant');
  /** 阶段分组折叠态（缺省展开；key=group 名） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const loadRoster = useCallback(async () => {
    const [b, a] = await Promise.all([
      promptsApi.baselines().catch(() => ({ items: [] as AgentBaselineRow[] })),
      promptsApi.agents().catch(() => ({ items: [] as PromptVersionRow[] })),
    ]);
    setRoster(b.items);
    const m: Record<string, number> = {};
    for (const row of a.items) if (row.kind === 'prompt' && row.is_current) m[row.agent_key] = row.version_no;
    setCurrentMap(m);
    setRosterLoaded(true);
  }, []);
  useEffect(() => { void loadRoster(); }, [loadRoster]);

  const pick = (k: NavKey) => { setNav(k); setParams({ nav: k }, { replace: true }); };

  const globalDef = roster.find((r) => r.role === 'global') ?? null;
  const mains = roster.filter((r) => r.role === 'main');
  const subsOf = (group: string) => roster.filter((r) => r.group === group && (r.role === 'sub' || r.role === 'overlay'));
  const selDef = roster.find((r) => r.key === selAgent) ?? null;

  const verBadge = (k: string) => (currentMap[k] ? <span className="sn-ver">v{currentMap[k]}</span> : null);

  return (
    <div className="full-wrap">
      <div className="full-inner">
        <h2>设置</h2>
        <p className="set-note" style={{ marginTop: -6 }}>
          Agent Prompt 版本化管理（代码基底 + 用户版本三层链）· 多模型接入（pi-ai）· 系统策略
        </p>
        <div className="set-layout">
          <div className="set-nav">
            {NAV.map(([k, label]) => (
              <div key={k}>
                <div className={`sn-item${nav === k ? ' active' : ''}`} onClick={() => pick(k)}>{label}</div>
                {k === 'agents' && nav === 'agents' && (
                  <div>
                    {globalDef && (
                      <div
                        className={`sn-item sub${selAgent === globalDef.key ? ' active' : ''}`}
                        onClick={() => setSelAgent(globalDef.key)}
                      >🌐 {globalDef.name}{verBadge(globalDef.key)}</div>
                    )}
                    {mains.map((m) => {
                      const subs = subsOf(m.group);
                      const open = !collapsed[m.group];
                      return (
                        <div key={m.key}>
                          <div
                            className={`sn-item sub sn-tree-head${selAgent === m.key ? ' active' : ''}`}
                            onClick={() => setSelAgent(m.key)}
                          >
                            {subs.length > 0 && (
                              <span
                                className="sn-arrow"
                                title={open ? '折叠子分组' : '展开子分组'}
                                onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [m.group]: !c[m.group] })); }}
                              >{open ? '▾' : '▸'}</span>
                            )}
                            {m.name}
                            {verBadge(m.key)}
                          </div>
                          {open && subs.map((s) => (
                            <div
                              key={s.key}
                              className={`sn-item sub2${selAgent === s.key ? ' active' : ''}`}
                              onClick={() => setSelAgent(s.key)}
                            >{s.name}{verBadge(s.key)}</div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="set-body">
            {nav === 'agents' && (
              !rosterLoaded
                ? <div className="empty-tip">Agent 名册加载中…</div>
                : selDef && selDef.role !== 'global'
                  ? <AgentCard key={selDef.key} def={selDef} onChanged={() => void loadRoster()} />
                  : globalDef
                    ? <GlobalAssistantCard def={globalDef} onChanged={() => void loadRoster()} />
                    : <div className="empty-tip">Agent 名册为空（agent-baseline 端点未返回数据）</div>
            )}
            {nav === 'models' && <ModelsGroup />}
            {nav === 'templates' && <DocTemplatesGroup />}
            {nav === 'policy' && <PolicyGroup />}
            {nav === 'audit' && <AuditGroup />}
            {nav === 'backup' && <BackupGroup />}
            {nav === 'system' && <SystemGroup />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** C2 通用版本列表（.pver-row：设为生效/重命名/删除，生效版不可删）+ 新版本编辑区 */
function VersionEditor(props: {
  agentKey: string; agentGroup: string; kind: 'prompt' | 'std';
  basePrompt: string; placeholder: string; onChanged: () => void;
}) {
  const [versions, setVersions] = useState<PromptVersionRow[]>([]);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState<PromptVersionRow | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [delTarget, setDelTarget] = useState<PromptVersionRow | null>(null);

  const load = useCallback(async () => {
    const r = await promptsApi.versions(props.agentKey).catch(() => ({ items: [] as PromptVersionRow[] }));
    setVersions(r.items.filter((v) => v.kind === props.kind));
  }, [props.agentKey, props.kind]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    try { await fn(); toast(okMsg, 'success'); await load(); props.onChanged(); }
    catch (e) { toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn'); }
  };

  return (
    <>
      <div className="set-subhead">
        {props.kind === 'std' ? '自定义叠加版本' : '自定义 Prompt 版本'}{' '}
        <span className="sub-note">· 执行时必须使用「当前生效」版本，会话启动时快照并落审计</span>
      </div>
      {versions.length === 0 && (
        <div className="empty-tip" style={{ padding: 14 }}>
          {props.kind === 'std' ? '暂无叠加版本，当前仅使用系统默认规范' : '暂无自定义版本，当前直接使用代码默认基底'}
        </div>
      )}
      {versions.map((v) => (
        <div key={v.id} className={`pver-row${v.is_current ? ' current' : ''}`}>
          {v.is_current
            ? <span className="tag tag-ok">当前生效</span>
            : (
              <button className="act mini" onClick={() => void run(
                () => promptsApi.setCurrent(props.agentKey, v.version_no),
                '已切换生效版本，下次会话启动生效',
              )}>设为生效</button>
            )}
          <b style={{ flex: '0 0 auto' }}>v{v.version_no} {v.name}</b>
          {v.created_by === 'reflection' && <span className="tag">🪞 反思</span>}
          <span className="pver-text" title={v.overlay_text || v.base_prompt}>{v.overlay_text || v.base_prompt}</span>
          <button className="act mini" title="重命名" onClick={() => { setRenaming(v); setRenameVal(v.name ?? ''); }}>✏</button>
          <button
            className="act mini" title={v.is_current ? '当前生效版本不可删除' : '删除'}
            onClick={() => {
              if (v.is_current) { toast('当前生效版本不可删除', 'warn'); return; }
              setDelTarget(v);
            }}
          >🗑</button>
        </div>
      ))}
      {delTarget && (
        <ConfirmModal
          title={`删除版本 v${delTarget.version_no}`}
          confirmLabel="删除"
          body={`删除版本 v${delTarget.version_no}「${delTarget.name ?? ''}」？`}
          onClose={() => setDelTarget(null)}
          onConfirm={() => void run(() => promptsApi.remove(props.agentKey, delTarget.version_no), '已删除')}
        />
      )}
      <div style={{ marginTop: 12 }}>
        <textarea
          className="prompt-editor" style={{ minHeight: 90 }}
          placeholder={props.placeholder}
          value={draft} onChange={(e) => setDraft(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button
            className="act" disabled={!draft.trim()}
            onClick={() => void run(async () => {
              await promptsApi.publish({
                agentKey: props.agentKey, agentGroup: props.agentGroup,
                basePrompt: props.basePrompt, overlayText: draft.trim(), kind: props.kind, activate: false,
              });
              setDraft('');
            }, '已另存为新版本')}
          >另存为新版本</button>
          <button
            className="act primary" disabled={!draft.trim()}
            onClick={() => void run(async () => {
              await promptsApi.publish({
                agentKey: props.agentKey, agentGroup: props.agentGroup,
                basePrompt: props.basePrompt, overlayText: draft.trim(), kind: props.kind, activate: true,
              });
              setDraft('');
            }, '已保存并设为生效版本')}
          >另存并设为生效</button>
        </div>
      </div>
      {renaming && (
        <Modal
          title="重命名版本" onClose={() => setRenaming(null)}
          footer={(
            <>
              <button className="act" onClick={() => setRenaming(null)}>取消</button>
              <button
                className="act primary" disabled={!renameVal.trim()}
                onClick={() => void run(async () => {
                  await promptsApi.rename(props.agentKey, renaming.version_no, renameVal.trim());
                  setRenaming(null);
                }, '已重命名')}
              >保存</button>
            </>
          )}
        >
          <input style={{ width: '100%' }} value={renameVal} onChange={(e) => setRenameVal(e.target.value)} />
        </Modal>
      )}
    </>
  );
}

/**
 * C2 Agent 卡重做（设计 §5）：
 * 生效源标签（代码默认基底 / 用户版本 vN·可回退基底）+「查看默认基底」只读对照抽屉（基底 vs 当前版并排）
 * + 大编辑区版本列表 + 反思提案区 + 执行自检；overlay 角色（dev.coding-std）换编码规范叠加区。
 */
function AgentCard({ def, onChanged }: { def: AgentBaselineRow; onChanged: () => void }) {
  const isStd = def.role === 'overlay';
  const kind = isStd ? 'std' as const : 'prompt' as const;
  const [showCompare, setShowCompare] = useState(false);
  const [current, setCurrent] = useState<PromptVersionRow | null>(null);

  const loadCurrent = useCallback(async () => {
    const r = await promptsApi.versions(def.key).catch(() => ({ items: [] as PromptVersionRow[] }));
    setCurrent(r.items.find((x) => x.is_current && x.kind === kind) ?? null);
  }, [def.key, kind]);
  useEffect(() => { void loadCurrent(); }, [loadCurrent]);

  const curText = current ? effectiveText(current) : null;
  const refresh = () => { void loadCurrent(); onChanged(); };

  return (
    <>
      <div className="set-card">
        <h3>
          {def.group} · {def.name}{' '}
          {current
            ? <span className="tag tag-ok">用户版本 v{current.version_no} · 可回退基底</span>
            : <span className="tag">代码默认基底</span>}
        </h3>
        <div style={{ marginBottom: 8 }}>
          <button className="act mini" onClick={() => setShowCompare((x) => !x)}>
            {showCompare ? '收起对照' : '查看默认基底对照（只读）'}
          </button>
        </div>
        {showCompare && (
          <div className="cmp-grid">
            <div>
              <div className="cmp-col-head">代码默认基底（stage-guides 内置，只读不可改）</div>
              <textarea className="prompt-editor readonly" readOnly value={def.prompt} />
            </div>
            <div>
              <div className="cmp-col-head">
                当前生效（{current ? `用户版本 v${current.version_no}${current.name ? ` · ${current.name}` : ''}` : '同左 · 代码默认基底'}）
              </div>
              <textarea className="prompt-editor readonly" readOnly value={curText ?? def.prompt} />
            </div>
          </div>
        )}
        {!isStd && (
          <VersionEditor
            agentKey={def.key} agentGroup={def.group} kind="prompt"
            basePrompt={def.prompt}
            placeholder="在此编写新的 Prompt 叠加内容，另存为新版本…"
            onChanged={refresh}
          />
        )}
      </div>
      {isStd && <StdOverlayCard def={def} onChanged={refresh} />}
      <ReflectionSection agentKey={def.key} currentText={curText ?? def.prompt} onChanged={refresh} />
      <div className="set-card">
        <h3>执行自检</h3>
        <div className="op-result">
          ✅ 当前生效版本：{def.name} ·「{current ? `v${current.version_no} ${current.name ?? ''}` : '代码默认基底'}」
          · 会话启动时快照生效版本并写入审计日志
        </div>
      </div>
    </>
  );
}

/** 编码规范叠加卡（dev.coding-std 收编为名册 overlay 节点；kind='std' 与开发页 📏 编码规范同源） */
function StdOverlayCard({ def, onChanged }: { def: AgentBaselineRow; onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  return (
    <div className="set-card">
      <h3>📏 编码规范 <span className="tag">开发 Agent 叠加区</span></h3>
      <p className="set-note" style={{ marginBottom: 10 }}>
        开发阶段「📏 编码规范」页的编辑落点：系统默认规范只读不可改；自定义叠加版本注入全部 🤖 委派与 PR
        checklist「编码规范符合」判定，会话启动时快照并落审计。
      </p>
      <div className="set-subhead">系统默认规范基底（只读，与代码基底同源）</div>
      <textarea className="prompt-editor readonly" readOnly value={def.prompt} />
      <VersionEditor
        key={tick}
        agentKey={def.key} agentGroup={def.group} kind="std"
        basePrompt={def.prompt}
        placeholder="在此编写编码规范叠加内容（如：门户语境附加约束），另存为新版本…"
        onChanged={() => { setTick((x) => x + 1); onChanged(); }}
      />
    </div>
  );
}

/**
 * 反思提案区（设计 §4/§5）：该 agent 的 pending 提案（summary+理由+并排对照+采用/拒绝 → reflections:resolve）
 * +「🪞 立即反思」手动触发（长调用同步等待；INVALID_STATE 并发闸 / MODEL_UNAVAILABLE 人话 toast）
 */
function ReflectionSection(props: { agentKey: string; currentText: string; onChanged: () => void }) {
  const [items, setItems] = useState<ReflectionListItem[]>([]);
  const [pendings, setPendings] = useState<Array<ReflectionProposal & { reflectionId: string; createdAt: string }>>([]);
  const [versions, setVersions] = useState<PromptVersionRow[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // 处置在飞的提案键（防连点重复提交；服务端重复处置返回 INVALID_STATE）
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const l = await reflectionsApi.list().catch(() => ({ items: [] as ReflectionListItem[] }));
    setItems(l.items);
    // 只对有 pending 的场次拉明细，按 agentKey 过滤出本 agent 的待审提案
    const found: Array<ReflectionProposal & { reflectionId: string; createdAt: string }> = [];
    for (const it of l.items.filter((x) => x.counts.pending > 0)) {
      const d = await reflectionsApi.detail(it.id).catch(() => null);
      if (!d) continue;
      for (const p of d.proposals) {
        if (p.agentKey === props.agentKey && p.status === 'pending') {
          found.push({ ...p, reflectionId: it.id, createdAt: it.createdAt });
        }
      }
    }
    setPendings(found);
    const v = await promptsApi.versions(props.agentKey).catch(() => ({ items: [] as PromptVersionRow[] }));
    setVersions(v.items);
  }, [props.agentKey]);
  useEffect(() => { void load(); }, [load]);

  const runReflection = async () => {
    setRunning(true);
    try {
      await reflectionsApi.run();
      toast('反思完成：报告与提案已生成（零提案=本期无需调整）', 'success');
      await load();
      props.onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INVALID_STATE') {
        toast('已有反思任务进行中，待其终态后可再发起', 'warn');
      } else if (e instanceof ApiError && e.code === 'MODEL_UNAVAILABLE') {
        toast('反思用途无可用模型：请到「模型配置」启用模型（无显式路由时自动取窗口最大者）', 'warn');
      } else {
        toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn');
      }
    } finally { setRunning(false); }
  };

  const resolve = (p: ReflectionProposal & { reflectionId: string }, action: 'adopt' | 'reject') =>
    void (async () => {
      const key = `${p.reflectionId}:${p.versionNo}`;
      setResolvingKey(key);
      try {
        await reflectionsApi.resolve({ reflectionId: p.reflectionId, agentKey: p.agentKey, versionNo: p.versionNo, action });
        toast(action === 'adopt' ? '已采用：提案版本设为当前生效（旧版可回退）' : '已拒绝：该方向将回喂反思器，不再重复提议', 'success');
        await load();
        props.onChanged();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'INVALID_STATE') {
          toast('该提案已处置，无需重复操作', 'warn');
          await load();
        } else {
          toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn');
        }
      } finally { setResolvingKey(null); }
    })();

  return (
    <div className="set-card">
      <h3>
        🪞 反思提案 <span className={`tag${pendings.length > 0 ? ' tag-warn' : ''}`}>{pendings.length} 条待审</span>
        <span style={{ flex: 1 }} />
        <button className="act mini" disabled={running} onClick={() => void runReflection()}>
          {running ? '⏳ 反思进行中…（通常需数分钟）' : '🪞 立即反思'}
        </button>
      </h3>
      <p className="set-note" style={{ marginBottom: 10 }}>
        反思器按周巡检全部 Agent 使用信号并产出整篇修订提案；采用 = 提案版本设为当前生效（旧版可回退），
        拒绝 = 方向回喂不再重提。近 {items.length} 场反思记录。
      </p>
      {pendings.length === 0 && <div className="empty-tip" style={{ padding: 14 }}>暂无该 Agent 的待审提案</div>}
      {pendings.map((p) => {
        const k = `${p.reflectionId}:${p.versionNo}`;
        // 提案全文 = 直插版本行 base_prompt（overlay 为空；normalizeProposals 保证 fullText 非空）
        const ver = versions.find((v) => v.version_no === p.versionNo && v.kind === 'prompt');
        return (
          <div key={k} className="refl-prop">
            <div className="refl-head">
              <span className="tag tag-warn">待审</span>
              <b>v{p.versionNo}</b>
              <span className="refl-sum">{p.summary || '（无摘要）'}</span>
              <span className="set-note">{p.createdAt.slice(0, 16).replace('T', ' ')}</span>
              <button className="act mini" onClick={() => setOpenKey(openKey === k ? null : k)}>
                {openKey === k ? '收起对照' : '并排对照'}
              </button>
              <button className="act mini primary" disabled={resolvingKey === k} onClick={() => resolve(p, 'adopt')}>采用</button>
              <button className="act mini" disabled={resolvingKey === k} onClick={() => resolve(p, 'reject')}>拒绝</button>
            </div>
            {openKey === k && (
              <div className="cmp-grid">
                <div>
                  <div className="cmp-col-head">当前生效</div>
                  <textarea className="prompt-editor readonly" readOnly value={props.currentText} />
                </div>
                <div>
                  <div className="cmp-col-head">反思提案 v{p.versionNo}（整篇修订全文）</div>
                  <textarea className="prompt-editor readonly" readOnly value={ver ? effectiveText(ver) : '（提案版本全文加载失败）'} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** C3 全局 AI 助手卡（原位升级）：基底/叠加版本/工具开关/默认思考强度/上下文叠加提示/反思提案/执行自检 */
function GlobalAssistantCard({ def, onChanged }: { def: AgentBaselineRow; onChanged: () => void }) {
  const projectId = useSession((s) => s.projectId);
  const [versions, setVersions] = useState<PromptVersionRow[]>([]);
  const [tools, setTools] = useState<Array<{ name: string; kind: string; description: string }>>([]);
  const [toolsEnabled, setToolsEnabled] = useState<Record<string, boolean>>({});
  const [thinkDefault, setThinkDefault] = useState<string>('mid');

  const load = useCallback(async () => {
    const [v, s] = await Promise.all([
      promptsApi.versions(def.key).catch(() => ({ items: [] as PromptVersionRow[] })),
      platformApi.settings().catch(() => ({} as Record<string, unknown>)),
    ]);
    setVersions(v.items.filter((x) => x.kind === 'prompt'));
    setToolsEnabled((s['assistant.tools'] as Record<string, boolean> | undefined) ?? {});
    setThinkDefault((s['assistant.thinkDefault'] as string | undefined) ?? 'mid');
    if (projectId) {
      const t = await toolsApi.list(projectId).catch(() => ({ tools: [], denied: [] }));
      setTools(t.tools);
    }
  }, [def.key, projectId]);
  useEffect(() => { void load(); }, [load]);

  const cur = versions.find((v) => v.is_current) ?? null;
  const curText = cur ? effectiveText(cur) : null;
  const nOn = tools.filter((t) => toolsEnabled[t.name] !== false).length;

  const saveSettings = async (patch: Record<string, unknown>, okMsg: string) => {
    try { await platformApi.putSettings(patch); toast(okMsg, 'success'); }
    catch (e) { toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn'); }
  };

  return (
    <>
      <div className="set-card">
        <h3>
          🌐 {def.name} <span className="tag">元 agent 内核 · 第一实例</span>{' '}
          {cur
            ? <span className="tag tag-ok">用户版本 v{cur.version_no} · 可回退基底</span>
            : <span className="tag">代码默认基底</span>}
        </h3>
        <p className="set-note" style={{ marginBottom: 12 }}>
          内核六件（循环执行器 / 工具协议与注册表 / 上下文装配 / 治理钩子 / 模型抽象 / 流式控制）零业务语义；
          本实例 = 基底 Prompt + 工具子集 + 全局 provider 三件配置。
        </p>
        <div className="set-subhead">① 基底 Prompt（代码内置，只读）</div>
        <textarea className="prompt-editor readonly" readOnly value={def.prompt} />
        <div className="set-subhead">
          ② 叠加 Prompt 版本 <span className="sub-note">· 执行时使用「当前生效」版本，会话启动快照落审计</span>
        </div>
        <VersionEditor
          agentKey={def.key} agentGroup={def.group} kind="prompt"
          basePrompt={def.prompt}
          placeholder="在此编写全局助手的叠加 Prompt（另存为新版本）…"
          onChanged={() => { void load(); onChanged(); }}
        />
        <div className="set-subhead">
          ③ 工具开关清单 <span className="sub-note">· 停用后决策插槽不再派发；命中被禁意图时助手如实告知并给重新启用路径，不静默替代</span>
        </div>
        {!projectId && <p className="set-note">进入项目后可查看工具注册表。</p>}
        {tools.map((t) => (
          <div key={t.name} className="model-card">
            <div className="mi">🔧</div>
            <div className="mmain">
              <div className="mname">{t.name} <span className="tag">{t.kind}</span></div>
              <div className="mdesc">{t.description}</div>
            </div>
            <button
              className={`switch${toolsEnabled[t.name] !== false ? ' on' : ''}`}
              title="启用/停用"
              onClick={() => {
                const next = { ...toolsEnabled, [t.name]: toolsEnabled[t.name] === false };
                setToolsEnabled(next);
                void saveSettings({ 'assistant.tools': next },
                  next[t.name] ? `已启用「${t.name}」` : `已停用「${t.name}」（决策插槽不再派发该工具）`);
              }}
            />
          </div>
        ))}
        <div className="set-subhead">
          ④ 默认思考强度 <span className="sub-note">· 新会话初始档；面板内仍可临时切（同模型推理参数，不切模型）</span>
        </div>
        <div className="think-seg">
          {([['low', '低'], ['mid', '中'], ['high', '高']] as const).map(([k, label]) => (
            <button
              key={k} className={thinkDefault === k ? 'active' : ''}
              onClick={() => {
                setThinkDefault(k);
                void saveSettings({ 'assistant.thinkDefault': k }, `已设为新会话默认思考强度：${label}`);
              }}
            >{label}</button>
          ))}
        </div>
      </div>
      <div className="set-card">
        <h3>⑤ 当前上下文叠加提示（只读）</h3>
        <div className="op-result">
          阶段页上下文 → 会话启动时叠加对应阶段主 Agent 的职责块（通用基底 + 阶段主 + doc_kind 命中子 Agent）；
          非阶段页（全局形态）仅使用通用基底 Prompt。
        </div>
      </div>
      <ReflectionSection
        agentKey={def.key} currentText={curText ?? def.prompt}
        onChanged={() => { void load(); onChanged(); }}
      />
      <div className="set-card">
        <h3>⑥ 执行自检</h3>
        <div className="op-result">
          ✅ 当前生效叠加版本：全局 AI 助手 ·「{cur ? `v${cur.version_no} ${cur.name ?? ''}` : '无（仅基底）'}」
          · 工具启用 {nOn}/{tools.length} · 会话启动快照与工具调用（agent.tool）均已写入审计日志
        </div>
      </div>
    </>
  );
}
