const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { launch } = require('./browser.cjs');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, 'evidence');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'design-catalog.json'), 'utf8'));
const artifactInput = (process.env.V19_CUSTOMER_ARTIFACT_HTML || '').trim();
const evidencePrefix = artifactInput ? 'build' : 'customer';
let html, inputSha256;
if (artifactInput) {
  assert.equal(path.isAbsolute(artifactInput), true, 'V19_CUSTOMER_ARTIFACT_HTML 必须是绝对路径');
  assert.equal(fs.existsSync(artifactInput), true, `待验 HTML 不存在: ${artifactInput}`);
  html = fs.readFileSync(artifactInput, 'utf8');
  inputSha256 = crypto.createHash('sha256').update(html).digest('hex');
} else {
  const source = fs.readFileSync(path.join(root, 'prototype-template.js'), 'utf8');
  inputSha256 = crypto.createHash('sha256').update(source).digest('hex');
  assert.ok(!source.includes('</script>'), '模板源码不能含未转义的 script 结束标签');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'prototype-template.js' });
  assert.equal(typeof sandbox.v19CustomerPrototypeHTML, 'function');
  html = sandbox.v19CustomerPrototypeHTML(catalog);
}
assert.ok(html.includes('</script>'));

const contracts = Object.fromEntries(catalog.pages.map(p => [p.id,
  Object.fromEntries(p.controls.map(c => [c.id, { type: c.type, action: c.action, target: c.targetPageId || null }]))
]));

async function inspectRawHTML(page) {
  return page.evaluate(raw => {
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const pages = [...doc.querySelectorAll('#app > [data-prototype-page]')];
    return {
      appCount: doc.querySelectorAll('#app').length,
      forbiddenSource: Boolean(doc.querySelector('#prototype-source')),
      untracedRoutes: doc.querySelectorAll('[data-route]:not([data-prototype-control])').length,
      pages: pages.map(p => ({
        id: p.dataset.prototypePage,
        states: [...p.querySelectorAll(':scope > [data-prototype-state]')].map(s => ({
          id: s.dataset.prototypeState,
          textLength: s.textContent.replace(/\s+/g, ' ').trim().length,
          headings: s.querySelectorAll('h1,h2').length,
          businessRegions: s.querySelectorAll('[data-business-content]').length
        })),
        controls: [...p.querySelectorAll('[data-prototype-control]')].map(n => ({
          id: n.dataset.prototypeControl, type: n.dataset.prototypeType || null,
          action: n.dataset.prototypeAction || null, target: n.dataset.prototypeTarget || null,
          tag: n.tagName.toLowerCase(), inputType: n.getAttribute('type'),
          label: (n.getAttribute('aria-label') || n.textContent || '').trim()
        })),
        fields: [...p.querySelectorAll('[data-prototype-field]')].map(n => ({
          id: n.dataset.prototypeField, type: n.getAttribute('type') || n.tagName.toLowerCase(),
          required: n.required, pattern: n.getAttribute('pattern'), minLength: n.minLength,
          maxLength: n.maxLength, accept: n.getAttribute('accept'), maxSizeMb: n.dataset.maxSizeMb || null
        }))
      }))
    };
  }, html);
}

