import { CHAPTER_RULE, designSectionRule, reqSectionRule } from './doc-conventions.js';
import { DSG_BOOK_LETTER } from './rtm-health.js';

/**
 * 默认文档模板库（2026-10-06 用户拍板：每种文档一份默认模板参考，结构/要求参考国际标准；
 * 用户未提供自定义模板时按默认模板生成，提供了就以用户的为准）。
 *
 * 与 doc-conventions 的分工：conventions 管「格式」（大章形态、锚点码），templates 管「内容」
 * （每类文档应有哪些大章、每章写什么、质量 bar 是什么）。prompt 注入块由 buildTemplateGuide 组装。
 * 标准映射：CRD/PRD=ISO/IEC/IEEE 29148（需求工程）、HLD 等=ISO/IEC/IEEE 42010（架构描述）、
 * API=OpenAPI 3.1/REST、UI=WCAG 2.2、NFR=ISO/IEC 25010（质量模型）。
 */

export interface DocTemplate {
  /** 标准出处（一句话，注入 prompt 让模型按标准语义写作） */
  standard: string;
  /** 质量 bar（每条/每节的验收性要求） */
  quality: string;
  /** 大章骨架：章标题 → 该章内容要求 */
  chapters: Array<{ title: string; requires: string }>;
}

const REQ_29148 = 'ISO/IEC/IEEE 29148 需求工程';

const CRD_TEMPLATE: DocTemplate = {
  standard: REQ_29148,
  quality: '每条需求：单一职责、无歧义、可验证（附明确验收要点）、可追踪（承接来源 R-nnn）；只写"要什么"，不写实现方案。',
  chapters: [
    { title: '一、背景与目标', requires: '业务背景与问题定义、目标与成功度量、范围与排除项、目标读者' },
    { title: '二、干系人与使用场景', requires: '角色/用户画像、核心使用场景（前置条件→主流程→后置结果）' },
    { title: '三、功能需求', requires: 'CR-nnn 条目：需求描述+验收要点+承接来源；按场景分组排列' },
    { title: '四、非功能需求', requires: '性能/兼容性/可用性/安全的**量化**指标与验收条件（可测量，不写"尽量/较快"）' },
    { title: '五、约束与假设', requires: '技术约束、业务约束、外部依赖与前提假设' },
    { title: '六、术语表', requires: '领域术语与缩写的权威定义' },
  ],
};

const PRD_TEMPLATE: DocTemplate = {
  standard: REQ_29148,
  quality: '每条 REQ：可追踪至上游 CR（承接锚点）、可验收（条件+预期结果）、规则间无冲突；版本与定稿态如实标注。',
  chapters: [
    { title: '一、文档依据与产品目标', requires: '上游基线（CRD 版本与定稿态）、产品目标与度量指标' },
    { title: '二、范围与角色', requires: '功能范围与排除项、用户角色与权限边界' },
    { title: '三、功能需求', requires: 'REQ-nnn 条目：需求描述+规则细节（边界/异常）+验收要点+承接 CR-nnn' },
    { title: '四、非功能需求', requires: '性能/兼容性/可用性/安全的量化验收条件（测试环境+样本+指标）' },
    { title: '五、界面与交互要求', requires: '布局结构、状态呈现（空/加载/错误/禁用）、异常提示口径' },
    { title: '六、术语与引用', requires: '术语定义与引用文档清单' },
  ],
};

const HLD_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述',
  quality: '每个架构决策给理由（ADR 式：背景→选项→结论）；关注点与视图对应；接口/数据/部署能落地到详细设计。',
  chapters: [
    { title: '一、架构目标与约束', requires: '驱动因素（业务/质量目标）、技术约束、关键干系人关注点' },
    { title: '二、总体架构', requires: '分层/组件结构与职责边界、技术选型及 ADR（每个选型给理由）' },
    { title: '三、架构视图', requires: '逻辑视图（模块关系）、进程/并发视图、部署视图（节点与拓扑）' },
    { title: '四、关键机制', requires: '横切机制：事务/并发/缓存/安全/审计的设计决策' },
    { title: '五、风险与权衡', requires: '主要技术风险、备选方案与取舍理由' },
    { title: '六、承接与映射', requires: '上游 REQ 条目的承接清单（显式回引 REQ-nnn）' },
  ],
};

const MOD_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·模块视图',
  quality: '模块高内聚低耦合；每个模块：单一职责、明确接口契约与数据所有权；依赖方向无环。',
  chapters: [
    { title: '一、模块划分', requires: '模块清单：职责一句话、边界、数据所有权' },
    { title: '二、依赖矩阵', requires: '模块间依赖关系与方向（禁止循环依赖）、依赖方式（调用/事件/数据）' },
    { title: '三、接口契约', requires: '模块对外接口：签名、前置/后置条件、错误语义' },
    { title: '四、承接与映射', requires: 'HLD 组件与 REQ 的承接回引' },
  ],
};

const ALG_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·行为视图',
  quality: '流程主路径+异常路径双写；状态机：状态/事件/迁移三要素齐全；边界条件与复杂度明示。',
  chapters: [
    { title: '一、核心流程', requires: '主流程步骤（编号）+ 每步输入输出；异常分支与补偿路径' },
    { title: '二、状态机清单', requires: '每个状态机：状态集、事件集、迁移表（当前态×事件→下一态+动作）' },
    { title: '三、异常路径', requires: '超时/并发/失败重试/幂等的处理策略' },
    { title: '四、复杂度与边界', requires: '时间/空间复杂度量级、边界条件（空/满/并发上限）' },
  ],
};

