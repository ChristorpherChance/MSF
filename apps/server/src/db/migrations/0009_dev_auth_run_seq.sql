-- 修复：dev_authorizations.authorization_id / dev_runs.run_id 全局 UNIQUE 但按项目 count+1 编号，
-- 多项目并发 autopilot 必然撞号（M5 全量套件并行暴露）。改全局序列发号（差异登记待回补 LLD-4）。

CREATE SEQUENCE IF NOT EXISTS dev_auth_seq;
CREATE SEQUENCE IF NOT EXISTS dev_run_seq;

-- 空表：setval(seq,1,false) → 下一发号 1；非空：setval(seq,max,true) → 下一发号 max+1
SELECT setval('dev_auth_seq',
  COALESCE((SELECT max(substring(authorization_id FROM '^auth_([0-9]+)$')::int) FROM dev_authorizations), 1),
  EXISTS (SELECT 1 FROM dev_authorizations));
SELECT setval('dev_run_seq',
  COALESCE((SELECT max(substring(run_id FROM '^run_([0-9]+)$')::int) FROM dev_runs), 1),
  EXISTS (SELECT 1 FROM dev_runs));