function assertRawContract(raw) {
  assert.equal(raw.appCount, 1, '原始 HTML 只有一个应用根节点');
  assert.equal(raw.forbiddenSource, false, '不存在检查专用隐藏树');
  assert.equal(raw.untracedRoutes, 0, '不存在目录外 data-route 业务动作');
  assert.equal(raw.pages.length, 16, '原始 HTML 包含 16 个真实页面');
  assert.deepEqual(raw.pages.map(p => p.id), catalog.pages.map(p => p.id));
  assert.equal(raw.pages.reduce((n, p) => n + p.states.length, 0), 58, '原始 HTML 包含 58 个真实状态');
  for (const spec of catalog.pages) {
    const actual = raw.pages.find(p => p.id === spec.id);
    assert.deepEqual(actual.states.map(s => s.id), spec.states.map(s => s.id), `${spec.id} 状态精确`);
    for (const state of actual.states) {
      assert.ok(state.textLength >= 45, `${spec.id}:${state.id} 有真实业务文案`);
      assert.ok(state.headings >= 1, `${spec.id}:${state.id} 有标题`);
      assert.equal(state.businessRegions, 1, `${spec.id}:${state.id} 由业务 renderer 生成`);
    }
    const seenControls = new Map();
    for (const control of actual.controls) {
      assert.ok(contracts[spec.id][control.id], `${spec.id} 不含目录外控件 ${control.id}`);
      assert.ok(control.label, `${spec.id}:${control.id} 有可见标签或 aria-label`);
      const expected = contracts[spec.id][control.id];
      assert.deepEqual({ type: control.type, action: control.action, target: control.target }, expected, `${spec.id}:${control.id} 契约精确`);
      if (['link', 'content-link', 'primary-link', 'audit-link'].includes(control.type)) assert.equal(control.tag, 'a', `${spec.id}:${control.id} 使用真实链接`);
      if (control.type === 'search-input') assert.deepEqual([control.tag, control.inputType], ['input', 'search'], `${spec.id}:${control.id} 使用真实检索输入`);
      if (control.type === 'file-upload') assert.deepEqual([control.tag, control.inputType], ['input', 'file'], `${spec.id}:${control.id} 使用真实文件输入`);
      if (control.type === 'tel-input') assert.deepEqual([control.tag, control.inputType], ['input', 'tel'], `${spec.id}:${control.id} 使用真实电话输入`);
      if (control.type === 'otp-input') assert.deepEqual([control.tag, control.inputType], ['input', 'text'], `${spec.id}:${control.id} 使用真实 OTP 输入`);
      seenControls.set(control.id, control);
    }
    assert.deepEqual([...seenControls.keys()].sort(), Object.keys(contracts[spec.id]).sort(), `${spec.id} 控件集合精确`);
    const expectedFields = Object.fromEntries((spec.fields || []).map(f => [f.id, f]));
    const seenFields = new Map();
    for (const field of actual.fields) {
      assert.ok(expectedFields[field.id], `${spec.id} 不含目录外字段 ${field.id}`);
      const expected = expectedFields[field.id];
      assert.deepEqual({
        type: field.type, required: field.required, pattern: field.pattern,
        minLength: field.minLength, maxLength: field.maxLength,
        accept: field.accept, maxSizeMb: field.maxSizeMb
      }, {
        type: expected.type, required: Boolean(expected.required), pattern: expected.pattern || null,
        minLength: Number.isInteger(expected.minLength) ? expected.minLength : -1,
        maxLength: Number.isInteger(expected.maxLength) ? expected.maxLength : -1,
        accept: expected.accept ? expected.accept.join(',') : null,
        maxSizeMb: Number.isFinite(expected.maxSizeMb) ? String(expected.maxSizeMb) : null
      }, `${spec.id}:${field.id} 字段约束逐项来自目录`);
      seenFields.set(field.id, field);
    }
    assert.deepEqual([...seenFields.keys()].sort(), Object.keys(expectedFields).sort(), `${spec.id} 字段集合精确`);
  }
  assert.equal(raw.pages.flatMap(page => page.controls).length >= 106, true, '原始真实状态覆盖全部目录控件实例');
}

async function select(page, pageId, stateId) {
  assert.equal(await page.evaluate(([p, s]) => window.prototypeNavigate(p, s), [pageId, stateId]), true);
  const active = page.locator(`#app > [data-prototype-page="${pageId}"] > [data-prototype-state="${stateId}"]`);
  await active.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#app > [data-prototype-page]:visible').count(), 1);
  assert.equal(await page.locator('#app > [data-prototype-page]:visible > [data-prototype-state]:visible').count(), 1);
  return active;
}

async function activeMeta(page) {
  return page.evaluate(() => {
    const pageNode = document.querySelector('#app > [data-prototype-page]:not([hidden])');
    const stateNode = pageNode.querySelector(':scope > [data-prototype-state]:not([hidden])');
    return {
      page: pageNode.dataset.prototypePage, state: stateNode.dataset.prototypeState,
      role: stateNode.querySelector('.cms-head .role-chip')?.textContent.trim() || null,
      workflow: stateNode.dataset.workflow || null, hash: location.hash,
      storageState: stateNode.dataset.storageState || null,
      workflowView: stateNode.dataset.workflowView || null,
      allowedActions: stateNode.dataset.allowedActions || null,
      lastTransition: stateNode.dataset.lastTransition ? JSON.parse(stateNode.dataset.lastTransition) : null
    };
  });
}

function assertTransition(record, action, actorRole) {
  assert.deepEqual(Object.keys(record).sort(), ['action', 'actorRole', 'at']);
  assert.deepEqual([record.action, record.actorRole], [action, actorRole]);
  assert.equal(typeof record.at, 'string');
  assert.ok(record.at.length > 0, '结构化 transition 含非空事件时间');
}

async function reset(page) {
  await page.goto('about:blank#/fr/pub/home');
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
}

async function signInCms(page, role) {
  await select(page, 'P-CMS-LOGIN', 'signed-out');
  await page.locator(`[data-prototype-state]:visible [data-prototype-control="sign-in"][data-role="${role}"]`).click();
  return activeMeta(page);
}

