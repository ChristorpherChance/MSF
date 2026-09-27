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
  toolsApi,
  type PromptVersionRow,
} from './api';
import { AuditGroup, BackupGroup, ModelsGroup, PolicyGroup, SystemGroup } from './SettingsGroups';
import './settings.css';

/** 子 Agent 名册（原型 S.agents 口径；系统默认 Prompt 为内置基底文案，只读展示） */
const AGENTS: Array<{ key: string; group: string; name: string; sysPrompt: string }> = [
  { key: 'ag-file', group: '资料 Agent', name: '文件解析子 Agent', sysPrompt: '你是文件解析 Agent。职责：将上传的 pdf/docx/xlsx/图片等解析为结构化 Markdown，保留表格与层级；不得臆造原文不存在的内容；解析完成后输出质量自检清单。' },
  { key: 'ag-content', group: '资料 Agent', name: '内容解析子 Agent', sysPrompt: '你是内容解析 Agent。职责：在文件解析定稿基础上执行用户选择的操作（翻译/索引/脱敏/术语查询），生成结果或附件；修改必须基于定位补丁，禁止重写全文。' },
  { key: 'ag-crd', group: '需求 Agent', name: '客户需求 CRD 子 Agent', sysPrompt: '你是 CRD Agent。职责：从参考资料提炼客户需求，先出目录大纲再逐章生成；每条 CR 必须标注来源 R-*；修改只输出 edit_patch 补丁，禁止重写全文。' },
  { key: 'ag-prd', group: '需求 Agent', name: '产品需求 PRD 子 Agent', sysPrompt: '你是 PRD Agent。职责：以 CRD 定稿为唯一默认依据生成产品需求；每条 REQ 必须 refines 到 CR-*；输出验收标准。' },
  { key: 'ag-rtm', group: '需求 Agent', name: '需求矩阵 RTM 子 Agent', sysPrompt: '你是 RTM Agent。职责：维护 R←CR←REQ refines 图；定稿时校验 L0a≥0.95 / L0b=1.00；未覆盖项必须显式 deferred/dropped。' },
  { key: 'ag-dev', group: '开发 Agent', name: '开发编排子 Agent', sysPrompt: '你是开发编排 Agent。职责：依概要/详细/原型定稿拆解 T-* 任务卡（REQ 锚点 + 设计锚点 + 验收标准 + DoD），按 capability 路由派单并汇总 delegate 心跳；拆解产出完备性报告交人批准；产出物一律走 PR 回流人审。' },
];
const GLOBAL_KEY = 'assistant'; // 全局 AI 助手（元 agent 内核第一实例）
const GLOBAL_BASE = '你是软件工厂的全局 AI 助手（元 agent 内核第一实例）。内核六件（循环执行器/工具协议与注册表/上下文装配/治理钩子/模型抽象/流式控制）零业务语义；你只携带通用基底 + 工具子集 + 全局 provider 三件配置。';

type NavKey = 'agents' | 'models' | 'policy' | 'audit' | 'backup' | 'system';
const NAV: Array<[NavKey, string]> = [
  ['agents', '🤖 Agent 配置'],
  ['models', '🧩 模型配置'],
  ['policy', '🛂 放行策略'],
  ['audit', '🧾 审计'],
  ['backup', '💾 备份'],
  ['system', '⚙️ 系统设置'],
];

/**
 * 设置页（LLD-6 §3.9 DSG-U03-9；C1-C8）：
 * 左 .set-nav 六组 + 右 .set-body；Agent 配置含全局助手与各子 Agent 版本化 Prompt。
 */
