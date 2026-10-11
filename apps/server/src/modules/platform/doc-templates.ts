import { query } from '../../db/pool.js';
import { CHAPTER_RULE, designSectionRule, reqSectionRule } from './doc-conventions.js';
import { DSG_BOOK_LETTER } from './rtm-health.js';

/**
 * 默认文档模板库（2026-10-06 用户拍板：每种文档一份默认模板参考；默认的也要很专业。
 *  2026-10-11 深度升级：实产旧册与模板普遍不对版且模板只有大章级骨架——逐册升级为
 *  「小节骨架建议+形态要求+篇幅量级+验收口径」复合粒度 requires（80~150 字/章）+ antiPatterns
 *  负面样例；设计五册引入 IEEE 1016（SDD 分解/依赖/行为/信息视图惯例）实质参照）。
 *
 * 【管理纪律】本模块是默认模板的**唯一权威落点**：修改走 git 评审 + 标准映射测试（doc-templates.test.ts）
 * + check-codes 闸；界面只读呈现（📄 模板钮）。项目级自定义不走本模块——用户把公司模板传资料并挂为参考，
 * 「用户模板优先」声明使生成链以用户模板为准。设置页模板编辑器=套件机制（2026-10-07 起）。
 *
 * 【与 doc-conventions 的分工】conventions 管「格式」（大章形态、锚点码）；templates 管「内容」
 * （大章骨架、每章写什么、编写规则、质量 bar）。标准映射：CRD/PRD=ISO/IEC/IEEE 29148、
 * HLD/MOD/ALG/CLS/DB=ISO/IEC/IEEE 42010 + IEEE 1016、API=OpenAPI 3.1、UI=WCAG 2.2、NFR=ISO/IEC 25010。
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
  /** 负面样例（2026-10-11）：本册禁写什么——越界内容/常见废条形态，生成与评审同口径拦截 */
  antiPatterns?: string[];
  /** 大章骨架：章标题 → 该章内容要求（小节骨架建议+形态要求+篇幅量级+验收口径复合粒度） */
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
  antiPatterns: [
    '禁写技术方案/架构选型/框架名（属设计域，CRD 只表达客户要什么）',
    '禁写界面布局与样式细节（属 UI 册，CRD 至多写「提供XX入口」级能力要求）',
    '禁写无出处需求：每条 CR 必须有 R-nnn 承接来源，拍脑袋条目即废条',
    '禁把不可验证措辞当验收要点（「响应较快」「尽量稳定」无数值条件即废条）',
  ],
  chapters: [
    { title: '一、背景与目标', requires: '小节建议：业务背景（现状痛点+量化影响）/目标指标/范围与排除/目标读者。形态：目标用指标表（指标/基线值/目标值/度量时点）。篇幅 1~2 页量级。验收口径：每个目标可量化复核；任一需求能据此明确判定在不在范围内' },
    { title: '二、干系人与使用场景', requires: '小节建议：角色清单/核心场景。形态：角色表（角色/职责/诉求/约束）+ 场景按 UC-n 编号步骤写（前置条件→主流程→后置结果），异常入口单列。验收口径：第三章每条 CR 能回挂至少一个 UC；每个 UC 主流程可逐步 walkthrough 无断点' },
    { title: '三、功能需求', requires: 'CR-nnn 条目节（一节一条），每条=需求描述（应/须句）+验收要点（给定条件→操作→可观察结果）+承接来源 R-nnn。验收口径：每条单一职责、可测试、无歧义；全集覆盖第二章全部 UC 主流程与必要异常路径，无遗漏无孤儿' },
    { title: '四、非功能需求', requires: '按类别分小节（性能/兼容性/可用性/安全基线），每条=数值+条件+验收方法（怎么测、什么环境、样本量）。形态：指标清单表。验收口径：每条可直译为测试用例；「尽量/较快」类措辞零容忍' },
    { title: '五、约束与假设', requires: '两小节分写：约束（技术/业务/合规，每条注明为何不可违）+ 假设（每条注明不成立时的影响与应对方向）。形态：清单表（条目/类型/影响）。验收口径：约束可被设计册逐条回引；假设均有落空预案' },
    { title: '六、术语表', requires: '形态：术语表（术语/定义/别名或易混词辨析），按首字排序。验收口径：与下游 PRD/设计册同词同义；一词多义必须分条定义并注明适用语境；全文出现的领域术语与缩写无一遗漏，读者无需外部资料即可通读全文' },
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
  antiPatterns: [
    '禁只复述 CR 原文不加规格化（REQ 必须比 CR 多规则细节与边界，否则无存在价值）',
    '禁写实现方案（类名/表名/框架属设计册；PRD 写到「系统应……」行为级为止）',
    '禁孤儿需求：每条 REQ 须承接 CR-nnn 或显式标注「无上游承接+理由」',
    '禁模糊验收：「正常工作」「正确显示」不是验收要点，须可观察可复现',
  ],
  chapters: [
    { title: '一、文档依据与产品目标', requires: '小节建议：上游基线（CRD 版本号+定稿态）/产品目标/读者与审阅路径。形态：基线登记表（文档/版本/定稿态/日期）。篇幅 1 页量级。验收口径：上游版本与实际库内定稿版本一致；目标均可量化' },
    { title: '二、范围与角色', requires: '小节建议：功能范围与排除项/角色权限。形态：权限矩阵表（角色×能力，逐格「可/否/条件可」）。验收口径：排除项无歧义；每个角色在每章功能条目上能查到权限落点；角色×能力交集全覆盖，无未声明的隐式权限' },
    { title: '三、功能需求', requires: 'REQ-nnn 条目节（一节一条）：需求描述+规则细节（异常输入/并发/空态/权限边界逐项写全）+验收要点（条件+操作+预期）+承接 CR-nnn。验收口径：逐条覆盖上游全部 CR 零遗漏；每条可直译测试用例' },
    { title: '四、非功能需求', requires: '性能/兼容/可用/安全分小节，每条=指标+测试环境+样本量+测量方法四件套，指标用分位值不用均值。验收口径：全部可测可复现；与 NFR 册同指标同口径（不打架不重复定义，差异须显式说明并回引）' },
    { title: '五、界面与交互要求', requires: '小节建议：布局结构要求/状态呈现/异常提示。形态：每界面区域列四态要求（空/加载/错误/禁用）+提示文案口径（文案级别示例）。验收口径：每个用户可操作界面四态齐全；视觉细节留给 UI 册不越界' },
    { title: '六、数据与兼容要求', requires: '小节建议：数据格式与持久化要求/外部系统接口约束/迁移与兼容要求。形态：约束清单（条目/口径/验收方式）。验收口径：外部接口约束含协议级要求但不定字段级设计（属 API 册）' },
    { title: '七、术语与引用', requires: '形态：术语表（与 CRD 术语表一致性口径，差异须显式说明）+引用文档清单表（文档名/版本号/定稿态/获取路径）。验收口径：引用全部可定位到具体版本；术语与上游零冲突，新增术语注明确立理由' },
  ],
};

