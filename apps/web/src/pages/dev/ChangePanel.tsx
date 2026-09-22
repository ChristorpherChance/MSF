import { useState } from 'react';
import { devApi } from './api';
import { useDevStore } from './store';

/** 页签四：变更管理（REQ-419/420 影响处置 + CI webhook 设置） */
export function ChangePanel() {
  const s = useDevStore();
  const pid = s.projectId!;
  const [note, setNote] = useState('');
  const [secret, setSecret] = useState('');
  const pending = s.impacts.filter((i) => i.status === 'pending-assessment');
  const resolved = s.impacts.filter((i) => i.status !== 'pending-assessment');

  return (
    <div>
      {/* 影响观察与处置 */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>变更影响</strong>
          <span className="dsg-prefix">未决 {pending.length} · 已处置 {resolved.length}</span>
        </div>
        <p className="dsg-prefix">
          设计基线再定稿/失效后点「观察输入变化」：系统比对任务绑定输入与当前基线，生成影响单（同触发幂等）。
        </p>
        <div className="gen-ops">
          <button onClick={() => s.act(async () => {
            const r = await devApi.observe(pid);
            if (!r.impacts.length) useDevStore.setState({ notice: '未发现受影响任务' });
          })}>观察输入变化</button>
          {pending.length > 0 && (
            <button className="act"
              onClick={() => window.confirm(`对全部 ${pending.length} 张未决影响单执行「基线重确认（accept）」？`) &&
                s.act(() => devApi.confirmBaseline(pid, '基线人工重确认'), '基线已重确认')}>
              基线重确认（全部 accept）
            </button>
          )}
        </div>
        <table className="dev-table">
          <thead><tr><th>编号</th><th>触发</th><th>受影响任务</th><th>状态</th><th>处置</th><th>操作</th></tr></thead>
          <tbody>
            {s.impacts.map((im) => (
              <tr key={im.id}>
                <td>{im.code}</td>
                <td className="dsg-prefix">{im.trigger}</td>
                <td>{im.affected_tasks.join('、') || '-'}</td>
                <td>{{ 'pending-assessment': '待评估', rework: '已返工', accepted: '已接受' }[im.status] ?? im.status}</td>
                <td className="dsg-prefix">{im.resolution ?? '-'}{im.note ? `（${im.note}）` : ''}</td>
                <td>
                  {im.status === 'pending-assessment' && (
                    <>
                      <input placeholder="处置说明" value={note} onChange={(e) => setNote(e.target.value)} />
                      <button className="act"
                        onClick={() => window.confirm(`${im.code} 返工：受影响任务修订+1 并回排队、计划失效，确认？`) &&
                          s.act(() => devApi.applyImpact(pid, [im.code], 'rework', note || undefined), `${im.code} 已返工`)}>
                        返工
                      </button>
                      <button className="act"
                        onClick={() => s.act(() => devApi.applyImpact(pid, [im.code], 'accept', note || undefined), `${im.code} 已接受`)}>
                        接受
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {s.impacts.length === 0 && <tr><td colSpan={6} className="dsg-prefix">暂无影响单</td></tr>}
          </tbody>
        </table>
      </div>

      {/* CI webhook 设置（A06-22 只写不读） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>CI 回传设置</strong>
          <span className="dsg-prefix">
            {s.ciSecret?.enabled ? `已启用（${s.ciSecret.secretMasked}）` : '未启用'}
          </span>
        </div>
        <p className="dsg-prefix">
          密钥只写不读（密文落库、掩码回显）；回传端点 POST {`/api/v1/projects/${pid}/dev/ci/callbacks`}，
          头：X-MSF-Timestamp / X-MSF-Signature（HMAC-SHA256，签名串 timestamp.body）/ X-MSF-Delivery（投递幂等）。
        </p>
        <div className="form-row">
          <input
            type="password" placeholder="新密钥（≥32 字符，含字母与数字）"
            value={secret} onChange={(e) => setSecret(e.target.value)}
          />
          <button disabled={secret.length < 32}
            onClick={() => window.confirm('登记/轮换密钥？旧密钥立即失效。') &&
              s.act(async () => { await devApi.setSecret(pid, secret); setSecret(''); }, '密钥已登记')}>
            {s.ciSecret?.enabled ? '轮换密钥' : '登记密钥'}
          </button>
        </div>
      </div>
    </div>
  );
}
