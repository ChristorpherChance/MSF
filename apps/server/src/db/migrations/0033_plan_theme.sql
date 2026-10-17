-- 0033：原型风格基线按项目定制（2026-10-18，用户拍板「AI 按项目类型定制配色」）
-- dsg_plans.theme jsonb：AI 从项目类型/PRD 提炼的令牌覆盖（{"primary":"#16a34a",...}），
-- 缺省 NULL=代码默认蓝系 PROTO_THEME_TOKENS；首写胜出（theme IS NULL 才更新），随 plan 版本冻结。
BEGIN;
ALTER TABLE dsg_plans ADD COLUMN IF NOT EXISTS theme jsonb;
COMMIT;
