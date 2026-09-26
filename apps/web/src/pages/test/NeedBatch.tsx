import { useTstStore } from './store';

/** 无批次空态（原型 pending() 口径：测试对象必须绑定明确构建 + 返回提测与计划） */
export function NeedBatch() {
  const setSubTab = useTstStore((s) => s.setSubTab);
  return (
    <div className="dsg-card qa-empty" style={{ textAlign: 'center', padding: 24 }}>
      <h2>先接收提测批次</h2>
      <p className="dsg-prefix">测试对象必须绑定明确构建，不能对尚未接收的候选产生执行和放行记录。</p>
      <div className="gen-ops" style={{ justifyContent: 'center' }}>
        <button className="act" onClick={() => void setSubTab('plan')}>返回提测与计划</button>
      </div>
    </div>
  );
}
