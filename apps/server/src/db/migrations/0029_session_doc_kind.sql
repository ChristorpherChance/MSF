-- 0029：AI 会话工件绑定（2026-10-08 用户拍板：「选中某个工件时 AI 对话框也要加载对应会话」——
-- 此前会话只按阶段 ctx 分组，设计阶段内八册共用一个会话池，模型靠猜改文档，实机出现
-- 「选中详细设计却改了概要设计」。doc_kind 记录会话绑定的文档（req: crd|prd；design: 八册 kind；
-- 其余阶段/原型/评审页签为 NULL=阶段级会话）。列表按 (ctx, doc_kind) 精确分组，老数据 NULL
-- 归入阶段级（原型/评审等无工件页签下仍可见可管理）。
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS doc_kind text;
