import { useEffect, useState } from 'react';
import { stdApi, type StdVersion } from './api';
import { useDevStore } from './store';

const STD_AGENT_KEY = 'dev.coding-std';

/** 系统默认编码规范（只读；原型 DEV_STANDARDS 口径，自定义叠加版本在下方维护） */
const DEV_STANDARDS: Array<{ cat: string; rule: string; detail: string }> = [
  { cat: '命名', rule: '标识符语义化', detail: '类型/函数/变量命名表达意图；缩写仅限领域通用词。' },
  { cat: '结构', rule: '模块单向依赖', detail: '跨域不可 import；共享契约经 packages/shared。' },
  { cat: '错误', rule: '错误码闭集', detail: '先注册后使用；不得抛出表外码或裸 Error。' },
  { cat: '审计', rule: '写路径全审计', detail: '所有状态变化经命令总线；审计失败零写。' },
  { cat: '测试', rule: '覆盖率门槛', detail: '行 80% / 分支 70%，核心模块 90% / 80%，CI 强制。' },
  { cat: '安全', rule: '密钥只写不读', detail: '密钥类密文落库、掩码回显，绝不出现在响应与导出包。' },
];

/** 执行工作区 · 编码规范（V8；系统默认只读 + 自定义叠加版本，与设置页 Agent 配置同源 ai_prompt_versions kind='std'） */
export function StdPanel() {
  const s = useDevStore();
  const [versions, setVersions] = useState<StdVersion[]>([]);
  const [overlay, setOverlay] = useState('');
  const [editing, setEditing] = useState(false);
  const current = versions.find((v) => v.is_current) ?? null;

  const load = async () => {
    const r = await stdApi.versions(STD_AGENT_KEY).catch(() => ({ items: [] as StdVersion[] }));
    setVersions(r.items.filter((v) => v.kind === 'std'));
  };
  useEffect(() => { void load(); }, []);

  return (
    <div>
      <div className="doc-toolbar">
        <strong>📏 编码规范</strong>
        <span className="tag">{DEV_STANDARDS.length} 条默认</span>
        {current && <span className="tag tag-ok">叠加 v{current.version_no} 生效中</span>}
        <span className="dsg-prefix">约束所有 🤖 委派产出与 👤 人工提交 · PR checklist 通用项「规范符合」的依据</span>
        <span className="spacer" />
        <button className="act" onClick={() => setEditing(!editing)}>{editing ? '收起' : '✏️ 发布叠加版本'}</button>
      </div>

      {/* 系统默认（只读） */}
      <div className="dsg-card">
        <div className="gen-head"><strong>系统默认规范（只读）</strong></div>
        <table className="dev-table">
          <thead><tr><th style={{ width: 90 }}>类别</th><th>规则</th><th>细则</th></tr></thead>
          <tbody>
            {DEV_STANDARDS.map((r) => (
              <tr key={r.rule}>
                <td><span className="tag">{r.cat}</span></td>
                <td style={{ fontWeight: 600 }}>{r.rule}</td>
                <td className="dsg-prefix">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dsg-prefix" style={{ marginTop: 10 }}>
          系统默认规范只读；自定义叠加版本随 prompt 版本化生效并快照落审计。设置页 Agent 配置区与本源一致（ai_prompt_versions kind=&apos;std&apos;）。
        </p>
      </div>

      {/* 叠加版本发布 */}
      {editing && (
        <div className="dsg-card">
          <div className="gen-head"><strong>发布叠加版本</strong></div>
          <textarea
            rows={4}
            style={{ width: '100%' }}
            placeholder="叠加细则（追加约束，不覆盖默认；例如：React 组件文件 ≤400 行）"
            value={overlay}
            onChange={(e) => setOverlay(e.target.value)}
          />
          <div className="gen-ops" style={{ marginTop: 8 }}>
            <button
              className="act primary"
              disabled={!overlay.trim()}
              onClick={() => s.act(async () => {
                await stdApi.publish({
                  agentKey: STD_AGENT_KEY,
                  agentGroup: 'dev',
                  basePrompt: '编码规范',
                  overlayText: overlay.trim(),
                  kind: 'std',
                });
                setOverlay(''); setEditing(false);
                await load();
              }, '叠加版本已发布并生效')}
            >
              发布
            </button>
          </div>
        </div>
      )}

      {/* 版本列表 */}
      <div className="dsg-card">
        <div className="gen-head"><strong>叠加版本（{versions.length}）</strong></div>
        {versions.length === 0 ? (
          <p className="dsg-prefix">尚无自定义叠加版本</p>
        ) : (
          <table className="dev-table">
            <thead><tr><th>版本</th><th>叠加内容</th><th>状态</th><th>发布人</th><th>时间</th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>v{v.version_no}</td>
                  <td>{v.overlay_text}</td>
                  <td>{v.is_current ? <span className="tag tag-ok">生效中</span> : <span className="tag">历史</span>}</td>
                  <td>{v.created_by}</td>
                  <td className="dsg-prefix">{new Date(v.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
