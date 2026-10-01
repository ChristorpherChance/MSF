-- W2-002：AI 调用失败可观测性——ai_messages 失败行落脱敏错误信息（前端失败气泡/排查可用）
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS error text;

-- W2-047：builtin 委派目标探测口径与执行环境一致（沙箱镜像内 pi --version）——
-- 未配置 config.image 的 builtin 种子不再是「可用」（原种子 available 与执行力脱节，委派 882ms 即败）
UPDATE ai_delegation_targets SET status='unconfigured', updated_at=now()
WHERE adapter_kind='builtin' AND config->>'image' IS NULL;