const HLD_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述（关注点-视图框架）+ IEEE 1016 软件设计描述（SDD 分解/依赖视图参照）',
  quality: '每个架构决策可追溯理由（ADR）；每个干系人关注点有对应视图；接口/数据/部署能直接落地到详细设计。',
  writingRules: [
    '每个架构决策按 ADR 记录：背景→备选（≥2）→结论→后果；不给理由的选型不算决策',
    '视图与关注点一一对应（逻辑/进程/部署/数据），不以一张"架构图"代替视图',
    '质量目标回链 NFR 册指标；上游 REQ 承接逐条显式回引',
  ],
  antiPatterns: [
    '禁一张大杂烩「架构图」配散文——视图必须按关注点分列，元素关系可指认',
    '禁只有结论没有理由的选型（「使用 Redis」无备选无后果即废条）',
    '禁写到类/函数/字段级细节（属 MOD/CLS/DB 册，HLD 停在组件与机制级）',
    '禁组件职责重叠或无人认领的横切机制（每个机制必须落到责任组件）',
  ],
  chapters: [
    { title: '一、架构目标与约束', requires: '小节建议：架构驱动因素（业务目标/质量场景/技术约束三类分列）/干系人关注点/系统上下文。形态：关注点表（关注点/干系人/落点章节）。验收口径：每个关注点能在第三~五章找到对应落点；边界内外职责无灰区' },
    { title: '二、总体架构', requires: '小节建议：组件划分（h-n 编号，每组件：职责一句话+边界+数据所有权）/技术选型。形态：组件清单表+ADR 表（决策/背景/备选≥2/结论/后果）。篇幅 2~3 页量级。验收口径：组件职责零重叠；ADR 无「无理由选型」' },
    { title: '三、架构视图', requires: '四个小节各一视图：逻辑（模块关系与职责）/进程（进程、并发、通信）/部署（节点、拓扑、网络）/数据（核心数据流）。形态：每视图=元素清单+关系说明+关键路径逐步描述。验收口径：视图元素与第二章组件清单一一对应，不多不少' },
    { title: '四、关键机制', requires: '横切机制逐项分小节（事务/并发/缓存/安全/审计/错误处理）：每项写机制级方案（怎么做+为什么+失败兜底）+责任组件。验收口径：每项可落到 MOD 册模块与 DB/API 册条目；原则口号（「保证高可用」）不算机制' },
    { title: '五、风险与权衡', requires: '形态：风险登记表（风险/影响/概率/缓解措施/责任角色）+权衡记录（取舍点/被放弃方案/放弃理由）。验收口径：高风险项均有可执行缓解；关键权衡的备选方案与取舍理由并存' },
    { title: '六、承接与映射', requires: '形态：REQ→架构元素映射表（REQ-nnn→组件/机制编号）。验收口径：上游 REQ 零遗漏；无 REQ 承接的架构元素显式说明存在理由（如基础设施性），防镀金' },
  ],
};

