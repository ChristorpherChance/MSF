/**
 * 字符级 diff（补丁「待确认」对比展示专用）：same/del/add 三元段序列。
 * 先剥离公共前后缀，中段做 LCS 动态规划；中段规模超阈值（默认 400 万格）
 * 时降级为整块 del+add（宁可粗粒度也不卡 UI——提案文本可能数千字）。
 */
export type DiffSeg = { type: 'same' | 'del' | 'add'; text: string };

const MAX_CELLS = 4_000_000;

function lcsDiff(a: string, b: string): DiffSeg[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度（Uint32 一维展平，避免二维数组开销）
  const dp = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j]
        ? dp[(i + 1) * W + j + 1]! + 1
        : Math.max(dp[(i + 1) * W + j]!, dp[i * W + j + 1]!);
    }
  }
  const segs: DiffSeg[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      segs.push({ type: 'same', text: a[i++]! });
      j++;
    } else if (dp[(i + 1) * W + j]! >= dp[i * W + j + 1]!) {
      segs.push({ type: 'del', text: a[i++]! });
    } else {
      segs.push({ type: 'add', text: b[j++]! });
    }
  }
  while (i < n) segs.push({ type: 'del', text: a[i++]! });
  while (j < m) segs.push({ type: 'add', text: b[j++]! });
  return merge(segs);
}

function merge(segs: DiffSeg[]): DiffSeg[] {
  const out: DiffSeg[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.type === s.type) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

export function diffText(oldText: string, newText: string): DiffSeg[] {
  if (oldText === newText) return [{ type: 'same', text: oldText }];
  if (!oldText) return [{ type: 'add', text: newText }];
  if (!newText) return [{ type: 'del', text: oldText }];
  // 公共前缀
  let pre = 0;
  const lim = Math.min(oldText.length, newText.length);
  while (pre < lim && oldText[pre] === newText[pre]) pre++;
  // 公共后缀（不与前缀重叠）
  let suf = 0;
  while (suf < lim - pre && oldText[oldText.length - 1 - suf] === newText[newText.length - 1 - suf]) suf++;
  const am = oldText.slice(pre, oldText.length - suf);
  const bm = newText.slice(pre, newText.length - suf);
  const segs: DiffSeg[] = [];
  if (pre > 0) segs.push({ type: 'same', text: oldText.slice(0, pre) });
  if (am && bm) {
    if (am.length * bm.length > MAX_CELLS) {
      // 超长降级：中段整块对比（旧整块红、新整块绿）
      segs.push({ type: 'del', text: am }, { type: 'add', text: bm });
    } else {
      segs.push(...lcsDiff(am, bm));
    }
  } else {
    if (am) segs.push({ type: 'del', text: am });
    if (bm) segs.push({ type: 'add', text: bm });
  }
  if (suf > 0) segs.push({ type: 'same', text: oldText.slice(oldText.length - suf) });
  return merge(segs);
}
