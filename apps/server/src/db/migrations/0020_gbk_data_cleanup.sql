-- C1/U-001/U-038：历史 GBK 乱码数据清洗（数据修复，不动结构）。
-- 源头为早期经 GBK 控制台 curl 写入的中文（UTF-8 字节被按 GBK 误解码后落库，含 U+FFFD 替换符，不可逆）。
-- 口径：主数据（项目名、委派目标名）可再生的修复；通知/审计等 append-only 历史留痕不改写。
BEGIN;

-- 委派目标内建种子：按 key 恢复到迁移源值（0010_m6_ai.sql 的权威文本）
UPDATE ai_delegation_targets
SET name = 'Pi 原生运行时'
WHERE key = 'pi_native' AND position(U&'\FFFD' in name) > 0;

-- 项目名：原始名称已不可恢复（U+FFFD 替换符丢字节），置可读占位名（带 id 前缀保证唯一可辨）
UPDATE projects
SET name = '历史项目（名称损坏已修复）-' || left(id::text, 8)
WHERE position(U&'\FFFD' in name) > 0;

COMMIT;
