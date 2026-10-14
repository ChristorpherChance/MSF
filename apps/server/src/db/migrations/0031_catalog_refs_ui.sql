-- 0031：dsg_catalog_refs.ref_kind 增 'ui'（设计↔原型单页结构化对应，设计覆盖检测与可交互原型 §2；
-- 全 spec 唯一 schema 变更）。0006 建表时 ref_kind 为行内无名 CHECK（PG 自动名 dsg_catalog_refs_ref_kind_check），
-- PG 不支持 ALTER CHECK——先 DROP 再 ADD；DROP IF EXISTS 保证迁移幂等两跑安全。
ALTER TABLE dsg_catalog_refs DROP CONSTRAINT IF EXISTS dsg_catalog_refs_ref_kind_check;
ALTER TABLE dsg_catalog_refs ADD CONSTRAINT dsg_catalog_refs_ref_kind_check
  CHECK (ref_kind IN ('hld','lld','prd','src','task','ui'));
