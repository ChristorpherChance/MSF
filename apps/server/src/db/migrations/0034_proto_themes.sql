-- 0034：原型主题方案库（2026-10-18，用户拍板「生成页前可选配色/风格：多套默认+可自定义」）
-- proto_themes=全局自定义方案表（内置预设在代码 PROTO_THEME_PRESETS 不入库——代码基线+DB 自定义叠加，
-- 与 doc-templates 同哲学）；dsg_plans.theme_id=plan 选用方案标识
-- （NULL 或 'ai'=AI 按项目定制懒派生，0033 旧行为；builtin:*=内置；uuid=自定义），
-- theme jsonb=解析后令牌覆盖随 plan 冻结（人工应用可覆盖写，AI 懒派生仍首写胜出）。
BEGIN;
CREATE TABLE IF NOT EXISTS proto_themes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  tokens jsonb NOT NULL DEFAULT '{}',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS proto_themes_name_uq ON proto_themes(name);
ALTER TABLE dsg_plans ADD COLUMN IF NOT EXISTS theme_id text;
COMMIT;
