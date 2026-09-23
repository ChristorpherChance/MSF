-- W2 通知中心：跳转定位链（DSG-U06-16 右侧抽屉条目点击跳回来源页）

ALTER TABLE sys_notifications
  ADD COLUMN IF NOT EXISTS link text;              -- 跳转目标路由（/test、/settings 等），可空
