-- W4 项目页：项目描述字段（LLD-6 §3.1 项目卡描述行）

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
