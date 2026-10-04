/**
 * 行级 diff（补丁「待确认」对比展示专用）：same/del/add 三元块序列。
 * 按行切分做 LCS，连续同型行合并成块——每块仍是合法 markdown 片段
 * （表格/列表不拆行），渲染层逐块过 mdHtml：删块红底、增块绿底、同块原样，
 * 既保留 markdown 预览的直观，又一眼看出改了哪几行。
 * 行数超阈值时降级为整块 del+add（宁可粗粒度也不卡 UI）。
 */
export type DiffBlock = { type: 'same' | 'del' | 'add'; text: string };

const MAX_LINES = 2000;

function lcsLines(a: string[], b: string[]): DiffBlock[] {
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j]
        ? dp[(i + 1) * W + j + 1]! + 1
        : Math.max(dp[(i + 1) * W + j]!, dp[i * W + j + 1]!);
    }
  }
  const blocks: DiffBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      blocks.push({ type: 'same', text: a[i++]! });
      j++;
    } else if (dp[(i + 1) * W + j]! >= dp[i * W + j + 1]!) {
      blocks.push({ type: 'del', text: a[i++]! });
    } else {
      blocks.push({ type: 'add', text: b[j++]! });
    }
  }
  while (i < n) blocks.push({ type: 'del', text: a[i++]! });
  while (j < m) blocks.push({ type: 'add', text: b[j++]! });
  return merge(blocks);
}

function merge(blocks: DiffBlock[]): DiffBlock[] {
  const out: DiffBlock[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last && last.type === b.type) last.text += '\n' + b.text;
    else out.push({ ...b });
  }
  return out;
}

export function diffText(oldText: string, newText: string): DiffBlock[] {
  if (oldText === newText) return [{ type: 'same', text: oldText }];
  if (!oldText) return [{ type: 'add', text: newText }];
  if (!newText) return [{ type: 'del', text: oldText }];
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    // 超长降级：整块对比（旧整块红、新整块绿）
    return [{ type: 'del', text: oldText }, { type: 'add', text: newText }];
  }
  return lcsLines(a, b);
}
