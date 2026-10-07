import { query } from '../../db/pool.js';
import { CHAPTER_RULE, designSectionRule, reqSectionRule } from './doc-conventions.js';
import { DSG_BOOK_LETTER } from './rtm-health.js';

/**
 * 默认文档模板库（2026-10-06 用户拍板：每种文档一份默认模板参考；默认的也要很专业）。
 *
 * 【管理纪律】本模块是默认模板的**唯一权威落点**：修改走 git 评审 + 标准映射测试（doc-templates.test.ts）
 * + check-codes 闸；界面只读呈现（📄 模板钮）。项目级自定义不走本模块——用户把公司模板传资料并挂为参考，
 * 「用户模板优先」声明使生成链以用户模板为准。设置页模板编辑器=后续候选（模式总结 §三登记）。
 *
 * 【与 doc-conventions 的分工】conventions 管「格式」（大章形态、锚点码）；templates 管「内容」
 * （大章骨架、每章写什么、编写规则、质量 bar）。标准映射：CRD/PRD=ISO/IEC/IEEE 29148、
 * HLD 等=ISO/IEC/IEEE 42010、API=OpenAPI 3.1、UI=WCAG 2.2、NFR=ISO/IEC 25010。
 */

export interface DocTemplate {
  /** 显示名（自定义类别必填；内置类别由前端 KIND_LABELS 派生，可空） */
  label?: string;
  /** 标准出处（注入 prompt 让模型按标准语义写作；评审 agent 同口径） */
  standard: string;
  /** 质量 bar（整份文档的验收性总要求） */
  quality: string;
  /** 编写规则（语言/格式/度量纪律——每条可检查） */
  writingRules: string[];
  /** 大章骨架：章标题 → 该章内容要求（含质量口径） */
  chapters: Array<{ title: string; requires: string }>;
}

const CRD_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 29148 需求工程（良好需求集特性）',
  quality: '整份文档：完整（场景全覆盖）、一致（规则无冲突）、可追踪（双向锚点）；只写"要什么"，不写实现方案。',
  writingRules: [
    '需求语句用「应/须」句、单一主语单一职责——一条只说一件事',
    '量化可测：禁用「尽量/较快/用户友好/高性能」等不可验证措辞',
    '每条 CR 具备三要素：锚点码（CR-nnn）+ 承接来源（R-nnn）+ 验收要点（给定条件→可观察结果）',
    '不写设计方案与技术选型（属 PRD/设计域），不写无出处的需求',
  ],
  chapters: [
    { title: '一、背景与目标', requires: '业务背景与问题定义（现状痛点+量化影响）；目标分解为可度量的成功指标；范围与排除项（明确不做什么）；目标读者' },
    { title: '二、干系人与使用场景', requires: '角色清单（职责/诉求/约束）；核心使用场景按 UC-n 编号：前置条件→主流程→后置结果；场景的边界与异常入口' },
    { title: '三、功能需求', requires: 'CR-nnn 条目（描述+验收要点+承接来源），按场景分组；覆盖全部场景主流程与必要异常路径' },
    { title: '四、非功能需求', requires: '性能（响应时间/吞吐：数值+条件）、兼容性（浏览器/设备矩阵）、可用性、安全基线——每条给验收方法（怎么测、什么环境）' },
    { title: '五、约束与假设', requires: '技术约束（运行环境/外部依赖）、业务约束（合规/时间/资源）、前提假设及不成立时的影响' },
    { title: '六、术语表', requires: '领域术语与缩写的权威定义（消除一词多义；与下游文档共用同一术语口径）' },
  ],
};

