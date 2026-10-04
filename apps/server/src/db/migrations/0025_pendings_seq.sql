-- T16 实机抓修：req_pendings/dsg_pendings 加 seq 列——同批补丁提案的批内顺序键。
-- 根因：doc.propose-pending 单事务逐条 INSERT，created_at DEFAULT now() 取事务开始时间 → 整批同值，
-- ORDER BY created_at 同值不稳定 → listPatches 乱序 → 链式 after 锚点在「锚点节尚未接受」时落空乱结构。
-- 建表出处：req_pendings 见 0005_m2_requirements.sql，dsg_pendings 见 0006_m3_design.sql。
-- 旧行 seq 为 NULL：ORDER BY created_at, seq 下 pg ASC 默认 NULLS LAST，同 created_at 组内排在带 seq 新行之后（不改旧数据）。
BEGIN;

ALTER TABLE req_pendings ADD COLUMN IF NOT EXISTS seq int;
COMMENT ON COLUMN req_pendings.seq IS '同批 doc.propose-pending 提案的批内序号（0 起）；created_at 事务同值时的次序键';
ALTER TABLE dsg_pendings ADD COLUMN IF NOT EXISTS seq int;
COMMENT ON COLUMN dsg_pendings.seq IS '同批 design.doc.propose-pending 提案的批内序号（0 起）；created_at 事务同值时的次序键';

COMMIT;