async function citizenLogin(page) {
  let active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="phone"]').fill('69912345');
  await active.locator('[data-prototype-control="submit"]').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="otp"]').fill('123456');
  await active.locator('[data-prototype-control="submit"]').click();
}

async function runFlows(page) {
  const completed = [];

  // F-001/F-002：语言、栏目上下文、详情 fallback 与归档保护。
  await reset(page);
  let active = await select(page, 'P-PUB-HOME', 'ready');
  await active.locator('[data-prototype-control="language"][data-language="en"]').click();
  assert.match((await activeMeta(page)).hash, /^#\/en\//, 'F-001 语言切换更新可分享路径');
  await active.locator('[data-prototype-control="nav-section"]:visible').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="pagination"][data-page-direction="next"]').click();
  assert.equal(await active.getAttribute('data-page-number'), '2', 'F-001 翻页状态可观察');
  assert.match((await activeMeta(page)).hash, /page=2&type=news/, 'F-001 翻页保留类型与语言上下文');
  await active.locator('[data-prototype-control="content-card"]').click();
  assert.deepEqual((await activeMeta(page)).page, 'P-PUB-CONTENT');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  active = await select(page, 'P-PUB-CONTENT', 'fallback');
  assert.match(await active.innerText(), /fallback|French original|FR original/i);
  completed.push('F-001');
  active = await select(page, 'P-PUB-CONTENT', 'gone');
  assert.doesNotMatch(await active.innerText(), /Les administrations renforcent/);
  active = await select(page, 'P-PUB-ARCHIVE', 'gone');
  await active.locator('[data-prototype-control="return-section"]').click();
  assert.equal((await activeMeta(page)).page, 'P-PUB-SECTION');
  completed.push('F-002');

  // F-003/F-004：returnTo、附件负向/正向、幂等回执与状态查询。
  await reset(page);
  active = await select(page, 'P-PUB-SERVICE-GUIDE', 'available');
  await active.locator('[data-prototype-control="start"]').click();
  assert.equal((await activeMeta(page)).page, 'P-PUB-ACCOUNT');
  await citizenLogin(page);
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state, await page.evaluate(() => document.documentElement.lang) ], ['P-PUB-SERVICE-GUIDE', 'available', 'fr']);
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="start"]').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="upload"]').setInputFiles({ name: 'identity.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 valid') });
  await active.locator('[data-prototype-control="next"]').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  assert.equal((await activeMeta(page)).state, 'details');
  await active.locator('[data-prototype-control="submit"]').dblclick();
  await page.locator('[data-prototype-page="P-PUB-RECEIPT"] > [data-prototype-state="accepted"]').waitFor({ state: 'visible' });
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  assert.equal(await active.locator('.receipt-number').count(), 1, 'F-003 双击只生成一个回执');
  assert.equal(await active.getAttribute('data-operation-key'), 'CMR-IDEMP-2026-001');
  await active.locator('[data-prototype-control="copy"]').click();
  assert.match(await active.locator('.inline-status').innerText(), /CMR-2026-0917-042/);
  await active.locator('[data-prototype-control="track"]').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="refresh"]').click();
  assert.match(await active.locator('.inline-status').innerText(), /CMR-2026-0917-042/);
  await reset(page);
  active = await select(page, 'P-PUB-APPLICATION-STATUS', 'unauthorized');
  await active.locator('[data-prototype-control="login"]').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="phone"]').fill('69912345');
  await active.locator('[data-prototype-control="phone"]').press('Enter');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="otp"]').fill('123456');
  await active.locator('[data-prototype-control="otp"]').press('Enter');
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-PUB-APPLICATION-STATUS', 'unauthorized'], 'F-004 状态页重新登录安全返回');
  completed.push('F-003', 'F-004');

  for (const bad of [
    { name: 'evil.txt', mimeType: 'text/plain', buffer: Buffer.from('bad'), expected: /PDF|JPG|format/i },
    { name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(5 * 1024 * 1024 + 1), expected: /5 MB|volumineux/i }
  ]) {
    active = await select(page, 'P-PUB-APPLICATION', 'materials');
    await active.locator('[data-prototype-control="upload"]').setInputFiles(bad);
    await active.locator('[data-prototype-control="next"]').click();
    assert.equal((await activeMeta(page)).state, 'materials');
    assert.match(await active.locator('[role="alert"]').innerText(), bad.expected);
  }
  active = await select(page, 'P-PUB-APPLICATION', 'materials');
  await active.locator('[data-prototype-control="upload"]').setInputFiles([]);
  await active.locator('[data-prototype-control="next"]').click();
  assert.match(await active.locator('[role="alert"]').innerText(), /identité|required|requis/i);
  active = await select(page, 'P-PUB-APPLICATION', 'materials');
  await active.locator('[data-prototype-control="upload"]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff]) });
  await active.locator('[data-prototype-control="next"]').click();
  assert.equal((await activeMeta(page)).state, 'details', 'F-003 JPEG 合法路径');
  active = await select(page, 'P-PUB-APPLICATION', 'upstream-pending');
  await active.locator('[data-prototype-control="submit"]').click();
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-PUB-RECEIPT', 'pending']);

  // F-005：首页检索到结果详情并保留语言。
  await reset(page);
  active = await select(page, 'P-PUB-HOME', 'ready');
  await active.locator('[data-prototype-control="language"][data-language="en"]').click();
  await active.locator('[data-prototype-control="search"]').fill('administration');
  await active.locator('[data-prototype-control="search"]').press('Enter');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-PUB-SEARCH', 'results']);
  await active.locator('[data-prototype-control="result"]').click();
  assert.equal((await activeMeta(page)).page, 'P-PUB-CONTENT');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  completed.push('F-005');

  // F-006：Open Data returnTo、当前状态输入隔离、401/429 单一反馈。
  await reset(page);
  active = await select(page, 'P-PUB-OPENDATA', 'key-needed');
  await active.locator('[data-prototype-control="get-key"]').click();
  await citizenLogin(page);
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-PUB-OPENDATA', 'catalog']);
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-field="apiKey"]').fill('cm_live_valid');
  await active.locator('[data-prototype-control="download"]').click();
  assert.match(await active.locator('.inline-status').innerText(), /préparé|prepared/i);
  for (const [state, expected, forbidden] of [['unauthorized', /401/, /requise|required/i], ['rate-limited', /429/, /requise|required/i]]) {
    active = await select(page, 'P-PUB-OPENDATA', state);
    await active.locator('[data-prototype-field="apiKey"]').fill('cm_live_current_state');
    await active.locator('[data-prototype-control="download"]').click();
    const text = await active.locator('.inline-status').innerText(); assert.match(text, expected); assert.doesNotMatch(text, forbidden);
  }
  completed.push('F-006');

  // F-007/F-008/F-009：先验证匿名拒绝，再以同一份内容事实连续执行提审、审核、发布、下线与归档。
  await reset(page);
  active = await select(page, 'P-CMS-LOGIN', 'signed-out');
  for (const id of ['nav-dashboard', 'nav-editor', 'nav-review', 'nav-publish']) {
    await active.locator(`[data-prototype-control="${id}"]`).click();
    assert.equal((await activeMeta(page)).state, 'signed-out', `未登录 ${id} 返回登录页`);
    active = await select(page, 'P-CMS-LOGIN', 'signed-out');
  }
  await reset(page);
  let meta = await signInCms(page, 'editor');
  assert.equal(meta.role, 'Editor');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  assert.equal(await active.locator('[data-prototype-control="nav-review"]:visible,[data-prototype-control="nav-publish"]:visible').count(), 0, 'Editor 只见编辑导航');
  await active.locator('[data-prototype-control="new-content"]:visible').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  const blocksBefore = await active.locator('.content-block').count();
  await active.locator('[data-prototype-control="block-add"]').click();
  assert.equal(await active.locator('.content-block').count(), blocksBefore + 1);
  await active.locator('[data-prototype-control="save"]').click();
  assert.equal(await active.getAttribute('data-revision'), '19');
  await active.locator('[data-prototype-control="submit-review"]').click();
  meta = await activeMeta(page);
  assert.deepEqual([meta.page, meta.state, meta.role, meta.storageState, meta.workflowView], ['P-CMS-EDITOR', 'submitted', 'Editor', 'review', 'submitted']);
  completed.push('F-007');

  // F-008：审核决定只改 workflow，不提升 actor；未登录和错角色统一拒绝。
  active = await select(page, 'P-CMS-LOGIN', 'signed-out');
  meta = await signInCms(page, 'reviewer');
  assert.equal(meta.role, 'Reviewer');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  assert.equal(await active.locator('[data-prototype-control="new-content"]:visible').count(), 0);
  assert.equal(await active.locator('[data-prototype-control="nav-editor"]:visible,[data-prototype-control="nav-publish"]:visible').count(), 0, 'Reviewer 只见审核导航');
  await active.locator('[data-prototype-control="review-queue"]:visible').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="approve"]').click();
  meta = await activeMeta(page);
  assert.deepEqual([meta.page, meta.state, meta.role, meta.storageState, meta.workflowView], ['P-CMS-REVIEW', 'approved', 'Reviewer', 'review', 'pending-publish']);
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  assert.equal(await active.locator('[data-prototype-control="publish"]:visible').count(), 0);
  assert.equal(await active.locator('[data-prototype-control="nav-publish"]:visible').count(), 0, 'Reviewer 审核通过后仍无发布入口');
  assert.notEqual((await activeMeta(page)).page, 'P-CMS-PUBLISH');
  completed.push('F-008');

  // F-009：Publisher 独立登录后发布、审计、下线和归档。
  active = await select(page, 'P-CMS-LOGIN', 'signed-out');
  meta = await signInCms(page, 'publisher');
  assert.equal(meta.role, 'Publisher');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  assert.equal(await active.locator('[data-prototype-control="new-content"]:visible,[data-prototype-control="review-queue"]:visible').count(), 0);
  assert.equal(await active.locator('[data-prototype-control="nav-editor"]:visible,[data-prototype-control="nav-review"]:visible').count(), 0, 'Publisher 只见发布导航');
  await active.locator('[data-prototype-control="nav-publish"]:visible').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="publish"]').click();
  assert.equal((await activeMeta(page)).state, 'published');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="audit"]').click();
  assert.match(await active.locator('.inline-status').innerText(), /Publisher.*IP|Publisher.*10\./i);
  active = await select(page, 'P-PUB-HOME', 'ready');
  assert.match(await active.innerText(), /services essentiels|essential public services/i, 'F-009 发布后前台内容可见');
  active = await select(page, 'P-CMS-PUBLISH', 'published');
  await active.locator('[data-prototype-control="unpublish"]').click();
  assert.equal((await activeMeta(page)).state, 'pending-publish');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="archive"]').click();
  assert.equal((await activeMeta(page)).state, 'archived');
  active = await select(page, 'P-PUB-SECTION', 'loaded');
  assert.equal(await active.locator('[data-prototype-control="content-card"]').isVisible(), false, 'F-009 归档后栏目不再暴露详情入口');
  active = await select(page, 'P-PUB-CONTENT', 'published');
  assert.equal(await active.getAttribute('data-public-projection'), 'archived');
  assert.match(await active.innerText(), /410|archiv/i, 'F-009 归档投影提供 410 语义');
  assert.doesNotMatch(await active.innerText(), /Les administrations renforcent/);
  completed.push('F-009');

  assert.deepEqual(completed, catalog.flows.map(flow => flow.id), 'F-001 至 F-009 全部执行真实点击主路径');
  return completed;
}

