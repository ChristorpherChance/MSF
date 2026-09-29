-- L2（台账 D3 立项，2026-09-29 用户拍板）：req_pendings 加 reason 列——补丁处置理由落库留痕。
-- 经 13 册变更纪律：LLD-4 DSG-D04-4 同提交更新 + 统稿裁决记录 R-04 登记 + RTM §7 基线重登。
BEGIN;

ALTER TABLE req_pendings ADD COLUMN IF NOT EXISTS reason text;
COMMENT ON COLUMN req_pendings.reason IS '补丁处置理由（接受/拒绝时可选填写）；已裁决补丁在 UI 留痕展示';

COMMIT;
