-- W4 文件双向同步删除（DSG-U07-2，LLD-6 §3.2 delFile）：
-- mat_files 行物理删除而 mat_parsed 业务态 discarded 保留留痕，
-- 故 mat_parsed.file_id 去除外键约束（列保留作溯源；引用守卫由命令层 material.file.delete 保证）
BEGIN;

ALTER TABLE mat_parsed DROP CONSTRAINT IF EXISTS mat_parsed_file_id_fkey;

COMMIT;
