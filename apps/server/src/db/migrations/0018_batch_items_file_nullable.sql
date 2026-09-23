-- 0018：实机走查修复——mat_batch_items.file_id 可空。
-- 删除文件不再被「批量作业留痕」拦截：留痕行保留、file_id 解挂（与 mat_uploads 同口径）。
BEGIN;
ALTER TABLE mat_batch_items ALTER COLUMN file_id DROP NOT NULL;
COMMIT;
