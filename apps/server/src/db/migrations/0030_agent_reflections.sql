-- 0030：Agent 反思迭代（设计 §3）+ 编码规范叠加区键名收编
-- ai_reflections：反思场次留痕（手动/调度触发各一行；取样统计 stats、报告全文 report、
-- 提案清单 proposals 与 ai_prompt_versions 提案版本行关联；model_id 记录实际反思模型）。
CREATE TABLE IF NOT EXISTS ai_reflections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL CHECK (trigger IN ('scheduled','manual')),
  window_start timestamptz NOT NULL, window_end timestamptz NOT NULL,
  stats jsonb NOT NULL DEFAULT '{}',        -- 取样统计（消息数/工具数/采纳率/消耗，按 Agent 分组）
  report text NOT NULL,                     -- 反思报告全文（markdown）
  proposals jsonb NOT NULL DEFAULT '[]',    -- [{agentKey, versionNo, summary, status:'pending'|'adopted'|'rejected'}]
  model_id uuid,                            -- 实际用的反思模型
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 编码规范叠加区键名收编：代码名册 key 为 'dev.coding-std'（点式对齐全域命名），
-- 存量库若曾以 'dev-coding-std' 落库则归一（UPDATE 天然幂等，零行命中即 no-op）。
-- 防撞守卫：目标键同 version_no 行已存在时跳过（UNIQUE(agent_key,version_no) 防 42710 撞号）。
UPDATE ai_prompt_versions SET agent_key='dev.coding-std' WHERE agent_key='dev-coding-std'
  AND NOT EXISTS (SELECT 1 FROM ai_prompt_versions t WHERE t.agent_key='dev.coding-std' AND t.version_no = ai_prompt_versions.version_no);
