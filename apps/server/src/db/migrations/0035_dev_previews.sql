-- 0035：开发域真化一期+长驻运行预览（2026-10-18，用户拍板「开发测试阶段真走一遍，
-- 代码部署运行在沙箱上，测试与人工检查都能查」）
-- dev_previews=长驻预览登记表（沙箱 runService 容器）：每项目同一时刻至多一个 running 预览；
-- 行不承载会话态事实（容器实时状态以 docker inspect 为准，本表为登记+审计基）。
BEGIN;
CREATE TABLE IF NOT EXISTS dev_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  container_id text NOT NULL,
  container_name text NOT NULL,
  image text NOT NULL,
  port int NOT NULL DEFAULT 3000,
  ip text,                                   -- 启动时解析的容器 IP（桥接网内；重建会变，代理时以 inspect 刷新）
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopped','failed')),
  last_error text,
  started_by text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS dev_previews_running_uq ON dev_previews(project_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS dev_previews_project_idx ON dev_previews(project_id, created_at DESC);
COMMIT;