const MOD_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·模块视图 + IEEE 1016（分解视图/依赖关系描述惯例）',
  quality: '模块高内聚低耦合；依赖方向无环；每个接口契约可直接评审实现符合性。',
  writingRules: [
    '每个模块单一职责一句话可述；职责说不清的模块必须拆分或合并',
    '依赖只许单向；调用/事件/数据三种依赖方式分别标注',
    '接口契约=签名+前置条件+后置条件+错误语义，四件套缺一不可',
  ],
  antiPatterns: [
    '禁散文式模块介绍——模块清单必须表格化，职责/边界/数据所有权逐列可核对',
    '禁隐式依赖（「内部使用」不登记）：全部依赖进矩阵，调用/事件/数据三类分列',
    '禁接口只写方法名：无前置/后置/错误语义的「契约」不算契约',
    '禁越界写字段级表结构（属 DB 册）与流程步骤级细节（属 ALG 册）',
  ],
  chapters: [
    { title: '一、模块划分', requires: '形态：模块清单表（模块/职责一句话/边界（不做什么）/数据所有权（哪些表与状态归它管））。验收口径：每个模块单一职责可述；全部模块并集覆盖 HLD 组件清单，无三不管地带' },
    { title: '二、依赖矩阵', requires: '形态：模块×模块依赖矩阵表，每格标注方式（调用/事件/数据）+方向。验收口径：显式声明无循环依赖并给出分层方向。验收口径补：与第一章数据所有权一致（不依赖他模块私有数据）；任一依赖能被追问出存在的理由' },
    { title: '三、接口契约', requires: '每模块对外接口逐条：签名（入参/出参类型级）+前置条件+后置条件+错误语义（对应错误码或异常形态）。形态：接口条目节或契约表。验收口径：四件套齐全；错误语义与 API 册错误码闭集一致' },
    { title: '四、模块内部结构', requires: '每模块关键类/函数的职责划分（指引级：谁负责什么，不写实现）。篇幅每模块半页量级。验收口径：给 LLD/实现留落笔空间但不留职责空白；与 CLS 册实体归口一致' },
    { title: '五、承接与映射', requires: '形态：HLD 组件→本册模块映射表+相关 REQ 回引清单（逐条 REQ-nnn→承载模块）。验收口径：HLD 组件零遗漏；每个模块能回答「为哪些 REQ 存在」，答不出的模块即镀金嫌疑' },
  ],
};

