-- W1 助手 dock：会话级模型选择（LLD-6 DSG-U02-4 输入区模型切换 #model-sel L1086）
-- 会话可绑定模型；未绑定时发送走 chat 用途路由默认（0011 既有口径）

ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS model_id uuid REFERENCES ai_models(id);