const PRD_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 29148 需求工程（系统/软件需求规格）',
  quality: '每条 REQ 双向可追踪（CR→REQ→验收要点）；规格可直接转写测试用例；版本与定稿态如实标注，不宣称未生效内容。',
  writingRules: [
    '每条 REQ 必须有承接锚点 CR-nnn；确无承接的孤立需求须显式标注理由',
    '验收要点=测试用例可直译：测试条件+操作+预期结果（可观察、可复现）',
    '规则细节写全边界：异常输入、并发、空态、权限边界；规则间冲突须显式裁决（优先级/例外）',
    '度量指标给三件套：数值+条件+样本量（如「95% 样本 ≤100ms，连续 5 分钟前台运行」）',
  ],
  chapters: [
    { title: '一、文档依据与产品目标', requires: '上游基线（CRD 版本号与定稿态）；产品目标与度量指标；本文读者与审阅路径' },
    { title: '二、范围与角色', requires: '功能范围与排除项；用户角色与权限矩阵（每角色能做什么/不能做什么）' },
    { title: '三、功能需求', requires: 'REQ-nnn 条目：需求描述+规则细节（边界/异常/并发）+验收要点+承接 CR-nnn；逐条覆盖上游全部 CR' },
    { title: '四、非功能需求', requires: '性能/兼容性/可用性/安全的量化验收条件：指标+测试环境+样本量+测量方法' },
    { title: '五、界面与交互要求', requires: '布局结构；状态四态（空/加载/错误/禁用）呈现；异常提示口径（文案级别）' },
    { title: '六、数据与兼容要求', requires: '数据格式与持久化要求、外部系统接口约束、迁移/兼容要求' },
    { title: '七、术语与引用', requires: '术语与缩写的权威定义（与上游术语表一致性口径）；引用文档清单（文档名+版本号+定稿态）' },
  ],
};

const HLD_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述（关注点-视图框架）',
  quality: '每个架构决策可追溯理由（ADR）；每个干系人关注点有对应视图；接口/数据/部署能直接落地到详细设计。',
  writingRules: [
    '每个架构决策按 ADR 记录：背景→备选（≥2）→结论→后果；不给理由的选型不算决策',
    '视图与关注点一一对应（逻辑/进程/部署/数据），不以一张"架构图"代替视图',
    '质量目标回链 NFR 册指标；上游 REQ 承接逐条显式回引',
  ],
  chapters: [
    { title: '一、架构目标与约束', requires: '架构驱动因素（业务目标/质量场景/技术约束）；干系人关注点清单；架构边界（系统上下文）' },
    { title: '二、总体架构', requires: '分层/组件结构与职责边界；技术选型 ADR 表（每项：背景→备选→结论→后果）' },
    { title: '三、架构视图', requires: '逻辑视图（模块关系与职责）；进程视图（进程/并发/通信）；部署视图（节点/拓扑/网络）；数据视图（核心数据流）' },
    { title: '四、关键机制', requires: '横切机制决策：事务/并发/缓存/安全/审计/错误处理——每个给机制级方案（非泛泛原则）' },
    { title: '五、风险与权衡', requires: '技术风险登记（风险→影响→缓解）；关键权衡的备选方案与取舍理由' },
    { title: '六、承接与映射', requires: '上游 REQ→架构元素的承接清单（显式回引 REQ-nnn，无遗漏）' },
  ],
};

const MOD_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·模块视图',
  quality: '模块高内聚低耦合；依赖方向无环；每个接口契约可直接评审实现符合性。',
  writingRules: [
    '每个模块单一职责一句话可述；职责说不清的模块必须拆分或合并',
    '依赖只许单向；调用/事件/数据三种依赖方式分别标注',
    '接口契约=签名+前置条件+后置条件+错误语义，四件套缺一不可',
  ],
  chapters: [
    { title: '一、模块划分', requires: '模块清单：职责一句话、边界（不做什么）、数据所有权（哪些表/状态归它管）' },
    { title: '二、依赖矩阵', requires: '模块间依赖关系表：方向+方式（调用/事件/数据）；显式声明无循环依赖' },
    { title: '三、接口契约', requires: '每模块对外接口：签名、前置/后置条件、错误语义（对应错误码或异常）' },
    { title: '四、模块内部结构', requires: '关键类/函数的职责划分（指引级，给 LLD 落笔空间）' },
    { title: '五、承接与映射', requires: 'HLD 组件→本册模块的映射；相关 REQ 回引' },
  ],
};

const ALG_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·行为视图',
  quality: '主流程与异常路径双写；状态机可机械校验（迁移表完备）；边界条件逐条列出可转测试。',
  writingRules: [
    '流程按编号步骤写（每步：动作+输入+输出），禁止散文式流程',
    '状态机三要素齐全：状态集、事件集、迁移表（当前态×事件→下一态+动作）；非法/不可达迁移显式标注',
    '每个算法给时间/空间复杂度量级；边界条件（空/满/并发上限）逐条列出',
  ],
  chapters: [
    { title: '一、核心流程', requires: '主流程编号步骤（每步输入输出）；异常分支与补偿路径（哪步失败回退到哪）' },
    { title: '二、状态机清单', requires: '每个状态机：状态集、事件集、迁移表；初始/终止状态；非法迁移处理' },
    { title: '三、异常路径', requires: '超时、并发冲突、失败重试、幂等保证——逐场景给处理策略' },
    { title: '四、复杂度与边界', requires: '时间/空间复杂度量级；边界条件清单（空输入/最大值/并发上限）及各自行为' },
  ],
};