const ALG_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·行为视图 + IEEE 1016（处理逻辑/状态描述惯例）',
  quality: '主流程与异常路径双写；状态机可机械校验（迁移表完备）；边界条件逐条列出可转测试。',
  writingRules: [
    '流程按编号步骤写（每步：动作+输入+输出），禁止散文式流程',
    '状态机三要素齐全：状态集、事件集、迁移表（当前态×事件→下一态+动作）；非法/不可达迁移显式标注',
    '每个算法给时间/空间复杂度量级；边界条件（空/满/并发上限）逐条列出',
  ],
  antiPatterns: [
    '禁散文叙事流程（「然后系统会处理……」）：一切流程编号步骤化，逐步可指认',
    '禁只写主流程晴天路径：异常分支与补偿回退必须与主流程同章并存',
    '禁状态机只画状态不写迁移表：当前态×事件全组合必须有定义或显式标非法',
    '禁把界面交互步骤当算法流程（UI 操作流属 UI 册；此处写系统行为逻辑）',
  ],
  chapters: [
    { title: '一、核心流程', requires: '形态：编号步骤表（步骤号/动作/输入/输出），异常分支标注「失败回退到步骤 N」。验收口径：主流程逐步可走通；每个失败点有明确补偿路径；步骤粒度到「一个动作一个输出」' },
    { title: '二、状态机清单', requires: '每个状态机一小节：状态集+事件集+迁移表（当前态×事件→下一态+动作），初始/终止状态标注，非法迁移显式列出。验收口径：迁移表覆盖全组合；与 CLS 册实体生命周期状态同名同义' },
    { title: '三、异常路径', requires: '形态：场景-策略表（超时/并发冲突/失败重试/幂等保证逐场景：触发条件→处理策略→用户可见结果）。验收口径：每场景可直译测试用例；重试策略含次数/间隔/终止条件三要素' },
    { title: '四、复杂度与边界', requires: '每算法：时间/空间复杂度量级+边界条件清单（空输入/最大值/并发上限各自行为）。形态：边界表（条件/行为/验收方式）。验收口径：边界行为全部可测；复杂度量级有依据（数据规模假设写明）' },
  ],
};

const CLS_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·信息视图 + IEEE 1016（数据实体描述惯例，UML 表达）',
  quality: '实体/值对象/聚合三分明确；不变式归口到拥有者；命令与事件构成完整领域语言。',
  writingRules: [
    '实体（有标识）与值对象（无标识）不得混用；不变式写在拥有它的实体下',
    '关系标明多重性（1:1/1:N/M:N）与级联规则；聚合边界内才允许事务一致性',
    '命令用祈使式（CreateX）、事件用过去式（XCreated）；载荷逐字段列出',
  ],
  antiPatterns: [
    '禁贫血模型罗列——实体必须带不变式与生命周期，只写字段清单即数据库表抄录',
    '禁实体值对象混用（把无标识属性组当实体建 ID，或给实体漏标识）',
    '禁跨聚合嵌套引用对象图：跨聚合只许标识引用，事务一致性不出聚合边界',
    '禁命令事件命名失范（祈使式/过去式纪律是全册领域语言一致性的前提）',
  ],
  chapters: [
    { title: '一、核心实体', requires: '每实体一小节：标识（主键语义）/关键属性（名/类型/含义）/不变式（必须恒真的规则）/生命周期状态（与 ALG 册状态机对应）。验收口径：不变式逐条可校验；生命周期与 ALG 迁移表状态集一致' },
    { title: '二、值对象', requires: '形态：值对象清单表（值对象/组成字段/相等性规则/不可变约束）。验收口径：与实体零混用；相等性规则明确（按全字段还是按业务键）；每个值对象注明被哪些实体或命令载荷使用' },
    { title: '三、关系与聚合', requires: '形态：聚合清单（聚合根/包含实体/边界理由）+关系表（两端/多重性 1:1/1:N/M:N/级联规则/跨聚合引用方式）。验收口径：级联删除无歧义；跨聚合一律标识引用' },
    { title: '四、命令与事件', requires: '形态：命令表（祈使式命名/载荷字段/产生时机/校验规则）+事件表（过去式命名/载荷/产生时机/消费者）。验收口径：领域语言完整覆盖核心流程每步；事件消费者与 MOD 册模块对应' },
  ],
};