export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const navParam = params.get('nav') as NavKey | null;
  const [nav, setNav] = useState<NavKey>(NAV.some(([k]) => k === navParam) ? navParam! : 'agents');
  const [selAgent, setSelAgent] = useState<string>(AGENTS[0]!.key);

  const pick = (k: NavKey) => { setNav(k); setParams({ nav: k }, { replace: true }); };

  return (
    <div className="full-wrap">
      <div className="full-inner">
        <h2>设置</h2>
        <p className="set-note" style={{ marginTop: -6 }}>
          Agent Prompt 版本化管理 · 多模型接入（pi-ai） · 系统策略
        </p>
        <div className="set-layout">
          <div className="set-nav">
            {NAV.map(([k, label]) => (
              <div key={k}>
                <div className={`sn-item${nav === k ? ' active' : ''}`} onClick={() => pick(k)}>{label}</div>
                {k === 'agents' && nav === 'agents' && (
                  <div>
                    <div
                      className={`sn-item sub${selAgent === GLOBAL_KEY ? ' active' : ''}`}
                      onClick={() => setSelAgent(GLOBAL_KEY)}
                    >🌐 全局 AI 助手</div>
                    {AGENTS.map((a) => (
                      <div
                        key={a.key}
                        className={`sn-item sub${selAgent === a.key ? ' active' : ''}`}
                        onClick={() => setSelAgent(a.key)}
                      >{a.name}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="set-body">
            {nav === 'agents' && (selAgent === GLOBAL_KEY ? <GlobalAssistantCard /> : <AgentCard key={selAgent} agentKey={selAgent} />)}
            {nav === 'models' && <ModelsGroup />}
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
          {props.kind === 'std' ? '暂无叠加版本，当前仅使用系统默认规范' : '暂无自定义版本，当前直接使用系统默认 Prompt'}
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
          <span className="pver-text" title={v.overlay_text}>{v.overlay_text}</span>
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

/** C2 子 Agent 卡：系统默认只读开关 + 版本列表 + 新版本编辑区 +（ag-dev）编码规范叠加区 + 执行自检 */
function AgentCard({ agentKey }: { agentKey: string }) {
  const meta = AGENTS.find((a) => a.key === agentKey)!;
  const [showDefault, setShowDefault] = useState(false);
  const [current, setCurrent] = useState<PromptVersionRow | null>(null);

  const loadCurrent = useCallback(async () => {
    const r = await promptsApi.agents().catch(() => ({ items: [] as PromptVersionRow[] }));
    setCurrent(r.items.find((x) => x.agent_key === agentKey && x.kind === 'prompt') ?? null);
  }, [agentKey]);
  useEffect(() => { void loadCurrent(); }, [loadCurrent]);

  const basePrompt = current?.base_prompt || meta.sysPrompt;

  return (
    <>
      <div className="set-card">
        <h3>{meta.group} · {meta.name}</h3>
        <label className="checkline" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={showDefault} onChange={(e) => setShowDefault(e.target.checked)} />
          查看系统默认 Prompt（只读，不可修改）
        </label>
        {showDefault && (
          <>
            <textarea className="prompt-editor readonly" readOnly value={basePrompt} />
            <p className="set-note" style={{ marginTop: 6 }}>
              系统默认 Prompt 始终作为基底注入；下方自定义版本叠加在其上。
            </p>
          </>
        )}
        <VersionEditor
          agentKey={agentKey} agentGroup={meta.group} kind="prompt"
          basePrompt={basePrompt}
          placeholder="在此编写新的 Prompt 叠加内容，另存为新版本…"
          onChanged={() => void loadCurrent()}
        />
      </div>
      {agentKey === 'ag-dev' && <StdOverlayCard basePrompt={basePrompt} />}
      <div className="set-card">
        <h3>执行自检</h3>
        <div className="op-result">
          ✅ 当前生效版本：{meta.name} ·「{current ? `v${current.version_no} ${current.name ?? ''}` : '系统默认'}」
          · 会话启动时快照生效版本并写入审计日志（修复“配置了但没真执行”缺陷）
        </div>
      </div>
    </>
  );
}

/** 开发 Agent 专属「编码规范」叠加区（v1.6；与开发页 📏 编码规范同源 ai_prompt_versions kind='std'） */
function StdOverlayCard({ basePrompt }: { basePrompt: string }) {
  const [tick, setTick] = useState(0);
  return (
    <div className="set-card">
      <h3>📏 编码规范 <span className="tag">开发 Agent 叠加区</span></h3>
      <p className="set-note" style={{ marginBottom: 10 }}>
        开发阶段「📏 编码规范」页的编辑落点：系统默认规范只读不可改；自定义叠加版本注入全部 🤖 委派与 PR
        checklist「编码规范符合」判定，会话启动时快照并落审计。
      </p>
      <div className="set-subhead">系统默认（只读）</div>
      <div className="op-result" style={{ lineHeight: 1.9 }}>
        · <b>命名</b>：标识符语义化——缩写仅限领域通用词<br />
        · <b>结构</b>：模块单向依赖——跨域不可 import；共享契约经 packages/shared<br />
        · <b>错误</b>：错误码闭集——先注册后使用；不得抛出表外码或裸 Error<br />
        · <b>审计</b>：写路径全审计——所有状态变化经命令总线；审计失败零写<br />
        · <b>测试</b>：覆盖率门槛——行 80% / 分支 70%，核心模块 90% / 80%，CI 强制<br />
        · <b>安全</b>：密钥只写不读——密文落库、掩码回显，绝不出现在响应与导出包
      </div>
      <VersionEditor
        key={tick}
        agentKey="dev-coding-std" agentGroup="dev" kind="std"
        basePrompt={basePrompt}
        placeholder="在此编写编码规范叠加内容（如：门户语境附加约束），另存为新版本…"
        onChanged={() => setTick((x) => x + 1)}
      />
    </div>
  );
}

/** C3 全局 AI 助手卡：基底/叠加版本/工具开关/默认思考强度/上下文叠加提示/执行自检 */
function GlobalAssistantCard() {
  const projectId = useSession((s) => s.projectId);
  const [versions, setVersions] = useState<PromptVersionRow[]>([]);
  const [tools, setTools] = useState<Array<{ name: string; kind: string; description: string }>>([]);
  const [toolsEnabled, setToolsEnabled] = useState<Record<string, boolean>>({});
  const [thinkDefault, setThinkDefault] = useState<string>('mid');

  const load = useCallback(async () => {
    const [v, s] = await Promise.all([
      promptsApi.versions(GLOBAL_KEY).catch(() => ({ items: [] as PromptVersionRow[] })),
      platformApi.settings().catch(() => ({} as Record<string, unknown>)),
    ]);
    setVersions(v.items.filter((x) => x.kind === 'prompt'));
    setToolsEnabled((s['assistant.tools'] as Record<string, boolean> | undefined) ?? {});
    setThinkDefault((s['assistant.thinkDefault'] as string | undefined) ?? 'mid');
    if (projectId) {
      const t = await toolsApi.list(projectId).catch(() => ({ tools: [], denied: [] }));
      setTools(t.tools);
    }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const cur = versions.find((v) => v.is_current) ?? null;
  const basePrompt = cur?.base_prompt || GLOBAL_BASE;
  const nOn = tools.filter((t) => toolsEnabled[t.name] !== false).length;

  const saveSettings = async (patch: Record<string, unknown>, okMsg: string) => {
    try { await platformApi.putSettings(patch); toast(okMsg, 'success'); }
    catch (e) { toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn'); }
  };

  return (
    <>
      <div className="set-card">
        <h3>🌐 全局 AI 助手 <span className="tag">元 agent 内核 · 第一实例</span></h3>
        <p className="set-note" style={{ marginBottom: 12 }}>
          内核六件（循环执行器 / 工具协议与注册表 / 上下文装配 / 治理钩子 / 模型抽象 / 流式控制）零业务语义；
          本实例 = 基底 Prompt + 工具子集 + 全局 provider 三件配置。
        </p>
        <div className="set-subhead">① 基底 Prompt（系统内置，只读）</div>
        <textarea className="prompt-editor readonly" readOnly value={basePrompt} />
        <div className="set-subhead">
          ② 叠加 Prompt 版本 <span className="sub-note">· 执行时使用「当前生效」版本，会话启动快照落审计</span>
        </div>
        <VersionEditor
          agentKey={GLOBAL_KEY} agentGroup="assistant" kind="prompt"
          basePrompt={basePrompt}
          placeholder="在此编写全局助手的叠加 Prompt（另存为新版本）…"
          onChanged={() => void load()}
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
          阶段页上下文 → 会话启动时叠加对应阶段子 Agent 的 prompt（通用基底 + 阶段子 Agent 叠加）；
          非阶段页（全局形态）仅使用通用基底 Prompt。<br />
          <span className="set-note">实例化路由为后续版本：叠加关系先在 UI 上可见可理解，真实叠加路由随阶段子 Agent 实例化一并落地。</span>
        </div>
      </div>
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