async function runBoundaryRegressions(page) {
  // 账户异常态必须由同一认证入口和键盘门禁 fail closed。
  await reset(page);
  let active = await select(page, 'P-PUB-ACCOUNT', 'locked');
  const lockedPhone = active.locator('[data-prototype-control="phone"]');
  await lockedPhone.press('Enter');
  assert.equal((await activeMeta(page)).state, 'locked', 'locked 的 Enter 不得进入 OTP');
  assert.equal(await lockedPhone.isDisabled(), true, 'locked 输入与按钮同时禁用');
  assert.equal(await active.locator('[data-prototype-control="submit"]').isDisabled(), true, 'locked 提交按钮禁用');

  active = await select(page, 'P-PUB-ACCOUNT', 'expired');
  const expiredOtp = active.locator('[data-prototype-control="otp"]');
  assert.equal(await expiredOtp.isDisabled(), true, 'expired 旧 OTP 不可再次提交');
  await active.locator('[data-prototype-control="submit"]').click();
  assert.equal((await activeMeta(page)).state, 'register', 'expired 仅允许明确重新获取');

  active = await select(page, 'P-PUB-ACCOUNT', 'session-expired');
  await active.locator('[data-prototype-control="submit"]').click();
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#app').dataset.renewalAttempts, document.querySelector('#app').dataset.renewalOutcome]), ['1', 'failed'], 'session-expired 只记录一次静默续期失败');
  assert.equal((await activeMeta(page)).state, 'register');
  active = await select(page, 'P-PUB-ACCOUNT', 'session-expired');
  await active.locator('[data-prototype-control="phone"]').press('Enter');
  assert.equal(await page.locator('#app').getAttribute('data-renewal-attempts'), '1', '重复入口不增加续期次数');

  await reset(page);
  await signInCms(page, 'publisher');
  active = await select(page, 'P-PUB-ACCOUNT', 'session-expired');
  await active.locator('[data-prototype-control="submit"]').click();
  await page.evaluate(() => { location.hash = '#/fr/cms/publish'; });
  await page.waitForTimeout(60);
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-CMS-LOGIN', 'signed-out'], '会话到期动作清除 CMS 身份，后续客户路由重新认证');

  // Citizen 即使已认证，也不能进入任何 CMS 目标。
  await reset(page);
  active = await select(page, 'P-PUB-SERVICE-GUIDE', 'available');
  await active.locator('[data-prototype-control="start"]').click();
  await citizenLogin(page);
  for (const id of ['nav-dashboard', 'nav-editor', 'nav-review', 'nav-publish']) {
    active = await select(page, 'P-CMS-LOGIN', 'signed-out');
    await active.locator(`[data-prototype-control="${id}"]`).click();
    assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-CMS-LOGIN', 'denied'], `Citizen ${id} 被 CMS allowlist 拒绝`);
  }
  for (const role of ['editor', 'reviewer', 'publisher']) {
    await reset(page);
    const dashboard = await signInCms(page, role);
    assert.deepEqual([dashboard.page, dashboard.state], ['P-CMS-DASHBOARD', role === 'editor' ? 'role-filtered' : 'empty'], `${role} 的 CMS dashboard 只显示当前事实可处理工作`);
  }

  for (const slug of ['pub/application', 'pub/receipt', 'pub/application/status']) {
    await page.goto('about:blank');
    await page.evaluate(slug => { location.hash = '#/fr/' + slug; }, slug);
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-PUB-ACCOUNT', 'register'], `匿名 ${slug} 在受保护 DOM 呈现前进入账户页`);
    assert.doesNotMatch(await page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible').innerText(), /CMR-2026-0917-042/, `匿名 ${slug} 不暴露回执`);
  }
  await page.goto('about:blank');
  await page.evaluate(() => { location.hash = '#/fr/pub/application/status'; });
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await citizenLogin(page);
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-PUB-APPLICATION-STATUS', 'pending'], '公民登录后恢复安全的申请进度 returnTo');

  // draft 不得直接审核或发布；review 未批准不得发布。
  await reset(page);
  await signInCms(page, 'reviewer');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="nav-review"]:visible').click();
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-CMS-DASHBOARD', 'empty'], 'draft 对 Reviewer 只呈现无待办空态');
  assert.equal(await page.locator('[data-prototype-control="approve"]:visible').count(), 0);

  await reset(page);
  await signInCms(page, 'publisher');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="nav-publish"]:visible').click();
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-CMS-DASHBOARD', 'empty'], 'draft 对 Publisher 只呈现无待办空态');
  assert.equal(await page.locator('[data-prototype-control="publish"]:visible').count(), 0);

  await reset(page);
  await signInCms(page, 'editor');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="new-content"]:visible').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="submit-review"]').click();
  active = await select(page, 'P-CMS-LOGIN', 'signed-out');
  await active.locator('[data-prototype-control="sign-in"][data-role="publisher"]').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="nav-publish"]:visible').click();
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state ], ['P-CMS-DASHBOARD', 'empty'], 'review 未批准不能发布');

  // 合法退回也必须由同一 review 事实触发，并恢复 Editor 可操作的 draft 存储态。
  await reset(page);
  await signInCms(page, 'editor');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="new-content"]:visible').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="submit-review"]').click();
  active = await select(page, 'P-CMS-LOGIN', 'signed-out');
  await active.locator('[data-prototype-control="sign-in"][data-role="reviewer"]').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="review-queue"]:visible').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="return"]').click();
  let returned = await activeMeta(page);
  assert.deepEqual([returned.page,returned.state,returned.role,returned.storageState,returned.workflowView,returned.allowedActions], ['P-CMS-REVIEW','returned','Reviewer','draft','returned','edit,submit-review']);
  assertTransition(returned.lastTransition, 'return', 'reviewer');

  // 不 reset 的 F-007 → F-008 → F-009 连续事实链。
  await reset(page);
  await signInCms(page, 'editor');
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="new-content"]:visible').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="save"]').click();
  await active.locator('[data-prototype-control="submit-review"]').click();
  let facts = await activeMeta(page);
  assert.deepEqual([facts.storageState,facts.workflowView,facts.allowedActions], ['review','submitted','approve,return']);
  assertTransition(facts.lastTransition, 'submit-review', 'editor');

  active = await select(page, 'P-CMS-LOGIN', 'signed-out');
  await active.locator('[data-prototype-control="sign-in"][data-role="reviewer"]').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="review-queue"]:visible').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="approve"]').click();
  facts = await activeMeta(page);
  assert.deepEqual([facts.storageState,facts.workflowView,facts.allowedActions], ['review','pending-publish','publish,archive']);
  assertTransition(facts.lastTransition, 'approve', 'reviewer');

  active = await select(page, 'P-CMS-LOGIN', 'signed-out');
  await active.locator('[data-prototype-control="sign-in"][data-role="publisher"]').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="nav-publish"]:visible').click();
  active = page.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
  await active.locator('[data-prototype-control="publish"]').click();
  facts = await activeMeta(page);
  assert.deepEqual([facts.storageState,facts.workflowView,facts.allowedActions], ['published','published','unpublish,archive']);
  assertTransition(facts.lastTransition, 'publish', 'publisher');
  active = await select(page, 'P-PUB-HOME', 'ready');
  assert.equal(await active.locator('.hero').isVisible(), true, 'published 投影显示首页内容');
  active = await select(page, 'P-PUB-SECTION', 'loaded');
  assert.equal(await active.locator('[data-public-content-id="content-884"]').isVisible(), true, 'published 投影显示栏目目标内容');
  active = await select(page, 'P-PUB-CONTENT', 'published');
  assert.equal(await active.locator('.article').isVisible(), true, 'published 投影显示详情正文');

  active = await select(page, 'P-CMS-PUBLISH', 'published');
  await active.locator('[data-prototype-control="unpublish"]').click();
  active = await select(page, 'P-PUB-HOME', 'ready');
  assert.equal(await active.locator('.hero').isVisible(), false, 'unpublish 立即撤首页投影');
  active = await select(page, 'P-PUB-SECTION', 'loaded');
  assert.equal(await active.locator('[data-public-content-id="content-884"]').isVisible(), false, 'unpublish 立即撤栏目目标内容');
  assert.equal(await active.locator('.story-list').isVisible(), true, 'unpublish 保留栏目容器');
  assert.equal(await active.getByText('Calendrier des services fiscaux', { exact: true }).isVisible(), true, 'unpublish 保留无关税务新闻');
  assert.equal(await active.locator('.pager').isVisible(), true, 'unpublish 保留分页');
  assert.doesNotMatch(await active.innerText(), /410/, '栏目不扩散详情 410');
  active = await select(page, 'P-PUB-CONTENT', 'published');
  assert.equal(await active.locator('.article').isVisible(), false, 'unpublish 立即撤详情正文');
  assert.match(await active.innerText(), /hors ligne|unpublished|indisponible/i);

  active = await select(page, 'P-CMS-PUBLISH', 'pending-publish');
  await active.locator('[data-prototype-control="publish"]').click();
  for (const [pageId, stateId] of [['P-PUB-HOME', 'ready'], ['P-PUB-SECTION', 'loaded'], ['P-PUB-CONTENT', 'published']]) {
    active = await select(page, pageId, stateId);
    assert.equal(await active.locator('[data-public-content-id="content-884"]').isVisible(), true, `republish 恢复 ${pageId} 目标内容`);
  }
  active = await select(page, 'P-CMS-PUBLISH', 'published');
  await active.locator('[data-prototype-control="archive"]').click();
  active = await select(page, 'P-PUB-HOME', 'ready');
  assert.equal(await active.locator('[data-public-content-id="content-884"]').isVisible(), false, 'archive 撤首页目标内容');
  assert.doesNotMatch(await active.innerText(), /410/, '首页不扩散详情 410');
  active = await select(page, 'P-PUB-SECTION', 'loaded');
  assert.equal(await active.locator('[data-public-content-id="content-884"]').isVisible(), false, 'archive 撤栏目目标内容');
  assert.equal(await active.getByText('Calendrier des services fiscaux', { exact: true }).isVisible(), true, 'archive 保留无关税务新闻');
  assert.doesNotMatch(await active.innerText(), /410/, '栏目不扩散详情 410');
  active = await select(page, 'P-PUB-CONTENT', 'published');
  assert.equal(await active.getAttribute('data-public-projection'), 'archived');
  assert.match(await active.innerText(), /410|archiv/i);

  // 分享 hash 初始恢复、变化恢复和非法输入安全回退。
  await page.goto('about:blank#/en/pub/section?page=2&type=news');
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  assert.deepEqual([ (await activeMeta(page)).page, (await activeMeta(page)).state, await page.evaluate(() => document.documentElement.lang), await page.locator('[data-prototype-state]:visible').getAttribute('data-page-number') ], ['P-PUB-SECTION','loaded','en','2'], '合法 hash 可在新装载恢复');
  await page.evaluate(() => { location.hash = '#/fr/pub/search'; });
  await page.waitForFunction(() => document.querySelector('#app > [data-prototype-page]:not([hidden])')?.dataset.prototypePage === 'P-PUB-SEARCH');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'fr', 'hashchange 恢复语言与页面');
  for (const invalid of ['#/zz/cms/publish?page=999&type=evil', '#/en/pub/section?page=-5&type=evil', '#/en/not/a/page?state=published']) {
    await page.goto('about:blank' + invalid);
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    assert.deepEqual([ (await activeMeta(page)).page, await page.evaluate(() => document.documentElement.lang), await page.evaluate(() => location.hash) ], ['P-PUB-HOME','fr','#/fr/pub/home'], `非法 hash 安全回退: ${invalid}`);
  }
  return { accountGuards: true, citizenCmsDenied: true, continuousCmsLifecycle: true, publicProjection: true, hashRoundTrip: true };
}