const CLS_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·信息视图（UML 惯例）',
  quality: '实体/值对象/聚合三分明确；不变式归口到拥有者；命令与事件构成完整领域语言。',
  writingRules: [
    '实体（有标识）与值对象（无标识）不得混用；不变式写在拥有它的实体下',
    '关系标明多重性（1:1/1:N/M:N）与级联规则；聚合边界内才允许事务一致性',
    '命令用祈使式（CreateX）、事件用过去式（XCreated）；载荷逐字段列出',
  ],
  chapters: [
    { title: '一、核心实体', requires: '实体清单：标识、关键属性、不变式、生命周期状态（对应 ALG 状态机）' },
    { title: '二、值对象', requires: '值对象清单：组成字段、相等性规则、不可变约束' },
    { title: '三、关系与聚合', requires: '聚合边界、关联/组合关系（多重性+级联）；跨聚合引用方式（标识引用，不嵌套）' },
    { title: '四、命令与事件', requires: '领域命令（祈使式）与领域事件（过去式）清单：载荷、产生时机、消费者' },
  ],
};

const DB_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·数据视图',
  quality: '约束进库（不靠应用层自觉）；索引全部对应实际查询模式；不可变表有明确的禁改删与保留口径。',
  writingRules: [
    '每表：主键+创建/审计列；外键关系与删除行为（CASCADE/NO ACTION）显式声明',
    '每个索引注明服务的查询模式；无查询模式支撑的索引不建',
    'append-only 表（审计/事件/证据）显式标注：禁 UPDATE/DELETE、保留策略',
    '迁移纪律：只加不改（加列可空化）、编号递增、可重放',
  ],
  chapters: [
    { title: '一、表清单', requires: '每表：用途一句话、字段表（名/类型/约束/含义）、主键与外键' },
    { title: '二、约束与索引', requires: '唯一/检查约束清单；索引⇢查询模式映射表' },
    { title: '三、append-only 清单', requires: '不可变表及保留策略；哈希链/证据类表的完整性机制' },
    { title: '四、迁移策略', requires: '迁移编号规则、向前兼容口径、历史数据回填规则' },
  ],
};

const API_TEMPLATE: DocTemplate = {
  standard: 'OpenAPI 3.1 / REST 成熟度模型（资源语义+闭集错误码）',
  quality: '端点可直接生成 OpenAPI 文档；错误全部落闭集码；写操作幂等性逐端点可验证。',
  writingRules: [
    '资源用名词复数+HTTP 动词语义；域内动作用冒号动作路由（:commit 风格）保持全项目一致',
    '错误一律使用 DomainError 闭集码（不新造码）；每端点列出可能错误码及触发条件',
    '写操作必须幂等：Idempotency-Key 或天然键（说明去重与冲突行为）',
    '载荷字段全量声明：名/类型/必填/约束/示例',
  ],
  chapters: [
    { title: '一、端点总览', requires: '端点表：方法+路径+语义+权限，按资源分组' },
    { title: '二、请求与响应模型', requires: '各端点载荷字段表（名/类型/必填/约束/示例）' },
    { title: '三、错误码使用', requires: '每端点可能的 DomainError 闭集码及触发条件' },
    { title: '四、幂等约定', requires: '写端点的幂等键语义、重试行为、冲突（409）语义' },
    { title: '五、版本策略', requires: '兼容性承诺、演进规则（只加不改）、废弃流程' },
  ],
};

const UI_TEMPLATE: DocTemplate = {
  standard: 'WCAG 2.2（AA）/ 设计系统惯例',
  quality: '每页四态齐备；全部颜色走语义令牌；关键任务流可纯键盘完成；评审可逐条核对。',
  writingRules: [
    '每页四态必设：空态（含引导）、加载、错误（含恢复路径）、禁用（含原因提示）',
    '颜色只引用语义令牌（var()），禁写死色值；禁色与禁样式逐条列出',
    '交互反馈三选一并注明：toast（瞬时）/行内（上下文）/modal（阻断决策）',
    '对比度 ≥4.5:1（AA）、焦点可见、aria 语义角色齐全',
  ],
  chapters: [
    { title: '一、页面清单', requires: '页面/路由/职责一句话；页面间导航关系（含直达参数）' },
    { title: '二、组件树', requires: '每页组件层级；复用组件清单；引用的设计令牌（色/距/字号）' },
    { title: '三、交互与状态', requires: '每页四态设计；关键交互流（步进）与反馈方式；异常交互（断网/冲突/超时）' },
    { title: '四、可访问性', requires: 'WCAG 2.2 AA 核对清单：对比度、键盘可达、焦点管理、语义标签' },
  ],
};