const CLS_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·信息视图（UML 惯例）',
  quality: '实体/值对象/聚合区分明确；不变式写在归属实体；命令与事件命名过去式/祈使式分明。',
  chapters: [
    { title: '一、核心实体', requires: '实体清单：标识、关键属性、不变式、生命周期' },
    { title: '二、值对象', requires: '值对象清单：组成、相等性、不可变约束' },
    { title: '三、关系与聚合', requires: '聚合边界、关联/组合关系（UML 类图语义的文字化表达）' },
    { title: '四、命令与事件', requires: '领域命令（祈使）与领域事件（过去式）清单及载荷' },
  ],
};

const DB_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·数据视图',
  quality: '每表：主键/外键/非空/唯一约束齐全；索引对应查询模式；append-only/审计表明确标注不可 UPDATE/DELETE。',
  chapters: [
    { title: '一、表清单', requires: '每表：用途一句话、字段（名/类型/约束）、主外键' },
    { title: '二、约束与索引', requires: '唯一/检查约束、索引清单及服务的查询模式' },
    { title: '三、append-only 清单', requires: '不可变表（审计/事件/证据）及保留策略' },
    { title: '四、迁移策略', requires: '迁移编号规则、向前兼容与回填口径' },
  ],
};

const API_TEMPLATE: DocTemplate = {
  standard: 'OpenAPI 3.1 / REST 成熟度模型',
  quality: '端点资源语义清晰（名词复数+HTTP 动词）；错误用闭集码；写操作幂等（键或天然键）；冒号动作路由风格一致。',
  chapters: [
    { title: '一、端点总览', requires: '端点表：方法+路径+语义+权限（按资源分组）' },
    { title: '二、请求与响应模型', requires: '各端点载荷字段（名/类型/必填/约束）' },
    { title: '三、错误码使用', requires: '各端点可能的 DomainError 闭集码及触发条件' },
    { title: '四、幂等约定', requires: '写端点的幂等键语义、重试与去重行为' },
    { title: '五、版本策略', requires: '兼容性承诺与演进规则' },
  ],
};

const UI_TEMPLATE: DocTemplate = {
  standard: 'WCAG 2.2 / 设计系统惯例',
  quality: '每页：状态四态齐全（空/加载/错误/禁用）；交互有反馈；颜色用语义令牌；关键流可键盘操作。',
  chapters: [
    { title: '一、页面清单', requires: '页面/路由/职责一句话、页面间导航关系' },
    { title: '二、组件树', requires: '每页组件层级、复用组件与设计令牌（禁写死色值）' },
    { title: '三、交互与状态', requires: '每页四态设计、关键交互流与反馈（toast/modal/行内）' },
    { title: '四、可访问性', requires: '对比度、焦点可见、键盘可达、aria 语义（WCAG 2.2 AA 要点）' },
  ],
};

const NFR_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC 25010 质量模型',
  quality: '每条非功能指标：量化（数值+条件）+ 验收方法（怎么测、什么环境、样本多少）；不写"高性能/易用"这类空话。',
  chapters: [
    { title: '一、性能效率', requires: '响应时间/吞吐/资源占用的量化指标与测试条件' },
    { title: '二、兼容性', requires: '浏览器/设备/环境矩阵及每格的验收口径' },
    { title: '三、可靠性与可用性', requires: '故障恢复、数据不丢不错、可用性目标' },
    { title: '四、安全性', requires: '认证/授权/数据保护/注入防护基线' },
    { title: '五、可维护性与可移植性', requires: '可测试性/可修改性/部署环境要求' },
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

/** 生成 prompt 注入块：默认模板骨架+质量 bar+「用户模板优先」声明（参考资料注入在模板块之后，模型自然以用户模板为准） */
export function buildTemplateGuide(domain: 'req' | 'design', kind: string): string {
  const t = domain === 'req' ? (kind === 'crd' ? CRD_TEMPLATE : PRD_TEMPLATE) : BOOK_TEMPLATES[kind];
  if (!t) return '';
  const codeRule = domain === 'req'
    ? reqSectionRule(kind as 'crd' | 'prd')
    // DSG_BOOK_LETTER 是大写（RTM 册级锚 DSG-H），chapter_prefix 是小写（h-*）——同一组字母两种规格形态
    : designSectionRule((DSG_BOOK_LETTER[kind] ?? kind).toLowerCase());
  return [
    `【默认文档模板（依据 ${t.standard}）】`,
    `质量要求：${t.quality}`,
    `结构（大章⇢内容要求）：`,
    ...t.chapters.map((c) => `- ${c.title}：${c.requires}`),
    `编号与锚点格式：${CHAPTER_RULE}${codeRule}`,
    '若参考资料中包含用户提供的模板/格式规范类文档，以其结构与要求为准（用户模板优先）；否则按以上默认模板生成。',
  ].join('\n');
}

/** 测试/校验用：模板注册表直出（防某类文档漏模板） */
export function listTemplates(): Record<string, DocTemplate> {
  return { crd: CRD_TEMPLATE, prd: PRD_TEMPLATE, ...BOOK_TEMPLATES };
}