async function run() {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    assertRawContract(await inspectRawHTML(page));
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#app > [data-prototype-page]').count(), 16, '运行时保留 16 页同一棵 DOM');
    assert.equal(await page.locator('#app > [data-prototype-page] > [data-prototype-state]').count(), 58, '运行时保留 58 态同一棵 DOM');
    for (const spec of catalog.pages) {
      const controls = new Map(), fields = new Set();
      for (const state of spec.states) {
        const active = await select(page, spec.id, state.id);
        for (const item of await active.locator('[data-prototype-control]:visible').evaluateAll(ns => ns.map(n => ({ id: n.dataset.prototypeControl, type: n.dataset.prototypeType, action: n.dataset.prototypeAction, target: n.dataset.prototypeTarget || null })))) controls.set(item.id, item);
        for (const id of await active.locator('[data-prototype-field]:visible').evaluateAll(ns => ns.map(n => n.dataset.prototypeField))) fields.add(id);
      }
      assert.deepEqual([...controls.keys()].sort(), spec.controls.map(c => c.id).sort(), `${spec.id} 可见控件并集精确`);
      for (const [id, actual] of controls) assert.deepEqual(actual, { id, ...contracts[spec.id][id] });
      assert.deepEqual([...fields].sort(), (spec.fields || []).map(f => f.id).sort(), `${spec.id} 可见字段并集精确`);
    }

    const flows = await runFlows(page);
    const boundaryRegressions = await runBoundaryRegressions(page);
    const viewports = { desktop: { width: 1280, height: 820 }, tablet: { width: 900, height: 820 }, mobile: { width: 390, height: 844 }, 'cms-desktop': { width: 1280, height: 820 } };
    let combinations = 0, stateCombinations = 0;
    for (const spec of catalog.pages) for (const viewport of spec.id.startsWith('P-CMS') ? ['cms-desktop'] : ['desktop', 'tablet', 'mobile']) {
      await page.setViewportSize(viewports[viewport]);
      combinations++;
      for (const state of spec.states) {
        const active = await select(page, spec.id, state.id);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${spec.id}:${state.id}:${viewport} 无横向溢出`);
        assert.ok(await active.locator('h1,h2').first().isVisible(), `${spec.id}:${state.id}:${viewport} 关键标题可见`);
        stateCombinations++;
      }
    }
    fs.mkdirSync(evidenceDir, { recursive: true });
    for (const [file, pageId, stateId, viewport] of [
      [`${evidencePrefix}-home-mobile.png`, 'P-PUB-HOME', 'mobile', 'mobile'],
      [`${evidencePrefix}-application.png`, 'P-PUB-APPLICATION', 'materials', 'desktop'],
      [`${evidencePrefix}-cms-editor.png`, 'P-CMS-EDITOR', 'draft', 'cms-desktop']
    ]) {
      await page.setViewportSize(viewports[viewport]); await select(page, pageId, stateId);
      const french = page.locator('[data-language="fr"]:visible,[data-language-toggle="fr"]:visible').first();
      if (await french.count()) await french.click();
      await page.screenshot({ path: path.join(evidenceDir, file), fullPage: viewport !== 'mobile' });
    }
    assert.equal(errors.length, 0, `页面无 JavaScript 错误: ${errors.join('; ')}`);
    const evidence = {
      ok: true, pages: catalog.pages.length,
      states: catalog.pages.reduce((sum, item) => sum + item.states.length, 0),
      controls: catalog.pages.reduce((sum, item) => sum + item.controls.length, 0),
      fields: catalog.pages.reduce((sum, item) => sum + (item.fields || []).length, 0),
      input: artifactInput ? { kind: 'build-artifact', path: artifactInput } : { kind: 'template-generator' },
      inputSha256,
      combinations, stateCombinations, errors: 0, architecture: 'single-business-dom-tree',
      flows, boundaryRegressions,
      permissions: { signedOutCmsDenied: true, reviewerRoleStable: true, publisherIndependent: true }
    };
    const evidenceFile = artifactInput ? 'build-customer-browser.json' : 'customer-browser.json';
    fs.writeFileSync(path.join(evidenceDir, evidenceFile), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
