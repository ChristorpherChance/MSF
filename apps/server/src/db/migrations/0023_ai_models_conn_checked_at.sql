-- W2-004：conn_status 语义=「上次手动测试结果」（非实时探测）——补测试时间戳，前端明示口径
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS conn_checked_at timestamptz;
-- 存量 ok/fail 行以 updated_at 回填（近似值，仅作展示；untested 保持 NULL）
UPDATE ai_models SET conn_checked_at = updated_at WHERE conn_status <> 'untested' AND conn_checked_at IS NULL;
