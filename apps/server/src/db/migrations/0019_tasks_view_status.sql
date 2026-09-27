-- U-037：任务中心状态列口径统一——dev 任务状态由看板列主导（queue→queued / ing→run_status / review→review / done→done），
-- 不再把 run_status（manual/running）直接当状态（看板口径 queue/ing/review/done 原本完全丢失）
BEGIN;

CREATE OR REPLACE VIEW sys_tasks_view AS
  SELECT id, project_id, 'dev'::text AS stage, code, title,
         CASE col
           WHEN 'queue' THEN 'queued'
           WHEN 'ing' THEN run_status
           WHEN 'review' THEN 'review'
           WHEN 'done' THEN 'done'
           ELSE run_status
         END AS status,
         owner, created_at, updated_at
  FROM dev_tasks WHERE NOT archived AND NOT excluded
  UNION ALL
  SELECT id, project_id, 'test'::text, code, title, status, coalesce(assignee, created_by) AS owner,
         created_at, updated_at
  FROM tst_defects
  UNION ALL
  SELECT id, project_id, 'dev'::text, code, task_desc AS title, status, target AS owner,
         created_at, finished_at AS updated_at
  FROM ai_delegations;

COMMIT;
