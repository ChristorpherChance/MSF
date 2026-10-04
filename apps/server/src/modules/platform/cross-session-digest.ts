/**
 * 跨阶段会话摘要（AI 会话读侧互通）：本项目其它会话的最近用户消息 → prompt 注入块。
 * 纯函数便于单测；SQL 取数与降级策略在 ai/sessions.service.ts buildPrompt。
 */

export interface CrossSessionDigestRow {
  /** ai_sessions.ctx（material/req/design/proto/dev/test） */
  ctx: string;
  /** 会话编号 ss_n */
  code: string;
  /** 已格式化时间（SQL to_char 'YYYY-MM-DD HH24:MI'） */
  at: string;
  /** 该会话最近用户消息摘录（调用方已按时间正序、单条截 200 字） */
  excerpts: string[];
}

const CTX_LABEL: Record<string, string> = {
  material: '资料', req: '需求', design: '设计', proto: '原型', dev: '开发', test: '测试',
};

const HEADER = '【他阶段会话（本项目其它阶段会话的最近用户表态，供理解客户意图；需要细节可用 chat.history.read 深读）】';

/**
 * rows 按 updated_at DESC 传入（首=最新）；整块字符预算 budget，超出从最旧（尾部）会话开始丢弃。
 * 无任何会话装得下 → 返回 ''（调用方省略整块）。
 */
export function buildCrossSessionDigest(rows: CrossSessionDigestRow[], budget = 3000): string {
  const kept = [...rows];
  const render = (): string => {
    const blocks = kept
      .filter((r) => r.excerpts.length > 0)
      .map((r) => {
        const head = `[${CTX_LABEL[r.ctx] ?? r.ctx}] ${r.code}（${r.at}）`;
        return [head, ...r.excerpts.map((x) => `- ${x}`)].join('\n');
      });
    if (blocks.length === 0) return '';
    return `${HEADER}\n${blocks.join('\n')}`;
  };
  let out = render();
  while (out.length > budget && kept.length > 0) {
    kept.pop();
    out = render();
  }
  return out;
}
