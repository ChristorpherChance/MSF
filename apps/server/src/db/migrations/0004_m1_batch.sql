-- M1 资料域第三批：mat_batch_jobs / mat_batch_items（LLD-4 DSG-D03-5/6）
-- 作业级五态 idle/confirming/running/done/stopped（F02-4 权威，rejected 已取消：复核不一致整批拒绝不留行）
BEGIN;

CREATE TABLE IF NOT EXISTS mat_batch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('parse','process','content_final')),
  process_type text CHECK (process_type IN ('translate','mask','index')),
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','confirming','running','done','stopped')),
  basis_start jsonb NOT NULL,
  basis_commit jsonb,
  filter jsonb,
  confirm_by text,
  confirm_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  UNIQUE (project_id, code)
);
CREATE INDEX IF NOT EXISTS mat_batch_jobs_project_idx ON mat_batch_jobs (project_id, kind, status);

CREATE TABLE IF NOT EXISTS mat_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES mat_batch_jobs(id),
  file_id uuid NOT NULL REFERENCES mat_files(id),
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','processing','succeeded','failed','skipped')),
  error text,
  retry_of uuid REFERENCES mat_batch_items(id),
  output_parsed_id uuid REFERENCES mat_parsed(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS mat_batch_items_job_idx ON mat_batch_items (job_id, result);
CREATE INDEX IF NOT EXISTS mat_batch_items_file_idx ON mat_batch_items (file_id);

COMMIT;
