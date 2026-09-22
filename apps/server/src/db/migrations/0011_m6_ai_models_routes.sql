-- M6 修补：ai_models.routes 语义为用途数组（jsonb array），0010 误用对象默认值 '{}'
-- 归一化：默认改 '[]'，存量非数组行归零（差异登记：0010 口径修补）

ALTER TABLE ai_models ALTER COLUMN routes SET DEFAULT '[]';
UPDATE ai_models SET routes = '[]' WHERE jsonb_typeof(routes) IS DISTINCT FROM 'array';
