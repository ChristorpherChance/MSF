-- 需求阶段模式推广（2026-10-06 用户拍板「应用到所有文档修改阶段」）：dsg_pendings 加 reason 列——
-- 设计册补丁处置理由落库留痕，与 req_pendings 同口径（L2 立项精神的设计域同治；
-- 0021 建 req_pendings.reason、0025 两域 seq 同治的先例延续）。
-- 旧行 reason 为 NULL（仅新裁决留痕，不回填历史）。
BEGIN;

ALTER TABLE dsg_pendings ADD COLUMN IF NOT EXISTS reason text;
COMMENT ON COLUMN dsg_pendings.reason IS '补丁处置理由（接受/拒绝/改后接受时可选填写）；已裁决补丁在 UI 留痕展示';

COMMIT;