const NFR_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC 25010 产品质量模型',
  quality: '每条指标=数值+条件+测量方法三件套；每条可直译为验收用例；禁绝对化表述（"100%/零故障"须给口径）。',
  writingRules: [
    '指标给分位值不给均值（如 P95 ≤300ms）；测试条件写全（环境/数据量/并发/时长）',
    '测量方法可复现：工具、步骤、样本量、判定阈值',
    '每条 NFR 标注验收责任阶段（自测/测试验收）与证据形式',
  ],
  chapters: [
    { title: '一、性能效率', requires: '响应时间（分位值）、吞吐、资源占用上限——各附测试条件（数据量/并发/时长）' },
    { title: '二、兼容性', requires: '环境矩阵（浏览器/设备/OS 版本），每格的验收口径（全功能/降级/不支持）' },
    { title: '三、可靠性与可用性', requires: '故障恢复目标（RTO/RPO 量级）、数据不丢不错口径、可用性目标与度量窗' },
    { title: '四、安全性', requires: '认证/授权模型、传输与存储保护、注入/XSS/越权基线、审计留痕要求' },
    { title: '五、可维护性与可移植性', requires: '可测试性（覆盖率门槛）、可修改性（模块替换成本）、部署与迁移要求' },
  ],
};

const BOOK_TEMPLATES: Record<string, DocTemplate> = {
  hld: HLD_TEMPLATE,
  mod: MOD_TEMPLATE,
  alg: ALG_TEMPLATE,
  cls: CLS_TEMPLATE,
  db: DB_TEMPLATE,
  api: API_TEMPLATE,
  ui: UI_TEMPLATE,
  nfr: NFR_TEMPLATE,
};

/** 生成 prompt 注入块：默认模板骨架+编写规则+质量 bar+「用户模板优先」声明（参考资料注入在模板块之后，模型自然以用户模板为准）。
 *  读「项目绑定套件条目 → 代码默认」解析链（套件机制，2026-10-07）；自定义类别（x- 前缀）无生成链落点，不入此函数 */
export function buildTemplateGuide(domain: 'req' | 'design', kind: string, projectId?: string): string {
  const t = resolveTemplate(domain, kind, projectId);
  if (!t) return '';
  const codeRule = domain === 'req'
    ? reqSectionRule(kind as 'crd' | 'prd')
    // DSG_BOOK_LETTER 是大写（RTM 册级锚 DSG-H），chapter_prefix 是小写（h-*）——同一组字母两种规格形态
    : designSectionRule((DSG_BOOK_LETTER[kind] ?? kind).toLowerCase());
  return [
    `【默认文档模板（依据 ${t.standard}）】`,
    `质量要求：${t.quality}`,
    `编写规则：`,
    ...t.writingRules.map((r) => `- ${r}`),
    `结构（大章⇢内容要求）：`,
    ...t.chapters.map((c) => `- ${c.title}：${c.requires}`),
    `编号与锚点格式：${CHAPTER_RULE}${codeRule}`,
    '若参考资料中包含用户提供的模板/格式规范类文档，以其结构与要求为准（用户模板优先）；否则按以上默认模板生成。',
  ].join('\n');
}

/** 测试/校验用：模板注册表直出（防某类文档漏模板；代码默认，不含套件覆盖） */
export function listTemplates(): Record<string, DocTemplate> {
  return { crd: CRD_TEMPLATE, prd: PRD_TEMPLATE, ...BOOK_TEMPLATES };
}

// ---------- 模板套件（2026-10-07 拍板：按项目创建/保存/复用一整套模板，版本管理=命名套件） ----------
// 架构：代码默认是基线；套件（sys_template_sets/items）全局可复用，项目绑定活动套件
// （prj_template_binding）；kind 解析链=项目绑定套件条目 → 代码默认（未存条目的 kind 回退默认，
// 「基于默认模板创建一整套」= 空套件+逐项编辑，回退链保证无缺项）。单进程：内存缓存，boot/写后刷新。
// 取代前日 sys_settings 单覆盖设施（上线一天、无在途数据，直接弃用）。