const DB_TEMPLATE: DocTemplate = {
  standard: 'ISO/IEC/IEEE 42010 架构描述·数据视图 + IEEE 1016（数据结构设计描述惯例）',
  quality: '约束进库（不靠应用层自觉）；索引全部对应实际查询模式；不可变表有明确的禁改删与保留口径。',
  writingRules: [
    '每表：主键+创建/审计列；外键关系与删除行为（CASCADE/NO ACTION）显式声明',
    '每个索引注明服务的查询模式；无查询模式支撑的索引不建',
    'append-only 表（审计/事件/证据）显式标注：禁 UPDATE/DELETE、保留策略',
    '迁移纪律：只加不改（加列可空化）、编号递增、可重放',
  ],
  antiPatterns: [
    '禁只贴建表 SQL 不写设计理由——每表须有用途、约束理由、查询模式说明',
    '禁把校验全推给应用层：唯一/非空/检查约束凡能进库必须进库',
    '禁无查询模式支撑的「以防万一」索引（写入放大无收益）',
    '禁界面字段直译表字段（UI 呈现属 UI 册；表结构按数据语义建模）',
  ],
  chapters: [
    { title: '一、表清单', requires: '每表一小节：用途一句话+字段表（名/类型/约束/含义）+主键与外键（删除行为 CASCADE/NO ACTION 显式）。验收口径：表集与 CLS 册实体/聚合对应；每字段含义无自解释省略' },
    { title: '二、约束与索引', requires: '形态：约束清单（表/约束类型/规则/理由）+索引⇢查询模式映射表（索引/字段/服务的查询/预期选择性）。验收口径：每个索引能指认具体查询场景；约束全部可执行 DDL 化' },
    { title: '三、append-only 清单', requires: '形态：不可变表登记表（表/禁改删口径/保留策略/完整性机制（如哈希链））。验收口径：审计/事件/证据类表全部在册无遗漏；保留策略含期限与归档方式；完整性机制可被独立校验脚本复核' },
    { title: '四、迁移策略', requires: '小节建议：迁移编号规则/向前兼容口径（只加不改、加列可空化）/历史数据回填规则。验收口径：任意两版本间迁移可重放且幂等；回填规则含失败回退口径；破坏性变更须声明停机窗与回滚方案' },
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
  antiPatterns: [
    '禁动词式资源路径（/getUser）：资源名词+HTTP 动词语义，域内动作走 :action 路由',
    '禁新造错误码：一切失败落 DomainError 闭集码，触发条件逐码写清',
    '禁写端点无幂等口径（重复提交/重试/双击的行为必须逐端点定义）',
    '禁只有字段表没有调用示例：写端点必须有 curl 级可执行示例',
  ],
  chapters: [
    { title: '一、端点总览', requires: '形态：端点总表（方法/路径/语义一句话/权限/幂等性），按资源分组。验收口径：与 MOD 册对外接口契约一一对应；权限与 PRD 角色矩阵一致；SSE/长连接端点显式标注流式属性' },
    { title: '二、请求与响应模型', requires: '各端点载荷字段表（名/类型/必填/约束/示例）+写端点 curl 级调用示例（含 Idempotency-Key 头与典型响应）。验收口径：示例可直接执行；字段约束（长度/枚举/格式）无省略' },
    { title: '三、错误码使用', requires: '形态：端点×闭集码×触发条件表。验收口径：全部错误码命中 DomainError 注册表零新造；每码触发条件明确到可构造测试用例；用户可见错误文案口径与 UI 册异常提示一致' },
    { title: '四、幂等约定', requires: '写端点逐个：幂等键语义（Idempotency-Key 或天然键）/重试行为/冲突（409）语义。形态：幂等约定表。验收口径：重复提交/超时重试/并发双写三场景行为逐端点有定义' },
    { title: '五、版本策略', requires: '小节建议：兼容性承诺/演进规则（只加不改）/废弃流程（公告期-灰度-下线）。验收口径：破坏性变更判定清单明确（改类型/删字段/改语义皆破坏性）；废弃流程各阶段时长与通知方式可执行' },
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
  antiPatterns: [
    '禁写死色值/字号像素值（一切走语义令牌 var()；写死即撞车温床）',
    '禁只有正常态截图式描述：空/加载/错误/禁用四态缺一即不合格',
    '禁「点击按钮完成操作」式交互描述：反馈方式/耗时预期/失败后果必须写明',
    '禁业务规则越界（权限判定逻辑属 PRD/MOD；UI 册只写呈现与交互行为）',
  ],
  chapters: [
    { title: '一、页面清单', requires: '形态：页面表（页面/路由/职责一句话/入口与直达参数）。验收口径：页面间导航关系可沿表走通无死胡同；与 PRD 界面要求逐条对应；弹窗/抽屉等非页面容器单独列小节登记' },
    { title: '二、组件树', requires: '每页组件层级（缩进树或表）+复用组件清单+引用的设计令牌清单（色/距/字号全部 var() 令牌名）。验收口径：复用组件跨页同名同义；令牌引用零写死值；新增组件注明不复用既有组件的理由' },
    { title: '三、交互与状态', requires: '每页：四态表（空/加载/错误/禁用各自呈现+恢复路径）+关键交互流步进（步骤/用户动作/系统反馈方式 toast|行内|modal）+异常交互（断网/冲突/超时）。验收口径：四态零缺；反馈方式三选一显式注明' },
    { title: '四、可访问性', requires: '形态：WCAG 2.2 AA 逐条核对表（条款/落实方式/验证方法）——对比度 ≥4.5:1、键盘可达、焦点管理、语义标签逐项给落点。验收口径：每条可执行验证（工具或手法写明）；关键任务流纯键盘可走通' },
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
  antiPatterns: [
    '禁均值指标（「平均响应 100ms」无分位无分布即不可验收）',
    '禁绝对化表述无口径（「100% 可用」「零数据丢失」必须给度量窗与统计口径）',
    '禁无测量方法的指标（数值再漂亮，不知道怎么测即废条）',
    '禁与 PRD 非功能章同指标不同值（同口径指标以 NFR 为准并互相回引）',
  ],
  chapters: [
    { title: '一、性能效率', requires: '按 25010 子特性分行（时间行为/资源利用/容量）：每条=分位值指标+测试条件（环境/数据量/并发/时长）+测量方法（工具/样本量/阈值）。形态：特性-子特性映射表。验收口径：全部可复现测量' },
    { title: '二、兼容性', requires: '形态：环境矩阵（浏览器/设备/OS 版本×支持口径），每格标「全功能/降级（写明降级内容）/不支持」。验收口径：矩阵每格有验收方式与责任阶段；降级路径有用户可见提示口径，不静默失效' },
    { title: '三、可靠性与可用性', requires: '25010 子特性（成熟性/容错性/可恢复性）逐条：故障恢复目标（RTO/RPO 量级）+数据不丢不错口径+可用性目标（百分比+度量窗）。验收口径：每条含故障注入或演练验证方法' },
    { title: '四、安全性', requires: '25010 子特性分行（保密性/完整性/抗抵赖/可核查性/真实性）：认证授权模型、传输与存储保护、注入/XSS/越权基线、审计留痕要求。验收口径：每条给验证方式（渗透项/检查单/审计查询）' },
    { title: '五、可维护性与可移植性', requires: '25010 子特性（可测试性/可修改性/适应性/可安装性）：覆盖率门槛、模块替换成本量级、部署与迁移要求。形态：指标表（指标/门槛/验收阶段/证据形式）。验收口径：每条标注验收责任阶段' },
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

/** 生成 prompt 注入块：默认模板骨架+编写规则+质量 bar+负面样例+「骨架钉死/用户模板优先」声明
 * （参考资料注入在模板块之后，模型自然以用户模板为准）。
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
    ...(t.antiPatterns?.length ? [`负面样例（禁止）：`, ...t.antiPatterns.map((r) => `- ${r}`)] : []),
    `结构（大章⇢内容要求）：`,
    ...t.chapters.map((c) => `- ${c.title}：${c.requires}`),
    `编号与锚点格式：${CHAPTER_RULE}${codeRule}`,
    // 2026-10-11 骨架钉死：消解 CHAPTER_RULE「按内容归类大章」与固定骨架的并存冲突——
    // conventions 管格式、templates 管内容划分；整篇生成/重写时大章划分以模板为准
    '**大章必须严格采用上方骨架的划分与顺序，不得自行归章、合并或新增大章**（章内小节可按内容组织）。',
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
let bindings = new Map<string, string>();                   // projectId → setId（项目级套件绑定）
let kindBindings = new Map<string, string>();               // `${projectId}:${kind}` → setId（文档类别级指定，0028）

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
    const kb = await query<{ project_id: string; kind: string; set_id: string }>('SELECT project_id, kind, set_id FROM prj_template_kind_binding');
    kindBindings = new Map(kb.rows.map((x) => [`${x.project_id}:${x.kind}`, x.set_id]));
  } catch { /* 读取失败保留现状（不阻断生成链） */ }
}

/** kind 解析三级链（2026-10-07）：项目×类别指定 → 项目绑定套件条目 → 代码默认（自定义 kind 无默认→undefined） */
export function resolveTemplate(domain: 'req' | 'design', kind: string, projectId?: string): DocTemplate | undefined {
  if (projectId) {
    const kindSet = kindBindings.get(`${projectId}:${kind}`);
    const kindItem = kindSet ? setItems.get(kindSet)?.get(kind) : undefined;
    if (kindItem) return kindItem;
    const setId = bindings.get(projectId);
    const item = setId ? setItems.get(setId)?.get(kind) : undefined;
    if (item) return item;
  }
  return codeDefaultTemplate(kind);
}

/** 该 kind 当前生效来源（📄 模板弹窗「模板来源」显示用）：'kind'=类别级指定 / 'set'=项目套件 / 'default'=系统默认 */
export function templateSourceOf(projectId: string, kind: string): { source: 'kind' | 'set' | 'default'; setId: string | null } {
  const kindSet = kindBindings.get(`${projectId}:${kind}`);
  if (kindSet && setItems.get(kindSet)?.has(kind)) return { source: 'kind', setId: kindSet };
  const setId = bindings.get(projectId) ?? null;
  if (setId && setItems.get(setId)?.has(kind)) return { source: 'set', setId };
  return { source: 'default', setId: null };
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
 *  antiPatterns 可选不强制（有则每条 ≥10 字）。
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
  (t.antiPatterns ?? []).forEach((r, i) => { if ((r ?? '').trim().length < 10) problems.push(`负面样例第 ${i + 1} 条过短（≥10 字）`); });
  const chapters = t.chapters ?? [];
  if (chapters.length < 4) problems.push(`大章至少 4 章（当前 ${chapters.length} 章）`);
  chapters.forEach((c, i) => {
    if (!/^[一二三四五六七八九十]+、/.test(c.title ?? '')) problems.push(`第 ${i + 1} 章标题须中文数字+顿号（如「一、背景与目标」）`);
    if ((c.requires ?? '').trim().length < 20) problems.push(`第 ${i + 1} 章内容要求过短（≥20 字，写到可验收粒度）`);
  });
  return problems;
}
