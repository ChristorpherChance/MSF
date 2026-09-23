/**
 * M7 性能核查探针（T7-15；REQ-801/802、N01）：
 * ① 链路开销：健康检查/写命令往返（承诺 <500ms，N01-2）
 * ② 首 token 时延：真实模型（网关）chat 会话首帧（云端目标 ≤8s，分档记录实测值）
 * 用法：node scripts/m7-perf-probe.mjs [projectId]
 */
const API = process.env.API ?? 'http://localhost:8080';

const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

async function timeOf(label, fn) {
  const t0 = performance.now();
  const r = await fn();
  const ms = Math.round(performance.now() - t0);
  console.log(`  ${label}: ${ms}ms`);
  return { ms, r };
}

async function main() {
  const list = await (await fetch(`${API}/api/projects`)).json();
  const pid = process.argv[2] ?? list.find((p) => p.status !== 'archived')?.id;
  if (!pid) fail('无可用项目');

  console.log('① 链路开销（目标 <500ms）');
  const results = [];
  for (let i = 0; i < 5; i++) {
    const { ms } = await timeOf(`GET /health #${i + 1}`, async () => (await fetch(`${API}/health`)).json());
    results.push(ms);
  }
  const w = await timeOf('写命令往返（settings.set）', async () => {
    const r = await fetch(`${API}/api/v1/system/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ 'm7.perf.probe': Date.now() }),
    });
    return r.json();
  });
  const readMs = Math.max(...results);
  if (readMs >= 500 || w.ms >= 500) fail(`链路开销超标：读 ${readMs}ms / 写 ${w.ms}ms`);
  ok(`链路开销达标：读峰值 ${readMs}ms，写 ${w.ms}ms（<500ms）`);

  console.log('② 首 token 时延（云端目标 ≤8s）');
  const s = await fetch(`${API}/api/v1/projects/${pid}/ai/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ ctx: 'req', name: 'm7-perf-probe' }),
  });
  if (!s.ok) fail(`创建会话失败 ${s.status}: ${await s.text()}`);
  const { id: sessionId } = await s.json();

  const t0 = performance.now();
  const res = await fetch(`${API}/api/v1/projects/${pid}/ai/sessions/${sessionId}/messages:send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ content: '只回复两个字：收到' }),
  });
  if (!res.ok || !res.body) fail(`messages:send 失败 ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let firstTokenMs = null;
  let frames = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    frames++;
    if (firstTokenMs === null && value.includes('delta')) {
      firstTokenMs = Math.round(performance.now() - t0);
    }
  }
  if (firstTokenMs === null) fail('未收到 delta 帧');
  const grade = firstTokenMs <= 8000 ? '达标（≤8s）' : '超标（>8s）';
  console.log(`  首 token: ${firstTokenMs}ms（${grade}），总帧 ${frames}`);
  if (firstTokenMs > 8000) fail('首 token 超 8s');
  ok('性能核查通过');
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