/** 自定义类别命名空间（内置十类之外的模板类别，如 x-acceptance 验收方案） */
export const CUSTOM_KIND_RE = /^x-[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

let setItems = new Map<string, Map<string, DocTemplate>>(); // setId → kind → template
let bindings = new Map<string, string>();                   // projectId → setId

export async function refreshTemplateOverrides(): Promise<void> {
  try {
    const items = await query<{
      set_id: string; kind: string; label: string; standard: string; quality: string;
      writing_rules: string[]; chapters: Array<{ title: string; requires: string }>;
    }>('SELECT set_id, kind, label, standard, quality, writing_rules, chapters FROM sys_template_set_items');
    const next = new Map<string, Map<string, DocTemplate>>();
    for (const r of items.rows) {
      if (!next.has(r.set_id)) next.set(r.set_id, new Map());
      next.get(r.set_id)!.set(r.kind, {
        standard: r.standard, quality: r.quality, writingRules: r.writing_rules, chapters: r.chapters,
        ...(r.label ? { label: r.label } : {}),
      });
    }
    setItems = next;
    const b = await query<{ project_id: string; set_id: string }>('SELECT project_id, set_id FROM prj_template_binding');
    bindings = new Map(b.rows.map((x) => [x.project_id, x.set_id]));
  } catch { /* 读取失败保留现状（不阻断生成链） */ }
}

/** kind 解析（含项目绑定）：绑定套件有该 kind 条目 → 套件条目；否则代码默认（自定义 kind 无默认→undefined） */
export function resolveTemplate(domain: 'req' | 'design', kind: string, projectId?: string): DocTemplate | undefined {
  if (projectId) {
    const setId = bindings.get(projectId);
    const item = setId ? setItems.get(setId)?.get(kind) : undefined;
    if (item) return item;
  }
  return codeDefaultTemplate(kind);
}

/** 套件内条目直读（设置页编辑器按套件取表单初值） */
export function setItemTemplate(setId: string, kind: string): DocTemplate | undefined {
  return setItems.get(setId)?.get(kind);
}

/** 项目当前绑定（读侧直出） */
export function bindingOf(projectId: string): string | undefined {
  return bindings.get(projectId);
}

/** 代码默认（设置页「恢复默认」参照/对比用；自定义 kind 返回 undefined） */
export function codeDefaultTemplate(kind: string): DocTemplate | undefined {
  if (kind === 'crd') return CRD_TEMPLATE;
  if (kind === 'prd') return PRD_TEMPLATE;
  return BOOK_TEMPLATES[kind];
}

/** 专业度校验（编辑器保存闸；与 doc-templates.test 门槛同源——用户也不能把模板改水）。
 *  自定义类别（x- 前缀）跳过「编号规范/内置枚举」检查但质量门槛同标。
 *  返回人话问题清单（空数组=通过；不落码，门面按 VALIDATION_FAILED 汇总抛出） */
export function validateTemplate(kind: string, t: DocTemplate): string[] {
  const problems: string[] = [];
  const custom = CUSTOM_KIND_RE.test(kind);
  if (!custom && !codeDefaultTemplate(kind)) {
    problems.push(`未知文档类型 ${kind}（内置枚举 crd|prd|hld|mod|alg|cls|db|api|ui|nfr；自定义类别用 x- 前缀，如 x-acceptance）`);
  }
  if (custom && !(t.label ?? '').trim()) problems.push('自定义类别必须填显示名（label）');
  if (!t.standard || t.standard.trim().length < 4) problems.push('依据标准必填（≥4 字，如 ISO/IEC/IEEE 29148；无对应标准时写公司/团队规范名）');
  if (!t.quality || t.quality.trim().length < 10) problems.push('质量要求必填（≥10 字）');
  const rules = t.writingRules ?? [];
  if (rules.length < 3) problems.push(`编写规则至少 3 条（当前 ${rules.length} 条）`);
  rules.forEach((r, i) => { if ((r ?? '').trim().length < 10) problems.push(`编写规则第 ${i + 1} 条过短（≥10 字）`); });
  const chapters = t.chapters ?? [];
  if (chapters.length < 4) problems.push(`大章至少 4 章（当前 ${chapters.length} 章）`);
  chapters.forEach((c, i) => {
    if (!/^[一二三四五六七八九十]+、/.test(c.title ?? '')) problems.push(`第 ${i + 1} 章标题须中文数字+顿号（如「一、背景与目标」）`);
    if ((c.requires ?? '').trim().length < 20) problems.push(`第 ${i + 1} 章内容要求过短（≥20 字，写到可验收粒度）`);
  });
  return problems;
}
