/** 登录门（部署态简易登录，2026-10-08）：启动探测 /api/auth/whoami —
 *  未启用登录（本地开发）→ 直接放行；启用且未登录 → 全屏登录卡片；登录成功 → 进入工作台。
 *  运行期任何 API 401（cookie 过期）由 api.ts 钩子翻转 needLogin，回到本卡片。 */
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useAuthStore } from './auth-store';

export function AuthGate({ children }: { children: ReactNode }) {
  const { checked, enabled, user, set } = useAuthStore();
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (useAuthStore.getState().checked) return;
    void fetch('/api/auth/whoami')
      .then((r) => r.json() as Promise<{ enabled: boolean; user: string | null }>)
      .then((s) => set(s))
      .catch(() => set({ enabled: false, user: 'local' })); // 探测失败按本地开发放行，不堵开发流
  }, [set]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    void fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ username: name, password: pass }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const b = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(b?.error?.message ?? '登录失败，请稍后重试');
        }
        set({ enabled: true, user: name });
      })
      .catch((e2: Error) => setErr(e2.message))
      .finally(() => setBusy(false));
  };

  if (!checked) return null;
  if (!enabled || user) return <>{children}</>;
  return (
    <div className="auth-gate">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">🏭 MSF 软件工厂</div>
        <label>
          用户名
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {err && <div className="auth-err">{err}</div>}
        <button type="submit" disabled={busy || !name || !pass}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
