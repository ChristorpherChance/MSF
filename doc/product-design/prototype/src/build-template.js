/* 独立构建实现维护源。固定示例任务实现；不在运行时从验收期望生成实际内容。 */
/* V19_CUSTOMER_KERNEL_START */
function createCustomerStateKernel() {
  var PAIRS = {
    'draft/draft': { actions: ['edit', 'submit-review'], transitions: [null, 'edit'] },
    'draft/returned': { actions: ['edit', 'submit-review'], transitions: ['return'] },
    'review/submitted': { actions: ['approve', 'return'], transitions: ['submit-review'] },
    'review/pending-publish': { actions: ['publish', 'archive'], transitions: ['approve', 'unpublish'] },
    'published/published': { actions: ['unpublish', 'archive'], transitions: ['publish'] },
    'archived/archived': { actions: [], transitions: ['archive'] }
  };
  var ACTOR_BY_ACTION = {
    edit: 'editor',
    'submit-review': 'editor',
    approve: 'reviewer',
    return: 'reviewer',
    publish: 'publisher',
    unpublish: 'publisher',
    archive: 'publisher'
  };
  var TARGET_BY_ACTION = {
    edit: { status: 'draft', workflowView: 'draft' },
    'submit-review': { status: 'review', workflowView: 'submitted' },
    approve: { status: 'review', workflowView: 'pending-publish' },
    return: { status: 'draft', workflowView: 'returned' },
    publish: { status: 'published', workflowView: 'published', publicProjection: 'published' },
    unpublish: { status: 'review', workflowView: 'pending-publish', publicProjection: 'unpublished' },
    archive: { status: 'archived', workflowView: 'archived', publicProjection: 'archived' }
  };
  var SERVICE_ACTION_BY_UI_COMMAND = {
    'switch-lang-pair-language': 'edit',
    'add-content-block': 'edit',
    'save-draft-with-revision': 'edit',
    'submit-content-review': 'submit-review',
    'approve-for-publish': 'approve',
    'return-to-draft': 'return',
    'publish-with-preflight': 'publish',
    'unpublish-content': 'unpublish',
    'archive-content': 'archive'
  };

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
      var result = {};
      Object.keys(value).forEach(function (key) { result[key] = clone(value[key]); });
      return result;
    }
    return value;
  }

  function initial() {
    return { status: 'draft', workflowView: 'draft', allowedActions: ['edit', 'submit-review'], lastTransition: null };
  }

  function validate(content) {
    var issues = [];
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return { ok: false, issues: ['CONTENT_OBJECT_REQUIRED'] };
    }
    var pairKey = content.status + '/' + content.workflowView;
    var pair = PAIRS[pairKey];
    if (!pair) issues.push('UNKNOWN_STATUS_WORKFLOW_PAIR');

    if (!Array.isArray(content.allowedActions)) {
      issues.push('ALLOWED_ACTIONS_ARRAY_REQUIRED');
    } else if (pair) {
      var exact = content.allowedActions.length === pair.actions.length && pair.actions.every(function (action, index) {
        return content.allowedActions[index] === action;
      });
      if (!exact) issues.push('ALLOWED_ACTIONS_MISMATCH');
    }

    var record = content.lastTransition;
    if (record === null) {
      if (!pair || pair.transitions.indexOf(null) < 0) issues.push('LAST_TRANSITION_REQUIRED');
    } else if (!record || typeof record !== 'object' || Array.isArray(record)) {
      issues.push('LAST_TRANSITION_OBJECT_REQUIRED');
    } else {
      var keys = Object.keys(record);
      if (keys.some(function (key) { return ['action', 'actorRole', 'at', 'reason'].indexOf(key) < 0; })) issues.push('LAST_TRANSITION_FIELD_UNKNOWN');
      if (!Object.prototype.hasOwnProperty.call(ACTOR_BY_ACTION, record.action)) issues.push('LAST_TRANSITION_ACTION_INVALID');
      if (typeof record.actorRole !== 'string' || ACTOR_BY_ACTION[record.action] !== record.actorRole) issues.push('LAST_TRANSITION_ACTOR_INVALID');
      if (typeof record.at !== 'string' || !record.at.trim()) issues.push('LAST_TRANSITION_AT_REQUIRED');
      if (Object.prototype.hasOwnProperty.call(record, 'reason') && typeof record.reason !== 'string') issues.push('LAST_TRANSITION_REASON_INVALID');
      if (pair && pair.transitions.indexOf(record.action) < 0) issues.push('LAST_TRANSITION_PAIR_MISMATCH');
    }
    return { ok: issues.length === 0, issues: issues };
  }

  function transition(content, action, actor, options) {
    var snapshot = clone(content);
    var issues = validate(content).issues.slice();
    var actorRole = ACTOR_BY_ACTION[action];
    if (!actorRole) issues.push('ACTION_UNKNOWN');
    if (!actor || actor.authenticated !== true || actor.domain !== 'cms' || actor.role !== actorRole) issues.push('ACTOR_NOT_AUTHORIZED');
    if (!options || typeof options.at !== 'string' || !options.at.trim()) issues.push('EVENT_TIME_REQUIRED');
    if (options && Object.prototype.hasOwnProperty.call(options, 'reason') && typeof options.reason !== 'string') issues.push('REASON_INVALID');
    if (!content || !Array.isArray(content.allowedActions) || content.allowedActions.indexOf(action) < 0) issues.push('ACTION_NOT_ALLOWED');
    if (issues.length) return { ok: false, content: snapshot, issues: issues };

    var target = TARGET_BY_ACTION[action];
    var next = clone(content);
    next.status = target.status;
    next.workflowView = target.workflowView;
    next.allowedActions = PAIRS[target.status + '/' + target.workflowView].actions.slice();
    if (Object.prototype.hasOwnProperty.call(target, 'publicProjection')) next.publicProjection = target.publicProjection;
    next.lastTransition = { action: action, actorRole: actor.role, at: options.at };
    if (Object.prototype.hasOwnProperty.call(options, 'reason')) next.lastTransition.reason = options.reason;
    var checked = validate(next);
    return checked.ok ? { ok: true, content: next, issues: [] } : { ok: false, content: snapshot, issues: checked.issues };
  }

  function serviceAction(uiCommand) {
    return Object.prototype.hasOwnProperty.call(SERVICE_ACTION_BY_UI_COMMAND, uiCommand) ? SERVICE_ACTION_BY_UI_COMMAND[uiCommand] : null;
  }

  return { initial: initial, validate: validate, transition: transition, serviceAction: serviceAction };
}
/* V19_CUSTOMER_KERNEL_END */
const V19_BUILD_IMPLEMENTATION_SPEC={
  "catalogVersion": "V1.9-draft-2",
  "project": "喀麦隆国家政务门户网站",
  "requirements": [
    {
      "id": "REQ-001",
      "title": "首页领导动态每日更新与首屏呈现",
      "uiApplicable": true,
      "sourceRefs": [
        "PRD:REQ-001",
        "SRC-001"
      ]
    },
    {
      "id": "REQ-002",
      "title": "新闻、公告、法规的双语发布、浏览与归档引导",
      "uiApplicable": true,
      "sourceRefs": [
        "PRD:REQ-002",
        "SRC-002",
        "SRC-003"
      ]
    },
    {
      "id": "REQ-003",
      "title": "护照、企业注册、税务申报的在线申请与进度查询",
      "uiApplicable": true,
      "sourceRefs": [
        "PRD:REQ-003",
        "SRC-004",
        "SRC-005",
        "SRC-014"
      ]
    },
    {
      "id": "REQ-004",
      "title": "法语/英语同源内容、协商与缺译回退",
      "uiApplicable": true,
      "sourceRefs": [
        "PRD:REQ-004",
        "SRC-006",
        "SRC-013"
      ]
    },
    {
      "id": "REQ-005",
      "title": "CMS 块编辑、审核发布与三角色治理",
      "uiApplicable": true,
      "sourceRefs": [
        "PRD:REQ-005",
        "SRC-007",
        "SRC-012",
        "SRC-013"
      ]
    },
    {
      "id": "REQ-006",
      "title": "双语全文检索与降级反馈",
      "uiApplicable": true,
      "sourceRefs": [
        "PRD:REQ-006",
        "SRC-008"
      ]
    },
    {
      "id": "REQ-007",
      "title": "开放数据目录、密钥和下载",
      "uiApplicable": true,
      "sourceRefs": [
        "PRD:REQ-007",
        "SRC-009",
        "SRC-012"
      ]
    }
  ],
  "pages": [
    {
      "id": "P-PUB-HOME",
      "title": "门户首页",
      "route": "/{lang}",
      "area": "公众门户",
      "roles": [
        "访客",
        "公民"
      ],
      "reqIds": [
        "REQ-001",
        "REQ-003",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h1",
        "hld:h3"
      ],
      "lldRefs": [
        {
          "docKey": "mod",
          "sectionId": "o0",
          "anchor": "§1 portal-web 门户前台",
          "rule": "SSR 首页、领导动态与语言协商先于内容装配"
        },
        {
          "docKey": "ui",
          "sectionId": "u0",
          "anchor": "§1 页面布局",
          "rule": "顶栏、检索、主副焦点区、三张办事卡和响应式快捷入口"
        },
        {
          "docKey": "alg",
          "sectionId": "g1",
          "anchor": "§2 双语缺译回退流程",
          "rule": "英文缺译回退法语且展示 fallback 标记"
        }
      ],
      "taskIds": [
        "T-201",
        "T-206",
        "T-211"
      ],
      "states": [
        {
          "id": "ready",
          "title": "已发布首页",
          "required": true,
          "expected": "显示当前语言导航、主新闻、当天领导动态与三项办事入口"
        },
        {
          "id": "fallback",
          "title": "缺译回退",
          "required": true,
          "expected": "显示法语内容和清晰 fallback 标记，不能显示空标题"
        },
        {
          "id": "slow",
          "title": "内容慢响应",
          "required": true,
          "expected": "800ms 内显示内容快照或骨架，并允许客户端补拉"
        },
        {
          "id": "mobile",
          "title": "窄屏布局",
          "required": true,
          "expected": "小于 768px 单栏，办事入口固定在底部且可点击"
        }
      ],
      "controls": [
        {
          "id": "language",
          "label": "FR | EN",
          "type": "language-switch",
          "expected": "切换 URL 前缀并保留当前可分享路径",
          "action": "switch-language"
        },
        {
          "id": "search",
          "label": "全文检索",
          "type": "search-input",
          "expected": "提交 2–64 字符查询至当前语言结果页",
          "action": "navigate-search",
          "targetPageId": "P-PUB-SEARCH"
        },
        {
          "id": "service-cards",
          "label": "办事入口",
          "type": "link-cards",
          "expected": "进入对应事项指南",
          "action": "navigate-service-guide",
          "targetPageId": "P-PUB-SERVICE-GUIDE"
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ]
    },
    {
      "id": "P-PUB-SECTION",
      "title": "内容栏目列表",
      "route": "/{lang}/sections/{type}?page={n}",
      "area": "公众门户",
      "roles": [
        "访客",
        "公民"
      ],
      "reqIds": [
        "REQ-002",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h1"
      ],
      "lldRefs": [
        {
          "docKey": "api",
          "sectionId": "a0",
          "anchor": "§1 协议与报文格式",
          "rule": "仅展示已发布 news/notice/regulation，保留分页与 fallback 元数据"
        },
        {
          "docKey": "ui",
          "sectionId": "u1",
          "anchor": "§2 交互细节",
          "rule": "列表骨架在 300ms 内出现，空栏目给引导文案"
        }
      ],
      "taskIds": [
        "T-203",
        "T-206"
      ],
      "states": [
        {
          "id": "loaded",
          "title": "已加载",
          "required": true,
          "expected": "仅显示当前 type 的已发布卡片，分页稳定"
        },
        {
          "id": "loading",
          "title": "加载中",
          "required": true,
          "expected": "展示列表骨架，不能白屏"
        },
        {
          "id": "empty",
          "title": "空栏目",
          "required": true,
          "expected": "显示当前语言引导文案"
        },
        {
          "id": "failed",
          "title": "读取失败",
          "required": true,
          "expected": "展示可重试反馈，不丢失栏目语境"
        }
      ],
      "controls": [
        {
          "id": "pagination",
          "label": "上一页/下一页",
          "type": "pagination",
          "expected": "保留 type、page 与语言",
          "action": "change-page"
        },
        {
          "id": "content-card",
          "label": "阅读更多",
          "type": "content-link",
          "expected": "打开同语言详情页",
          "action": "navigate-content-detail",
          "targetPageId": "P-PUB-CONTENT"
        },
        {
          "id": "retry",
          "label": "重试",
          "type": "button",
          "expected": "仅在失败时重拉当前栏目",
          "action": "reload-section"
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ],
      "proposedTaskIds": [
        "T-210"
      ]
    },
    {
      "id": "P-PUB-CONTENT",
      "title": "内容详情",
      "route": "/{lang}/contents/{id}",
      "area": "公众门户",
      "roles": [
        "访客",
        "公民"
      ],
      "reqIds": [
        "REQ-002",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h1"
      ],
      "lldRefs": [
        {
          "docKey": "api",
          "sectionId": "a0",
          "anchor": "§1 协议与报文格式",
          "rule": "详情响应为 fr/en 同源字段，缺译可回退"
        },
        {
          "docKey": "mod",
          "sectionId": "o7",
          "anchor": "§8 静态化与缓存中间件",
          "rule": "详情按内容 ID 版本化缓存"
        }
      ],
      "taskIds": [
        "T-203",
        "T-206",
        "T-202"
      ],
      "states": [
        {
          "id": "published",
          "title": "已发布详情",
          "required": true,
          "expected": "渲染正文、发布日期和当前语言版本"
        },
        {
          "id": "fallback",
          "title": "缺译详情",
          "required": true,
          "expected": "渲染法语并标明 fallback"
        },
        {
          "id": "gone",
          "title": "已归档",
          "required": true,
          "expected": "HTTP 410 时转归档引导，不渲染正文"
        }
      ],
      "controls": [
        {
          "id": "language",
          "label": "FR | EN",
          "type": "language-switch",
          "expected": "切换同一 lang_pair 的语言版本",
          "action": "switch-language"
        },
        {
          "id": "back",
          "label": "返回栏目",
          "type": "link",
          "expected": "返回原栏目及页码",
          "action": "navigate-section",
          "targetPageId": "P-PUB-SECTION"
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ]
    },
    {
      "id": "P-PUB-ARCHIVE",
      "title": "归档内容引导",
      "route": "/{lang}/contents/{id}/archived",
      "area": "公众门户",
      "roles": [
        "访客",
        "公民"
      ],
      "reqIds": [
        "REQ-002",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h1"
      ],
      "lldRefs": [
        {
          "docKey": "api",
          "sectionId": "a1",
          "anchor": "§2 状态码与错误码表",
          "rule": "归档内容直达返回 410，保留可检索元数据"
        }
      ],
      "taskIds": [
        "T-203",
        "T-202"
      ],
      "states": [
        {
          "id": "gone",
          "title": "归档引导",
          "required": true,
          "expected": "说明内容不可访问并提供栏目返回路径"
        }
      ],
      "controls": [
        {
          "id": "return-section",
          "label": "返回栏目",
          "type": "link",
          "expected": "跳回对应内容类型的栏目列表",
          "action": "navigate-section",
          "targetPageId": "P-PUB-SECTION"
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ]
    },
    {
      "id": "P-PUB-SERVICE-GUIDE",
      "title": "办事大厅与事项指南",
      "route": "/{lang}/services/{svcCode}",
      "area": "公众门户",
      "roles": [
        "访客",
        "公民"
      ],
      "reqIds": [
        "REQ-003",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h2",
        "hld:h6"
      ],
      "lldRefs": [
        {
          "docKey": "ui",
          "sectionId": "u1",
          "anchor": "§2 交互细节",
          "rule": "材料清单→填写→提交回执的向导可回退"
        },
        {
          "docKey": "api",
          "sectionId": "a0",
          "anchor": "§1 协议与报文格式",
          "rule": "事项限护照、企业注册、税务申报"
        }
      ],
      "taskIds": [
        "T-205",
        "T-204",
        "T-224"
      ],
      "states": [
        {
          "id": "available",
          "title": "事项可办理",
          "required": true,
          "expected": "显示事项说明、材料清单与开始申请入口"
        },
        {
          "id": "unavailable",
          "title": "事项未开通",
          "required": true,
          "expected": "未知 svc_code 显示“事项暂未开通”，不可创建申请"
        },
        {
          "id": "auth-needed",
          "title": "需登录",
          "required": true,
          "expected": "进入注册/登录后可安全回跳到该事项"
        }
      ],
      "controls": [
        {
          "id": "start",
          "label": "开始申请",
          "type": "primary-link",
          "expected": "已登录进入表单，未登录进入账户页并保留 returnTo",
          "action": "start-service-application",
          "targetPageId": "P-PUB-APPLICATION"
        },
        {
          "id": "requirements",
          "label": "材料清单",
          "type": "checklist",
          "expected": "显示 PDF/JPG 与各事项必交材料",
          "action": "view-service-requirements"
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ]
    },
    {
      "id": "P-PUB-APPLICATION",
      "title": "分步办事申请",
      "route": "/{lang}/services/{svcCode}/apply",
      "area": "公众门户",
      "roles": [
        "公民"
      ],
      "reqIds": [
        "REQ-003",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h2",
        "hld:h6"
      ],
      "lldRefs": [
        {
          "docKey": "ui",
          "sectionId": "u2",
          "anchor": "§3 字段校验规则与提示文案",
          "rule": "材料 PDF/JPG 且不超过 5MB，缺件就地提示"
        },
        {
          "docKey": "alg",
          "sectionId": "g0",
          "anchor": "§1 办事申请全链流程",
          "rule": "提交携带幂等键；未知适配器不能受理"
        },
        {
          "docKey": "api",
          "sectionId": "a0",
          "anchor": "§1 协议与报文格式",
          "rule": "POST /applications 返回回执号"
        }
      ],
      "taskIds": [
        "T-205",
        "T-204",
        "T-222",
        "T-224"
      ],
      "states": [
        {
          "id": "materials",
          "title": "材料步骤",
          "required": true,
          "expected": "明确显示必交材料和上传结果"
        },
        {
          "id": "details",
          "title": "填写步骤",
          "required": true,
          "expected": "已填字段可回退保留"
        },
        {
          "id": "validation",
          "title": "内联校验失败",
          "required": true,
          "expected": "在当前步骤显示缺少材料或字段错误且不调 API"
        },
        {
          "id": "submitting",
          "title": "提交中",
          "required": true,
          "expected": "防重复点击，使用同一幂等提交语义"
        },
        {
          "id": "upstream-pending",
          "title": "回执待补",
          "required": true,
          "expected": "部委熔断/上游异常时保留申请并明确标注待补"
        }
      ],
      "controls": [
        {
          "id": "back",
          "label": "上一步",
          "type": "button",
          "expected": "不丢失当前输入",
          "action": "previous-step"
        },
        {
          "id": "next",
          "label": "下一步",
          "type": "button",
          "expected": "只在当前步骤校验通过时推进",
          "action": "next-step"
        },
        {
          "id": "upload",
          "label": "上传材料",
          "type": "file-upload",
          "expected": "客户端提示类型/大小，服务端继续强制校验",
          "action": "validate-and-upload-attachment"
        },
        {
          "id": "submit",
          "label": "提交申请",
          "type": "primary-button",
          "expected": "只产生一个回执并进入回执页",
          "action": "submit-idempotent-application",
          "targetPageId": "P-PUB-RECEIPT"
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ],
      "fields": [
        {
          "id": "attachments",
          "label": "申请材料",
          "type": "file",
          "required": true,
          "maxSizeMb": 5,
          "accept": [
            "application/pdf",
            "image/jpeg"
          ],
          "sourceRef": {
            "docKey": "ui",
            "sectionId": "u2",
            "rule": "按事项清单必填，PDF/JPG ≤ 5MB"
          }
        }
      ]
    },
    {
      "id": "P-PUB-RECEIPT",
      "title": "申请提交回执",
      "route": "/{lang}/applications/{receipt}/receipt",
      "area": "公众门户",
      "roles": [
        "公民"
      ],
      "reqIds": [
        "REQ-003",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h6"
      ],
      "lldRefs": [
        {
          "docKey": "ui",
          "sectionId": "u3",
          "anchor": "§4 页面跳转逻辑",
          "rule": "回执号可复制且可进入我的申请查进度"
        },
        {
          "docKey": "db",
          "sectionId": "d0",
          "anchor": "§1 表结构",
          "rule": "receipt_no 签发后不可变"
        }
      ],
      "taskIds": [
        "T-205",
        "T-204"
      ],
      "states": [
        {
          "id": "accepted",
          "title": "已受理",
          "required": true,
          "expected": "展示服务、回执号和进度入口"
        },
        {
          "id": "pending",
          "title": "回执待补",
          "required": true,
          "expected": "展示不丢件的待补说明，仍允许查询进度"
        }
      ],
      "controls": [
        {
          "id": "copy",
          "label": "复制回执号",
          "type": "copy-button",
          "expected": "复制不可变 receipt_no 并给成功反馈",
          "action": "copy-receipt"
        },
        {
          "id": "track",
          "label": "查看进度",
          "type": "link",
          "expected": "打开该回执的进度页",
          "action": "navigate-application-status",
          "targetPageId": "P-PUB-APPLICATION-STATUS"
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ]
    },
    {
      "id": "P-PUB-APPLICATION-STATUS",
      "title": "我的申请进度",
      "route": "/{lang}/applications/{receipt}",
      "area": "公众门户",
      "roles": [
        "公民"
      ],
      "reqIds": [
        "REQ-003",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h6"
      ],
      "lldRefs": [
        {
          "docKey": "db",
          "sectionId": "d1",
          "anchor": "§2 主外键与关系",
          "rule": "仅办事网关适配层可写申请状态"
        },
        {
          "docKey": "alg",
          "sectionId": "g3",
          "anchor": "§4 熔断与对账流程",
          "rule": "语义不明进度以“办理中”兜底并进入复核"
        }
      ],
      "taskIds": [
        "T-205",
        "T-204",
        "T-217",
        "T-224"
      ],
      "states": [
        {
          "id": "pending",
          "title": "待受理",
          "required": true,
          "expected": "显示已提交且等待路由状态"
        },
        {
          "id": "processing",
          "title": "办理中",
          "required": true,
          "expected": "显示当前进度；语义不明亦使用此状态并标注"
        },
        {
          "id": "completed",
          "title": "已办结",
          "required": true,
          "expected": "显示办结结果"
        },
        {
          "id": "returned",
          "title": "退回",
          "required": true,
          "expected": "说明需要补正的可见原因或下一步"
        },
        {
          "id": "unauthorized",
          "title": "无权访问",
          "required": true,
          "expected": "他人回执不可读取，提示重新登录或返回"
        }
      ],
      "controls": [
        {
          "id": "refresh",
          "label": "刷新进度",
          "type": "button",
          "expected": "重新查询当前回执，不重提申请",
          "action": "refresh-application-status"
        },
        {
          "id": "login",
          "label": "登录",
          "type": "link",
          "expected": "会话失效时保留安全返回路径",
          "action": "authenticate-and-return",
          "targetPageId": "P-PUB-ACCOUNT"
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ]
    },
    {
      "id": "P-PUB-ACCOUNT",
      "title": "账户注册与 OTP 登录",
      "route": "/{lang}/accounts",
      "area": "公众门户",
      "roles": [
        "访客",
        "公民"
      ],
      "reqIds": [
        "REQ-003",
        "REQ-005",
        "REQ-007"
      ],
      "hldRefs": [
        "hld:h3"
      ],
      "lldRefs": [
        {
          "docKey": "ui",
          "sectionId": "u2",
          "anchor": "§3 字段校验规则与提示文案",
          "rule": "喀麦隆手机号 8 位；OTP 为 6 位"
        },
        {
          "docKey": "api",
          "sectionId": "a2",
          "anchor": "§3 鉴权方式",
          "rule": "access 2h、refresh 14d，静默续期最多一次"
        },
        {
          "docKey": "mod",
          "sectionId": "o6",
          "anchor": "§7 安全与身份中间件",
          "rule": "连续五次 OTP 失败锁定 30 分钟"
        }
      ],
      "taskIds": [
        "T-224",
        "T-220"
      ],
      "states": [
        {
          "id": "register",
          "title": "注册",
          "required": true,
          "expected": "校验手机号并发起 OTP 流程"
        },
        {
          "id": "otp",
          "title": "输入 OTP",
          "required": true,
          "expected": "仅接受 6 位数字"
        },
        {
          "id": "expired",
          "title": "OTP 过期",
          "required": true,
          "expected": "提示重新获取，不泄露验证码"
        },
        {
          "id": "locked",
          "title": "账户锁定",
          "required": true,
          "expected": "第五次失败后展示 30 分钟锁定，禁止客户端绕过"
        },
        {
          "id": "session-expired",
          "title": "会话失效",
          "required": true,
          "expected": "仅尝试一次静默续期，失败则引导重新登录"
        }
      ],
      "controls": [
        {
          "id": "phone",
          "label": "手机号",
          "type": "tel-input",
          "expected": "8 位格式校验并输出双语提示",
          "action": "validate-phone"
        },
        {
          "id": "otp",
          "label": "验证码",
          "type": "otp-input",
          "expected": "6 位数字输入",
          "action": "validate-otp"
        },
        {
          "id": "submit",
          "label": "登录/继续",
          "type": "primary-button",
          "expected": "成功后回到安全 returnTo；成功后优先返回已记录且位于允许集合的来源页面，未指定来源时使用默认办事指南；不得丢失开放数据或申请进度上下文。",
          "action": "authenticate-and-return",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "allowedReturnPageIds": [
            "P-PUB-SERVICE-GUIDE",
            "P-PUB-APPLICATION-STATUS",
            "P-PUB-OPENDATA"
          ]
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ],
      "fields": [
        {
          "id": "phone",
          "label": "手机号",
          "type": "tel",
          "required": true,
          "pattern": "^\\d{8}$",
          "sourceRef": {
            "docKey": "ui",
            "sectionId": "u2",
            "rule": "喀麦隆号段 8 位数字"
          }
        },
        {
          "id": "otp",
          "label": "OTP",
          "type": "text",
          "required": true,
          "pattern": "^\\d{6}$",
          "sourceRef": {
            "docKey": "ui",
            "sectionId": "u2",
            "rule": "OTP 6 位数字，5 次失败锁 30 分钟"
          }
        }
      ]
    },
    {
      "id": "P-PUB-SEARCH",
      "title": "双语检索结果",
      "route": "/{lang}/search?q={query}",
      "area": "公众门户",
      "roles": [
        "访客",
        "公民"
      ],
      "reqIds": [
        "REQ-006",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h1"
      ],
      "lldRefs": [
        {
          "docKey": "alg",
          "sectionId": "g2",
          "anchor": "§3 双语检索查询改写流程",
          "rule": "命中任一语种即返回同源对，并按当前语言展示"
        },
        {
          "docKey": "ui",
          "sectionId": "u2",
          "anchor": "§3 字段校验规则与提示文案",
          "rule": "查询词为 2–64 字符，空串给引导"
        }
      ],
      "taskIds": [
        "T-213",
        "T-208",
        "T-206"
      ],
      "states": [
        {
          "id": "results",
          "title": "有结果",
          "required": true,
          "expected": "显示按当前语言渲染的同源对结果"
        },
        {
          "id": "empty",
          "title": "无结果",
          "required": true,
          "expected": "显示查询建议，不能空白"
        },
        {
          "id": "lagging",
          "title": "索引滞后",
          "required": true,
          "expected": "提示结果可能不含最新发布"
        },
        {
          "id": "basic",
          "title": "基础检索模式",
          "required": true,
          "expected": "ES 不可用时标注 DB 模糊匹配降级"
        }
      ],
      "controls": [
        {
          "id": "query",
          "label": "检索词",
          "type": "search-input",
          "expected": "校验后发起当前语言查询",
          "action": "submit-search"
        },
        {
          "id": "result",
          "label": "结果条目",
          "type": "content-link",
          "expected": "进入对应详情并保留语言",
          "action": "navigate-content-detail",
          "targetPageId": "P-PUB-CONTENT"
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ],
      "fields": [
        {
          "id": "query",
          "label": "检索词",
          "type": "search",
          "required": true,
          "minLength": 2,
          "maxLength": 64,
          "sourceRef": {
            "docKey": "ui",
            "sectionId": "u2",
            "rule": "检索词 2–64 字符，空串给引导"
          }
        }
      ]
    },
    {
      "id": "P-PUB-OPENDATA",
      "title": "开放数据目录与数据集详情",
      "route": "/{lang}/opendata/{datasetId?}",
      "area": "公众门户",
      "roles": [
        "访客",
        "公民"
      ],
      "reqIds": [
        "REQ-007",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h1",
        "hld:h3"
      ],
      "lldRefs": [
        {
          "docKey": "mod",
          "sectionId": "o5",
          "anchor": "§6 检索与开放数据中间件",
          "rule": "目录为双语元数据，下载需 api_key"
        },
        {
          "docKey": "api",
          "sectionId": "a2",
          "anchor": "§3 鉴权方式",
          "rule": "api_key 具有 scopes、日配额与 60 req/min 限流"
        }
      ],
      "taskIds": [
        "T-216",
        "T-215",
        "T-224"
      ],
      "states": [
        {
          "id": "catalog",
          "title": "目录可浏览",
          "required": true,
          "expected": "显示双语数据集元数据和详情入口"
        },
        {
          "id": "key-needed",
          "title": "需密钥下载",
          "required": true,
          "expected": "无 api_key 时给出获取密钥入口而不下载"
        },
        {
          "id": "unauthorized",
          "title": "密钥无效",
          "required": true,
          "expected": "401 反馈且不暴露密钥内容"
        },
        {
          "id": "rate-limited",
          "title": "限流或配额超限",
          "required": true,
          "expected": "429 反馈说明稍后重试或配额限制"
        }
      ],
      "controls": [
        {
          "id": "dataset",
          "label": "数据集详情",
          "type": "link",
          "expected": "查看元数据与下载入口",
          "action": "navigate-dataset-detail",
          "targetPageId": "P-PUB-OPENDATA"
        },
        {
          "id": "get-key",
          "label": "获取 API 密钥",
          "type": "link",
          "expected": "已登录进入密钥签发动作",
          "action": "authenticate-for-key-issuance",
          "targetPageId": "P-PUB-ACCOUNT"
        },
        {
          "id": "download",
          "label": "下载数据集",
          "type": "download-button",
          "expected": "带 api_key 后请求下载，并给可理解的错误反馈",
          "action": "download-with-api-key"
        },
        {
          "id": "nav-home",
          "label": "首页",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-HOME",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-section",
          "label": "新闻栏目",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SECTION",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-services",
          "label": "办事指南",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-SERVICE-GUIDE",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        },
        {
          "id": "nav-opendata",
          "label": "开放数据",
          "type": "button",
          "expected": "进入对应已声明页面，保留当前语言与允许的业务上下文。",
          "action": "navigate-public-page",
          "targetPageId": "P-PUB-OPENDATA",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "统一导航和响应式入口对应已声明客户页面"
            },
            {
              "docKey": "mod",
              "sectionId": "o0",
              "rule": "门户栏目及服务模块入口"
            }
          ]
        }
      ],
      "fields": [
        {
          "id": "apiKey",
          "label": "API 密钥",
          "type": "password",
          "required": true,
          "sourceRef": {
            "docKey": "api",
            "sectionId": "a2",
            "rule": "数据集下载需 api_key，按 scopes、配额和 60 req/min 校验"
          }
        }
      ]
    },
    {
      "id": "P-CMS-LOGIN",
      "title": "CMS 工作台登录",
      "route": "/cms/login",
      "area": "CMS 后台",
      "roles": [
        "编辑",
        "审核",
        "发布"
      ],
      "reqIds": [
        "REQ-005"
      ],
      "hldRefs": [
        "hld:h3"
      ],
      "lldRefs": [
        {
          "docKey": "mod",
          "sectionId": "o6",
          "anchor": "§7 安全与身份中间件",
          "rule": "CMS 三角色能力以服务端鉴权为准"
        },
        {
          "docKey": "api",
          "sectionId": "a2",
          "anchor": "§3 鉴权方式",
          "rule": "发布操作须附带审计上下文"
        }
      ],
      "taskIds": [
        "T-220",
        "T-224",
        "T-207"
      ],
      "states": [
        {
          "id": "signed-out",
          "title": "未登录",
          "required": true,
          "expected": "显示账户入口和受保护工作台提示"
        },
        {
          "id": "denied",
          "title": "权限不足",
          "required": true,
          "expected": "无对应角色时拒绝进入，不显示越权控件"
        }
      ],
      "controls": [
        {
          "id": "sign-in",
          "label": "登录",
          "type": "auth-button",
          "expected": "成功后按角色进入 CMS 工作台",
          "action": "authenticate-cms",
          "targetPageId": "P-CMS-DASHBOARD"
        },
        {
          "id": "nav-dashboard",
          "label": "CMS工作台",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-DASHBOARD",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-editor",
          "label": "内容编辑",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-EDITOR",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-review",
          "label": "审核队列",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-REVIEW",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-publish",
          "label": "发布工作台",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-PUBLISH",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        }
      ]
    },
    {
      "id": "P-CMS-DASHBOARD",
      "title": "CMS 内容与待译工作台",
      "route": "/cms/dashboard",
      "area": "CMS 后台",
      "roles": [
        "编辑",
        "审核",
        "发布"
      ],
      "reqIds": [
        "REQ-004",
        "REQ-005"
      ],
      "hldRefs": [
        "hld:h2",
        "hld:h3"
      ],
      "lldRefs": [
        {
          "docKey": "mod",
          "sectionId": "o1",
          "anchor": "§2 cms 无头 CMS",
          "rule": "展示内容生产、流转和待译工作入口"
        },
        {
          "docKey": "mod",
          "sectionId": "o3",
          "anchor": "§4 双语内容中间件",
          "rule": "待译清单记录 lang_pair、缺失语种、栏目和挂起天数"
        }
      ],
      "taskIds": [
        "T-212",
        "T-206",
        "T-207"
      ],
      "states": [
        {
          "id": "role-filtered",
          "title": "按角色过滤",
          "required": true,
          "expected": "仅显示角色可处理的草稿、审核或发布工作"
        },
        {
          "id": "missing-translation",
          "title": "待译项目",
          "required": true,
          "expected": "显示缺失语种、栏目与挂起天数"
        },
        {
          "id": "empty",
          "title": "无待办",
          "required": true,
          "expected": "有明确空态，不伪造任务"
        }
      ],
      "controls": [
        {
          "id": "new-content",
          "label": "新建内容",
          "type": "button",
          "expected": "编辑可进入块编辑器",
          "action": "create-content-draft",
          "targetPageId": "P-CMS-EDITOR"
        },
        {
          "id": "review-queue",
          "label": "审核队列",
          "type": "link",
          "expected": "审核角色进入待审清单",
          "action": "navigate-review-queue",
          "targetPageId": "P-CMS-REVIEW"
        },
        {
          "id": "translation-item",
          "label": "待译条目",
          "type": "link",
          "expected": "进入对应 lang_pair 编辑器",
          "action": "navigate-lang-pair-editor",
          "targetPageId": "P-CMS-EDITOR"
        },
        {
          "id": "nav-dashboard",
          "label": "CMS工作台",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-DASHBOARD",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-editor",
          "label": "内容编辑",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-EDITOR",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-review",
          "label": "审核队列",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-REVIEW",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-publish",
          "label": "发布工作台",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-PUBLISH",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        }
      ]
    },
    {
      "id": "P-CMS-EDITOR",
      "title": "CMS 双语块编辑器",
      "route": "/cms/contents/{id}/edit",
      "area": "CMS 后台",
      "roles": [
        "编辑"
      ],
      "reqIds": [
        "REQ-004",
        "REQ-005"
      ],
      "hldRefs": [
        "hld:h2",
        "hld:h3"
      ],
      "lldRefs": [
        {
          "docKey": "mod",
          "sectionId": "o1",
          "anchor": "§2 cms 无头 CMS",
          "rule": "标题、段落、图片、表格、引用按注册表编辑；块级保存与整篇提交分离"
        },
        {
          "docKey": "db",
          "sectionId": "d0",
          "anchor": "§1 表结构",
          "rule": "content_blocks 按 block_no 和 block_type 持久化；同源对有唯一约束"
        },
        {
          "docKey": "alg",
          "sectionId": "g4",
          "anchor": "§5 内容发布流转流程",
          "rule": "编辑可保存草稿并提审，不能发布"
        },
        {
          "docKey": "api",
          "sectionId": "a0",
          "anchor": "§1 协议与报文格式 · CMS 工作流响应字段（V1.9 种子澄清）",
          "rule": "编辑器读取 status、workflowView、allowedActions、lastTransition；动作可见性以服务端 allowedActions 为准"
        }
      ],
      "taskIds": [
        "T-212",
        "T-221",
        "T-207"
      ],
      "states": [
        {
          "id": "draft",
          "title": "草稿编辑",
          "required": true,
          "expected": "可编辑 fr/en 同源内容和块顺序"
        },
        {
          "id": "conflict",
          "title": "并发冲突",
          "required": true,
          "expected": "旧 ETag 保存返回 409 合并提示，不能覆写新版本"
        },
        {
          "id": "validation",
          "title": "提审校验失败",
          "required": true,
          "expected": "清单化显示缺项"
        },
        {
          "id": "submitted",
          "title": "已提审",
          "required": true,
          "expected": "进入 review，编辑不能继续发布"
        }
      ],
      "controls": [
        {
          "id": "language-tabs",
          "label": "FR / EN 内容",
          "type": "tabs",
          "expected": "编辑同一 lang_pair 的两个语种",
          "action": "switch-lang-pair-language"
        },
        {
          "id": "block-add",
          "label": "添加内容块",
          "type": "block-picker",
          "expected": "支持标题、段落、图片、表格、引用",
          "action": "add-content-block"
        },
        {
          "id": "save",
          "label": "保存草稿",
          "type": "button",
          "expected": "块级保存并处理版本冲突",
          "action": "save-draft-with-revision"
        },
        {
          "id": "submit-review",
          "label": "提交审核",
          "type": "primary-button",
          "expected": "通过必填校验后转 review",
          "action": "submit-content-review",
          "targetPageId": "P-CMS-REVIEW"
        },
        {
          "id": "nav-dashboard",
          "label": "CMS工作台",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-DASHBOARD",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-editor",
          "label": "内容编辑",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-EDITOR",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-review",
          "label": "审核队列",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-REVIEW",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-publish",
          "label": "发布工作台",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-PUBLISH",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        }
      ],
      "fields": [
        {
          "id": "titleFr",
          "label": "法语标题",
          "type": "text",
          "required": true,
          "sourceRef": {
            "docKey": "db",
            "sectionId": "d0",
            "rule": "title_fr NOT NULL"
          }
        },
        {
          "id": "titleEn",
          "label": "英语标题",
          "type": "text",
          "required": false,
          "sourceRef": {
            "docKey": "db",
            "sectionId": "d0",
            "rule": "title_en 可为 NULL，缺译时 fallback"
          }
        },
        {
          "id": "imageBlock",
          "label": "图片内容块",
          "type": "file",
          "required": false,
          "sourceRef": {
            "docKey": "mod",
            "sectionId": "o1",
            "rule": "块类型注册表包含图片；未冻结 MIME 或大小限制"
          }
        }
      ]
    },
    {
      "id": "P-CMS-REVIEW",
      "title": "CMS 审核队列与差异核对",
      "route": "/cms/review",
      "area": "CMS 后台",
      "roles": [
        "审核"
      ],
      "reqIds": [
        "REQ-005",
        "REQ-004"
      ],
      "hldRefs": [
        "hld:h2",
        "hld:h3"
      ],
      "lldRefs": [
        {
          "docKey": "alg",
          "sectionId": "g4",
          "anchor": "§5 内容发布流转流程",
          "rule": "审核通过进入待发布；退回草稿；审核不可编辑正文"
        },
        {
          "docKey": "mod",
          "sectionId": "o6",
          "anchor": "§7 安全与身份中间件",
          "rule": "能力矩阵硬约束审核角色"
        },
        {
          "docKey": "api",
          "sectionId": "a0",
          "anchor": "§1 协议与报文格式 · CMS 工作流响应字段（V1.9 种子澄清）",
          "rule": "审核队列依据 workflowView 与 allowedActions 展示 approve/return，returned 必须为 status=draft 且 lastTransition.action=return"
        }
      ],
      "taskIds": [
        "T-207",
        "T-212"
      ],
      "states": [
        {
          "id": "review-queue",
          "title": "待审核",
          "required": true,
          "expected": "列出 review 状态内容与必要元数据"
        },
        {
          "id": "approved",
          "title": "审核通过",
          "required": true,
          "expected": "转为待发布，审核角色不能直接上线"
        },
        {
          "id": "returned",
          "title": "退回草稿",
          "required": true,
          "expected": "要求带可见退回意见并回到编辑处理"
        },
        {
          "id": "forbidden",
          "title": "越权编辑",
          "required": true,
          "expected": "审核角色不能修改正文"
        }
      ],
      "controls": [
        {
          "id": "compare",
          "label": "查看内容",
          "type": "read-only-detail",
          "expected": "可检查语言与元数据，不出现正文编辑控件",
          "action": "view-read-only-content"
        },
        {
          "id": "approve",
          "label": "通过",
          "type": "button",
          "expected": "转待发布",
          "action": "approve-for-publish",
          "targetPageId": "P-CMS-PUBLISH"
        },
        {
          "id": "return",
          "label": "退回",
          "type": "button",
          "expected": "填写意见后返回 draft",
          "action": "return-to-draft",
          "targetPageId": "P-CMS-EDITOR"
        },
        {
          "id": "nav-dashboard",
          "label": "CMS工作台",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-DASHBOARD",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-editor",
          "label": "内容编辑",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-EDITOR",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-review",
          "label": "审核队列",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-REVIEW",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-publish",
          "label": "发布工作台",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-PUBLISH",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        }
      ]
    },
    {
      "id": "P-CMS-PUBLISH",
      "title": "CMS 发布、下线与审计",
      "route": "/cms/publish",
      "area": "CMS 后台",
      "roles": [
        "发布"
      ],
      "reqIds": [
        "REQ-001",
        "REQ-002",
        "REQ-004",
        "REQ-005",
        "REQ-006"
      ],
      "hldRefs": [
        "hld:h2",
        "hld:h3"
      ],
      "lldRefs": [
        {
          "docKey": "alg",
          "sectionId": "g4",
          "anchor": "§5 内容发布流转流程",
          "rule": "发布前至少一语种成文且元数据完整；发布后发缓存失效与索引增量事件"
        },
        {
          "docKey": "nfr",
          "sectionId": "n2",
          "anchor": "§3 日志与异常处理规范",
          "rule": "发布/下线须完整审计；事件失败显式重投并由 TTL 兜底"
        },
        {
          "docKey": "mod",
          "sectionId": "o7",
          "anchor": "§8 静态化与缓存中间件",
          "rule": "发布/下线立即失效对应缓存 key"
        },
        {
          "docKey": "api",
          "sectionId": "a0",
          "anchor": "§1 协议与报文格式 · CMS 工作流响应字段（V1.9 种子澄清）",
          "rule": "待发布仅在 status=review、workflowView=pending-publish 且 allowedActions 含 publish 时显示；前端不得按角色推断"
        }
      ],
      "taskIds": [
        "T-207",
        "T-214",
        "T-211",
        "T-218"
      ],
      "states": [
        {
          "id": "pending-publish",
          "title": "待发布",
          "required": true,
          "expected": "仅显示审核通过的内容"
        },
        {
          "id": "preflight-failed",
          "title": "发布校验失败",
          "required": true,
          "expected": "列出缺失元数据或两语种均空等问题并阻断"
        },
        {
          "id": "published",
          "title": "已发布",
          "required": true,
          "expected": "写入 published_at，展示缓存/索引事件已提交状态"
        },
        {
          "id": "event-retry",
          "title": "下游事件重试",
          "required": true,
          "expected": "缓存或索引事件失败需显式标注重试，不能静默成功"
        },
        {
          "id": "archived",
          "title": "已归档",
          "required": true,
          "expected": "前台详情转 410 引导，元数据仍可检索"
        }
      ],
      "controls": [
        {
          "id": "publish",
          "label": "发布",
          "type": "primary-button",
          "expected": "通过前置校验、记录 actor/IP/对象/时间并触发双事件",
          "action": "publish-with-preflight"
        },
        {
          "id": "unpublish",
          "label": "下线",
          "type": "button",
          "expected": "失效前台缓存并保留审计",
          "action": "unpublish-content"
        },
        {
          "id": "archive",
          "label": "归档",
          "type": "danger-button",
          "expected": "确认后进入 archived，非破坏性保留元数据",
          "action": "archive-content"
        },
        {
          "id": "audit",
          "label": "审计记录",
          "type": "audit-link",
          "expected": "查看发布和下线的审计上下文",
          "action": "view-audit-records"
        },
        {
          "id": "nav-dashboard",
          "label": "CMS工作台",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-DASHBOARD",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-editor",
          "label": "内容编辑",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-EDITOR",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-review",
          "label": "审核队列",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-REVIEW",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        },
        {
          "id": "nav-publish",
          "label": "发布工作台",
          "type": "button",
          "expected": "真实点击须先校验当前已登录身份及目标页面所需角色；拒绝时不进入受保护页面，也不改变身份角色。",
          "action": "navigate-cms-page",
          "targetPageId": "P-CMS-PUBLISH",
          "sourceRefs": [
            {
              "docKey": "ui",
              "sectionId": "u0",
              "rule": "管理工作台导航遵守角色允许动作"
            },
            {
              "docKey": "mod",
              "sectionId": "o6",
              "rule": "导航不得绕过会话及三角色边界"
            }
          ]
        }
      ]
    }
  ],
  "flows": [
    {
      "id": "F-001",
      "title": "双语首页到内容阅读",
      "roles": [
        "访客"
      ],
      "reqIds": [
        "REQ-001",
        "REQ-002",
        "REQ-004"
      ],
      "steps": [
        {
          "pageId": "P-PUB-HOME",
          "action": "选择 EN，点击主新闻",
          "expected": "URL 为 /en 且缺译时显示 fallback"
        },
        {
          "pageId": "P-PUB-SECTION",
          "action": "浏览对应栏目并翻页",
          "expected": "仅见已发布同类型内容"
        },
        {
          "pageId": "P-PUB-CONTENT",
          "action": "打开详情",
          "expected": "显示当前语言正文或法语回退标记"
        }
      ]
    },
    {
      "id": "F-002",
      "title": "归档内容保护",
      "roles": [
        "访客"
      ],
      "reqIds": [
        "REQ-002"
      ],
      "steps": [
        {
          "pageId": "P-PUB-CONTENT",
          "action": "访问已归档内容 URL",
          "expected": "收到 410，不显示正文"
        },
        {
          "pageId": "P-PUB-ARCHIVE",
          "action": "返回栏目",
          "expected": "回到仍可阅读的已发布内容"
        }
      ]
    },
    {
      "id": "F-003",
      "title": "注册登录并提交办事申请",
      "roles": [
        "访客",
        "公民"
      ],
      "reqIds": [
        "REQ-003"
      ],
      "steps": [
        {
          "pageId": "P-PUB-SERVICE-GUIDE",
          "action": "从护照事项点击开始申请",
          "expected": "未登录转账户页并保留 returnTo"
        },
        {
          "pageId": "P-PUB-ACCOUNT",
          "action": "以有效手机号和 OTP 登录",
          "expected": "建立会话并返回事项"
        },
        {
          "pageId": "P-PUB-APPLICATION",
          "action": "上传合格材料、填写并提交",
          "expected": "生成唯一回执"
        },
        {
          "pageId": "P-PUB-RECEIPT",
          "action": "复制回执并进入进度",
          "expected": "可打开同一回执的状态页"
        }
      ]
    },
    {
      "id": "F-004",
      "title": "申请补正与状态查询",
      "roles": [
        "公民"
      ],
      "reqIds": [
        "REQ-003"
      ],
      "steps": [
        {
          "pageId": "P-PUB-APPLICATION-STATUS",
          "action": "刷新自己的回执进度",
          "expected": "显示待受理、办理中、已办结或退回之一"
        },
        {
          "pageId": "P-PUB-APPLICATION",
          "action": "材料缺失时回到当前步骤补齐",
          "expected": "内联显示必交材料名称且不发起无效提交"
        }
      ]
    },
    {
      "id": "F-005",
      "title": "双语检索降级可见",
      "roles": [
        "访客"
      ],
      "reqIds": [
        "REQ-006",
        "REQ-004"
      ],
      "steps": [
        {
          "pageId": "P-PUB-HOME",
          "action": "输入有效检索词",
          "expected": "进入当前语言检索页"
        },
        {
          "pageId": "P-PUB-SEARCH",
          "action": "查看结果或降级反馈",
          "expected": "空结果有引导；索引滞后/基础检索模式显式标注"
        },
        {
          "pageId": "P-PUB-CONTENT",
          "action": "打开结果",
          "expected": "保留语言或显示 fallback"
        }
      ]
    },
    {
      "id": "F-006",
      "title": "开放数据下载与限流反馈",
      "roles": [
        "访客",
        "公民"
      ],
      "reqIds": [
        "REQ-007"
      ],
      "steps": [
        {
          "pageId": "P-PUB-OPENDATA",
          "action": "浏览数据集并尝试下载",
          "expected": "无密钥给出获取入口"
        },
        {
          "pageId": "P-PUB-ACCOUNT",
          "action": "登录以取得账户会话",
          "expected": "安全返回数据集"
        },
        {
          "pageId": "P-PUB-OPENDATA",
          "action": "持有效密钥下载或达到配额",
          "expected": "成功下载或显示 429 限流/配额反馈"
        }
      ]
    },
    {
      "id": "F-007",
      "title": "编辑创建双语内容并提审",
      "roles": [
        "编辑"
      ],
      "reqIds": [
        "REQ-004",
        "REQ-005"
      ],
      "steps": [
        {
          "pageId": "P-CMS-LOGIN",
          "action": "以编辑角色登录",
          "expected": "进入受角色过滤的工作台"
        },
        {
          "pageId": "P-CMS-DASHBOARD",
          "action": "新建内容或打开待译条目",
          "expected": "进入同一 lang_pair 的编辑器"
        },
        {
          "pageId": "P-CMS-EDITOR",
          "action": "保存块并提交审核",
          "expected": "保存冲突给 409 合并提示；成功进入 review"
        }
      ]
    },
    {
      "id": "F-008",
      "title": "审核退回或通过",
      "roles": [
        "审核"
      ],
      "reqIds": [
        "REQ-005"
      ],
      "steps": [
        {
          "pageId": "P-CMS-LOGIN",
          "action": "以审核角色登录",
          "expected": "不可获得正文编辑权限"
        },
        {
          "pageId": "P-CMS-REVIEW",
          "action": "查看待审内容并退回或通过",
          "expected": "退回到 draft，或通过后转待发布"
        }
      ]
    },
    {
      "id": "F-009",
      "title": "发布、缓存失效、检索更新和归档",
      "roles": [
        "发布"
      ],
      "reqIds": [
        "REQ-001",
        "REQ-002",
        "REQ-004",
        "REQ-005",
        "REQ-006"
      ],
      "steps": [
        {
          "pageId": "P-CMS-LOGIN",
          "action": "以发布角色登录",
          "expected": "仅见发布待办"
        },
        {
          "pageId": "P-CMS-PUBLISH",
          "action": "执行发布",
          "expected": "通过校验后写 published_at、审计并发送缓存失效和索引事件"
        },
        {
          "pageId": "P-PUB-HOME",
          "action": "打开前台首页",
          "expected": "发布后内容可见，失败事件有显式重试而非静默"
        },
        {
          "pageId": "P-CMS-PUBLISH",
          "action": "归档内容",
          "expected": "前台详情进入 410 引导且元数据保留"
        }
      ]
    }
  ],
  "nonUiCoverage": [
    {
      "id": "NUI-001",
      "description": "首页每日 00:30 静态化重建、发布失效、CDN 刷新与 SSR 缓存命中率",
      "hldRefs": [
        "hld:h7"
      ],
      "lldRefs": [
        {
          "docKey": "mod",
          "sectionId": "o7",
          "anchor": "§8 静态化与缓存中间件",
          "rule": "TTL、键空间、失效风暴合并与失败重试"
        },
        {
          "docKey": "nfr",
          "sectionId": "n0",
          "anchor": "§1 性能设计",
          "rule": "首屏 3 秒、5000 并发和缓存预算"
        }
      ],
      "reason": "这些是服务端缓存、部署和性能门禁；前台只展示其可感知的加载/快照状态。",
      "sourceRefs": [
        "PRD:p3 §3 非功能实现方案（SSR + CDN，≤3s@4G）",
        "HLD:h7 §8 非功能指标与容量估算",
        "NFR:n0 §1 性能设计"
      ]
    },
    {
      "id": "NUI-002",
      "description": "部委适配器、10 秒超时、三次重试、熔断、回调签名和对账恢复",
      "hldRefs": [
        "hld:h6"
      ],
      "lldRefs": [
        {
          "docKey": "alg",
          "sectionId": "g0",
          "anchor": "§1 办事申请全链流程",
          "rule": "统一申请、幂等、适配器路由"
        },
        {
          "docKey": "alg",
          "sectionId": "g3",
          "anchor": "§4 熔断与对账流程",
          "rule": "半开探测、差异工单与回调幂等"
        }
      ],
      "reason": "门户承接回执待补和进度展示，但协议处理、队列和对账不能虚造为用户页面。",
      "sourceRefs": [
        "PRD:p2 §2 功能需求（REQ-003）",
        "HLD:h6 §7 关键时序（办事申请全链）",
        "ALG:g0 §1 办事申请全链流程",
        "ALG:g3 §4 熔断与对账流程"
      ]
    },
    {
      "id": "NUI-003",
      "description": "双语内容存储、同源对约束、待译统计和索引合并召回",
      "hldRefs": [
        "hld:h4",
        "hld:h5"
      ],
      "lldRefs": [
        {
          "docKey": "db",
          "sectionId": "d0",
          "anchor": "§1 表结构",
          "rule": "contents.lang_pair 与双语字段/状态约束"
        },
        {
          "docKey": "cls",
          "sectionId": "k2",
          "anchor": "§3 内部数据结构组织",
          "rule": "同源对、索引文档与待译条目结构"
        }
      ],
      "reason": "页面消费其可见结果，字段完整性和检索索引实体由数据库及中间件实现承接。",
      "sourceRefs": [
        "PRD:p2 §2 功能需求（REQ-004/REQ-006）",
        "HLD:h4 §5 数据架构概览",
        "DB:d0 §1 表结构",
        "CLS:k2 §3 内部数据结构组织"
      ]
    },
    {
      "id": "NUI-004",
      "description": "会话令牌、WAF、三域隔离、审计保留、数据主权和 API 密钥强制校验",
      "hldRefs": [
        "hld:h5",
        "hld:h7"
      ],
      "lldRefs": [
        {
          "docKey": "nfr",
          "sectionId": "n1",
          "anchor": "§2 安全设计",
          "rule": "TLS、等保三级、WAF、数据驻留与密钥限流"
        },
        {
          "docKey": "nfr",
          "sectionId": "n2",
          "anchor": "§3 日志与异常处理规范",
          "rule": "审计字段和至少 180 天保留"
        }
      ],
      "reason": "登录、权限拒绝和限流反馈属于 UI；令牌存储、WAF、网络隔离和日志留存属于后端/NFR。",
      "sourceRefs": [
        "PRD:p3 §3 非功能实现方案（等保/WAF/离线部署）",
        "HLD:h7 §8 非功能指标与容量估算",
        "NFR:n1 §2 安全设计",
        "NFR:n2 §3 日志与异常处理规范"
      ]
    },
    {
      "id": "NUI-005",
      "description": "接口版本兼容、统一 JSON 错误体、离线镜像仓和 CI 发布质量门禁",
      "hldRefs": [
        "hld:h5",
        "hld:h7"
      ],
      "lldRefs": [
        {
          "docKey": "api",
          "sectionId": "a4",
          "anchor": "§5 版本管理",
          "rule": "/api/v1 增量兼容与 Sunset 下线规则"
        },
        {
          "docKey": "nfr",
          "sectionId": "n0",
          "anchor": "§1 性能设计",
          "rule": "Lighthouse 采样阻断与容量证据"
        }
      ],
      "reason": "这是 HLD/LLD 的运行与发布契约；原型仅需由后续自测报告核验功能和 UI 符合度。",
      "sourceRefs": [
        "PRD:p3 §3 非功能实现方案",
        "HLD:h5 §6 部署拓扑",
        "HLD:h7 §8 非功能指标与容量估算",
        "API:a4 §5 版本管理",
        "NFR:n0 §1 性能设计"
      ]
    }
  ],
  "uiConformanceGate": {
    "generalVisualComplianceMin": 0.95,
    "criticalItemsMin": 1,
    "measurement": "规则符合度检查，不要求像素级相似",
    "criticalItems": [
      "角色越权控件不可见且操作被拒绝",
      "OTP 锁定与会话失效不绕过",
      "申请材料、回执和状态语义正确",
      "发布前校验、审计与前台归档 410",
      "语言回退与所有显式降级反馈"
    ]
  },
  "viewportProfiles": [
    {
      "id": "public-desktop",
      "area": "公众门户",
      "minWidth": 1024,
      "sourceRef": {
        "docKey": "ui",
        "sectionId": "u0",
        "rule": "≥1024 三栏"
      },
      "applicabilityReason": "首页、栏目、办事、检索和开放数据均使用门户信息架构。"
    },
    {
      "id": "public-tablet",
      "area": "公众门户",
      "minWidth": 768,
      "maxWidth": 1023,
      "sourceRef": {
        "docKey": "ui",
        "sectionId": "u0",
        "rule": "768–1023 两栏"
      },
      "applicabilityReason": "公众门户在中等宽度必须保持导航、内容与办事入口可达。"
    },
    {
      "id": "public-mobile",
      "area": "公众门户",
      "maxWidth": 767,
      "sourceRef": {
        "docKey": "ui",
        "sectionId": "u0",
        "rule": "<768 单栏，办事入口固定底部快捷区"
      },
      "applicabilityReason": "所有公众页面适用；办事入口是明确的移动端关键路径。"
    },
    {
      "id": "cms-desktop",
      "area": "CMS 后台",
      "minWidth": 1024,
      "sourceRef": {
        "docKey": "mod",
        "sectionId": "o1",
        "rule": "块编辑器、审核发布和内容生产台"
      },
      "applicabilityReason": "CMS 页面冻结为桌面工作台验证基线；现有 UI 册未给出 CMS 响应式断点，移动 CMS 不在本轮承诺范围。"
    }
  ],
  "statusDisplayMapping": {
    "canonicalStorageStates": [
      {
        "storageState": "draft",
        "display": "草稿",
        "roles": [
          "编辑"
        ],
        "basis": {
          "docKey": "db",
          "sectionId": "d0",
          "rule": "contents.status 枚举包含 draft"
        }
      },
      {
        "storageState": "review",
        "display": "待审核",
        "roles": [
          "审核"
        ],
        "basis": {
          "docKey": "db",
          "sectionId": "d0",
          "rule": "contents.status 枚举包含 review"
        }
      },
      {
        "storageState": "published",
        "display": "已发布",
        "roles": [
          "发布",
          "访客",
          "公民"
        ],
        "basis": {
          "docKey": "db",
          "sectionId": "d0",
          "rule": "contents.status 枚举包含 published"
        }
      },
      {
        "storageState": "archived",
        "display": "已归档",
        "roles": [
          "发布"
        ],
        "basis": {
          "docKey": "db",
          "sectionId": "d0",
          "rule": "contents.status 枚举包含 archived"
        }
      }
    ],
    "workflowViewStates": [
      {
        "id": "submitted",
        "storageState": "review",
        "display": "已提审",
        "visibleTo": [
          "编辑"
        ],
        "basis": {
          "docKey": "api",
          "sectionId": "a0",
          "rule": "workflowView=submitted 由服务端返回；status 仍为 review"
        }
      },
      {
        "id": "pending-publish",
        "storageState": "review",
        "display": "待发布",
        "visibleTo": [
          "发布"
        ],
        "basis": {
          "docKey": "api",
          "sectionId": "a0",
          "rule": "workflowView=pending-publish 必须满足 status=review 且 allowedActions 含 publish"
        },
        "rule": "服务端返回的 workflowView 与 allowedActions 共同成立才展示；前端不得由角色或 review 状态自行推断。"
      },
      {
        "id": "returned",
        "storageState": "draft",
        "display": "已退回草稿",
        "visibleTo": [
          "编辑",
          "审核"
        ],
        "basis": {
          "docKey": "api",
          "sectionId": "a0",
          "rule": "workflowView=returned 必须满足 status=draft 且 lastTransition.action=return"
        },
        "rule": "以服务端返回的 lastTransition 为准；不能把所有 draft 误标为退回。"
      }
    ],
    "resolution": "原型和实现均以 contents.status 的四个持久枚举为权威。审核通过/待发布是服务端响应的 workflowView，不新增数据库状态；服务端同时返回 allowedActions 与 lastTransition，前端只消费这些字段。"
  }
};
/* 客户门户独立原型维护源：生成阶段输出完整业务 DOM，运行时仅切换已有页态。 */
function v19BuildImplementationHTML(catalog) {
  var esc = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  };
  var pageById = function (id) { return catalog.pages.find(function (page) { return page.id === id; }); };
  var controlById = function (page, id) {
    var control = page.controls.find(function (item) { return item.id === id; });
    if (!control) throw new Error('Unknown control ' + page.id + ':' + id);
    return control;
  };
  var fieldById = function (page, id) {
    var field = (page.fields || []).find(function (item) { return item.id === id; });
    if (!field) throw new Error('Unknown field ' + page.id + ':' + id);
    return field;
  };
  var i18n = function (fr, en) {
    return '<span data-i18n data-fr="' + esc(fr) + '" data-en="' + esc(en) + '">' + esc(fr) + '</span>';
  };
  var controlAttrs = function (page, id) {
    var control = controlById(page, id);
    return ' data-prototype-control="' + esc(control.id) + '" data-prototype-type="' + esc(control.type) +
      '" data-prototype-action="' + esc(control.action) + '"' +
      (control.targetPageId ? ' data-prototype-target="' + esc(control.targetPageId) + '"' : '');
  };
  var button = function (page, id, fr, en, extra) {
    var control = controlById(page, id);
    var css = control.type.indexOf('primary') >= 0 ? ' primary' : control.type === 'danger-button' ? ' danger' : '';
    return '<button type="button" class="action' + css + '"' + controlAttrs(page, id) + (extra || '') + '>' + i18n(fr, en) + '</button>';
  };
  var link = function (page, id, fr, en, extra) {
    return '<a href="#" class="action-link"' + controlAttrs(page, id) + (extra || '') + '>' + i18n(fr, en) + '</a>';
  };
  var normalizeFieldAttrs = function (page, id, attributes) {
    var spec = fieldById(page, id);
    var result = String(attributes || '');
    result = result.replace(/\stype="[^"]*"/g, '').replace(/\srequired(?:="[^"]*")?/g, '')
      .replace(/\spattern="[^"]*"/g, '').replace(/\sminlength="[^"]*"/g, '')
      .replace(/\smaxlength="[^"]*"/g, '').replace(/\saccept="[^"]*"/g, '')
      .replace(/\sdata-max-size-mb="[^"]*"/g, '');
    result += ' type="' + esc(spec.type) + '"' + (spec.required ? ' required' : '');
    if (spec.pattern) result += ' pattern="' + esc(spec.pattern) + '"';
    if (Number.isInteger(spec.minLength)) result += ' minlength="' + spec.minLength + '"';
    if (Number.isInteger(spec.maxLength)) result += ' maxlength="' + spec.maxLength + '"';
    if (spec.accept) result += ' accept="' + esc(spec.accept.join(',')) + '"';
    if (Number.isFinite(spec.maxSizeMb)) result += ' data-max-size-mb="' + spec.maxSizeMb + '"';
    return result;
  };
  var inputControl = function (page, id, fieldId, attributes) {
    return '<input' + controlAttrs(page, id) + (fieldId ? ' data-prototype-field="' + esc(fieldId) + '"' : '') + ' ' + (fieldId ? normalizeFieldAttrs(page, fieldId, attributes) : attributes) + '>';
  };
  var field = function (page, id, attributes) {
    fieldById(page, id);
    return '<input data-prototype-field="' + esc(id) + '" ' + normalizeFieldAttrs(page, id, attributes) + '>';
  };
  var notice = function (kind, fr, en, role) {
    return '<div class="notice ' + kind + '"' + (role ? ' role="' + role + '"' : '') + '>' + i18n(fr, en) + '</div>';
  };
  var publicHeader = function (page) {
    var language = page.id === 'P-PUB-HOME' || page.id === 'P-PUB-CONTENT'
      ? '<div class="language-group" aria-label="Language">' +
        button(page, 'language', 'FR', 'FR', ' data-language="fr"') +
        button(page, 'language', 'EN', 'EN', ' data-language="en"') + '</div>'
      : '<div class="language-group"><button type="button" class="language-plain" data-language-toggle="fr">FR</button><button type="button" class="language-plain" data-language-toggle="en">EN</button></div>';
    var homeSearch = page.id === 'P-PUB-HOME'
      ? '<div class="header-search"><label class="sr-only" for="home-search">Recherche</label>' +
        inputControl(page, 'search', null, 'id="home-search" type="search" minlength="2" maxlength="64" aria-label="Recherche / Search" placeholder="Rechercher…" data-fr-placeholder="Rechercher…" data-en-placeholder="Search…"') + '</div>'
      : '';
    return '<header class="mast"><div class="mast-inner"><div class="crest" aria-hidden="true"><b>RC</b><span>★</span></div>' +
      '<div class="brand"><strong>République du Cameroun</strong><small>' + i18n('Paix · Travail · Patrie', 'Peace · Work · Fatherland') + '</small></div>' + language + '</div></header>' +
      '<nav class="public-nav" aria-label="Navigation principale"><div class="nav-inner">' +
      button(page, 'nav-home', 'Accueil', 'Home', ' data-route="P-PUB-HOME"') +
      button(page, 'nav-section', 'Actualités', 'News', ' data-route="P-PUB-SECTION"') +
      button(page, 'nav-services', 'Démarches', 'Services', ' data-route="P-PUB-SERVICE-GUIDE"') +
      button(page, 'nav-opendata', 'Open Data', 'Open Data', ' data-route="P-PUB-OPENDATA"') + homeSearch + '</div></nav>';
  };
  var publicFooter = function () {
    return '<footer class="footer"><div><strong>Portail national du Cameroun</strong><p>' + i18n('Services publics, informations officielles et données ouvertes.', 'Public services, official information and open data.') + '</p></div><div>' + i18n('Aide · Contact · Accessibilité', 'Help · Contact · Accessibility') + '</div></footer>';
  };
  var publicShell = function (page, body, mobileControl) {
    return publicHeader(page) + '<main class="page-main">' + body + '</main>' + publicFooter() +
      '<div class="mobile-quick">' + button(page, 'nav-home', '⌂ Accueil', '⌂ Home', ' data-route="P-PUB-HOME"') +
      (mobileControl || button(page, 'nav-services', '▣ Démarches', '▣ Services', ' data-route="P-PUB-SERVICE-GUIDE"')) + '</div>';
  };
  var cmsShell = function (role, body) {
    var navPage = pageById('P-CMS-LOGIN');
    return '<div class="cms-shell" data-role-context="' + esc(role) + '"><header class="cms-head"><div class="cms-mark">RC</div><div><strong>Console éditoriale</strong><small>Portail national du Cameroun</small></div><span class="role-chip">' + esc(role) + '</span></header>' +
      '<div class="cms-layout"><aside class="cms-side"><b>ESPACE CONTENU</b>' + button(navPage, 'nav-dashboard', 'Tableau de bord', 'Dashboard', ' data-route="P-CMS-DASHBOARD"') + button(navPage, 'nav-editor', 'Éditeur', 'Editor', ' data-route="P-CMS-EDITOR"') + button(navPage, 'nav-review', 'Validation', 'Review', ' data-route="P-CMS-REVIEW"') + button(navPage, 'nav-publish', 'Publication', 'Publish', ' data-route="P-CMS-PUBLISH"') + '</aside>' +
      '<main class="cms-main">' + body + '</main></div></div>';
  };

  function home(page, state) {
    var banner = state.id === 'fallback' ? notice('warning', 'Traduction anglaise indisponible : affichage de la version française.', 'English translation unavailable: French original shown.', 'status') :
      state.id === 'slow' ? notice('info', 'Instantané disponible pendant l’actualisation des actualités.', 'A content snapshot remains available while news refreshes.', 'status') : '';
    var cards = ['Passeport', 'Création d’entreprise', 'Déclaration fiscale'].map(function (title, index) {
      return '<article class="service-card"><span class="service-icon">' + ['▣', '◆', '✓'][index] + '</span><h2>' + title + '</h2><p>Informations, pièces justificatives et suivi transparent.</p>' +
        link(page, 'service-cards', 'Commencer', 'Start') + '</article>';
    }).join('');
    var mobile = button(page, 'service-cards', 'Passeport', 'Passport');
    return publicShell(page, '<div class="content-wrap" data-business-content>' + banner +
      '<section class="home-grid"><article class="hero" data-public-content-id="content-884"><span class="kicker">À LA UNE</span><h1>' + i18n('Un accès plus simple aux services essentiels', 'Simpler access to essential public services') + '</h1><p>' + i18n('Retrouvez les démarches numériques et les informations vérifiées de la République.', 'Find digital services and verified information from the Republic.') + '</p></article>' +
      '<aside class="agenda"><span class="kicker">7 SEPTEMBRE 2026</span><h2>' + i18n('Agenda des autorités', 'Leadership agenda') + '</h2><ol><li><time>09:00</time> Conseil interministériel</li><li><time>14:00</time> Visite de terrain, Yaoundé</li><li><time>17:30</time> Communiqué officiel</li></ol></aside></section>' +
      '<section class="section-block"><div class="section-title"><span>01</span><h2>' + i18n('Démarches les plus demandées', 'Most requested services') + '</h2></div><div class="service-grid">' + cards + '</div></section></div>', mobile);
  }

  function sectionPage(page, state) {
    var controls = '';
    var body = '';
    if (state.id === 'loading') body = '<div class="skeleton"></div><div class="skeleton short"></div><p>Chargement sécurisé de la rubrique en cours.</p>';
    else if (state.id === 'empty') body = '<div class="empty-state"><b>0 publication</b><p>' + i18n('Cette rubrique ne contient pas encore de publication.', 'This section has no publication yet.') + '</p></div>';
    else if (state.id === 'failed') {
      body = notice('error', 'La rubrique Actualités reste sélectionnée. Réessayez sans perdre le contexte.', 'The News section remains selected. Retry without losing context.', 'alert');
      controls = button(page, 'retry', 'Réessayer', 'Retry');
    } else {
      body = '<div class="story-list"><article data-public-content-id="content-884"><time>07.09.2026</time><h2>Réforme de l’accueil administratif</h2><p>Les services publics renforcent l’accompagnement des citoyens.</p>' + link(page, 'content-card', 'Lire la suite', 'Read more') + '</article><article><time>06.09.2026</time><h2>Calendrier des services fiscaux</h2><p>Les prochaines échéances et points d’accueil.</p></article></div>';
      controls = '<div class="pager">' + button(page, 'pagination', '← Précédent', '← Previous', ' data-page-direction="prev"') + button(page, 'pagination', 'Suivant →', 'Next →', ' data-page-direction="next"') + '</div>';
    }
    return publicShell(page, '<div class="content-wrap narrow" data-business-content><span class="kicker">INFORMATIONS OFFICIELLES</span><h1>' + i18n('Actualités et communiqués', 'News and notices') + '</h1>' + body + controls + '<div class="inline-status" role="status"></div></div>');
  }

  function contentPage(page, state) {
    var body = state.id === 'gone'
      ? '<article class="article"><span class="kicker">410 · CONTENU ARCHIVÉ</span><h1>' + i18n('Cette publication a quitté le portail actif', 'This publication has left the active portal') + '</h1>' + notice('warning', 'Ce texte a été archivé. Ses métadonnées restent consultables dans la rubrique.', 'This text was archived. Its metadata remains available in the section.', 'status') + '</article>'
      : (state.id === 'fallback' ? notice('warning', 'FR original · traduction demandée indisponible.', 'French original · requested translation unavailable.', 'status') : '') +
        '<article class="article" data-public-content-id="content-884"><span class="kicker">ACTUALITÉ · 07 SEPTEMBRE 2026</span><h1>' + i18n('Réforme de l’accueil administratif', 'Administrative service reception reform') + '</h1><p class="lede">Une information vérifiée du gouvernement.</p><p>Les administrations renforcent l’orientation des citoyens et le suivi transparent des demandes.</p><p>Les services numériques complètent l’accueil local sans remplacer l’accompagnement humain.</p></article>';
    return publicShell(page, '<div class="content-wrap narrow" data-business-content>' + body + '<div class="actions">' + link(page, 'back', '← Retour à la rubrique', '← Back to section') + '</div></div>');
  }

  function archivePage(page) {
    return publicShell(page, '<div class="content-wrap narrow" data-business-content><div class="archive-card"><span class="http-code">410</span><div><span class="kicker">CONTENU ARCHIVÉ</span><h1>' + i18n('Cette publication n’est plus accessible', 'This publication is no longer available') + '</h1><p>' + i18n('Les métadonnées sont conservées pour la transparence et la recherche.', 'Metadata is preserved for transparency and search.') + '</p>' + link(page, 'return-section', 'Retour aux actualités', 'Return to news') + '</div></div></div>');
  }

  function guide(page, state) {
    var unavailable = state.id === 'unavailable';
    var auth = state.id === 'auth-needed' ? notice('warning', 'Connectez-vous pour continuer; le retour vers ce service sera conservé.', 'Sign in to continue; your return to this service will be preserved.', 'status') : '';
    var actions = unavailable ? '' : '<div class="actions">' + button(page, 'requirements', 'Voir la liste complète', 'View full checklist') + link(page, 'start', state.id === 'auth-needed' ? 'Se connecter et continuer' : 'Commencer la demande', state.id === 'auth-needed' ? 'Sign in and continue' : 'Start application') + '</div>';
    var title = unavailable ? i18n('Cette démarche n’est pas encore ouverte', 'This service is not yet available') : i18n('Demande de passeport', 'Passport application');
    return publicShell(page, '<div class="content-wrap narrow" data-business-content><span class="kicker">DÉMARCHE EN LIGNE</span><h1>' + title + '</h1>' + auth + '<div class="guide-grid"><section class="panel"><h2>' + i18n('Avant de commencer', 'Before you begin') + '</h2><p>Délai indicatif : 10 jours ouvrés · Frais : 75 000 FCFA.</p><h3>Pièces obligatoires</h3><ul class="checklist"><li>Pièce d’identité en cours de validité</li><li>Photo récente</li><li>Justificatif de résidence</li><li>PDF ou JPG · 5 MB maximum par fichier</li></ul>' + actions + '<div class="inline-status" role="status"></div></section><aside class="guide-aside"><b>Besoin d’aide ?</b><p>Un agent peut vous accompagner au centre de services de Yaoundé.</p></aside></div></div>');
  }

  function application(page, state) {
    var step = state.id === 'details' ? 2 : state.id === 'submitting' || state.id === 'upstream-pending' ? 3 : 1;
    var body = '';
    if (step === 1) body = '<h2>1. ' + i18n('Pièces justificatives', 'Supporting documents') + '</h2><label for="attachment-' + state.id + '">Document obligatoire</label>' + inputControl(page, 'upload', 'attachments', 'id="attachment-' + state.id + '" type="file" required accept="application/pdf,image/jpeg" data-max-size-mb="5" aria-label="Téléverser la pièce / Upload document" aria-describedby="attachment-help-' + state.id + '"') + '<small id="attachment-help-' + state.id + '">PDF ou JPG · 5 MB maximum</small><div class="actions">' + button(page, 'next', 'Étape suivante', 'Next step') + '</div>';
    else if (step === 2) body = '<h2>2. ' + i18n('Vérifier vos informations', 'Review your details') + '</h2><dl class="summary"><dt>Service</dt><dd>Passeport ordinaire</dd><dt>Demandeur</dt><dd>Marie N. · Yaoundé</dd><dt>Pièce jointe</dt><dd>identite.pdf</dd></dl><p>Une seule demande sera enregistrée avec la même clé d’idempotence.</p><div class="actions">' + button(page, 'back', 'Étape précédente', 'Previous step') + button(page, 'submit', 'Envoyer la demande', 'Submit application') + '</div>';
    else body = '<h2>3. ' + i18n('Confirmation', 'Confirmation') + '</h2><p>' + i18n('Un seul dossier sera créé avec une clé d’idempotence.', 'A single application will be created with an idempotency key.') + '</p>' + (state.id === 'submitting' ? notice('info', 'Envoi sécurisé en cours… Le bouton reste verrouillé.', 'Secure submission in progress… The button remains locked.', 'status') : state.id === 'upstream-pending' ? notice('warning', 'Le ministère est momentanément indisponible. Votre dossier reste enregistré et attend son reçu.', 'The ministry is temporarily unavailable. Your application remains saved and awaits its receipt.', 'status') : '') + '<div class="actions">' + button(page, 'back', 'Étape précédente', 'Previous step') + button(page, 'submit', 'Envoyer la demande', 'Submit application', state.id === 'submitting' ? ' disabled aria-disabled="true"' : '') + '</div>';
    var validation = state.id === 'validation' ? notice('error', 'Ajoutez un fichier PDF ou JPG de 5 MB maximum avant de continuer.', 'Add a PDF or JPG file no larger than 5 MB before continuing.', 'alert') : '<div class="notice error validation-message" role="alert" hidden></div>';
    return publicShell(page, '<div class="content-wrap narrow" data-business-content><span class="kicker">DOSSIER CMR-PAS-2026</span><h1>' + i18n('Demande de passeport', 'Passport application') + '</h1><div class="steps"><span class="' + (step === 1 ? 'active' : '') + '">1 · Pièces</span><span class="' + (step === 2 ? 'active' : '') + '">2 · Vérification</span><span class="' + (step === 3 ? 'active' : '') + '">3 · Envoi</span></div><section class="panel application-panel">' + body + validation + '<div class="inline-status" role="status"></div></section></div>');
  }

  function receipt(page, state) {
    var pending = state.id === 'pending';
    return publicShell(page, '<div class="content-wrap narrow" data-business-content><section class="receipt-card"><span class="kicker">' + (pending ? 'REÇU EN ATTENTE' : 'DEMANDE ENREGISTRÉE') + '</span><h1>' + (pending ? i18n('Votre dossier est conservé', 'Your application is preserved') : i18n('Votre demande est acceptée', 'Your application is accepted')) + '</h1><p>' + (pending ? i18n('Aucun document n’est perdu pendant la reprise du service ministériel.', 'No document is lost while the ministry service recovers.') : i18n('Conservez ce numéro pour suivre votre dossier.', 'Keep this number to track your application.')) + '</p><div class="receipt-number">CMR-2026-0917-042</div><div class="actions">' + button(page, 'copy', 'Copier le numéro', 'Copy receipt number') + link(page, 'track', 'Voir la progression', 'Track progress') + '</div><div class="inline-status" role="status"></div></section></div>');
  }

  function statusPage(page, state) {
    if (state.id === 'unauthorized') return publicShell(page, '<div class="content-wrap narrow" data-business-content><h1>Accès au suivi</h1>' + notice('error', 'Ce reçu appartient à un autre compte. Reconnectez-vous pour continuer.', 'This receipt belongs to another account. Sign in again to continue.', 'alert') + '<div class="actions">' + link(page, 'login', 'Se reconnecter', 'Sign in again') + '</div></div>');
    var labels = { pending: 'En attente de routage', processing: 'En cours de traitement', completed: 'Dossier terminé', returned: 'Complément requis' };
    var returnNote = state.id === 'returned' ? notice('warning', 'Joignez une photo plus récente avant le 15 septembre.', 'Attach a more recent photo before September 15.', 'status') : '';
    return publicShell(page, '<div class="content-wrap narrow" data-business-content><span class="kicker">REÇU CMR-2026-0917-042</span><h1>' + i18n('Progression de la demande', 'Application progress') + '</h1><span class="status-badge">' + labels[state.id] + '</span>' + returnNote + '<ol class="timeline"><li class="done"><b>Demande reçue</b><small>07 septembre · 09:42</small></li><li class="current"><b>' + labels[state.id] + '</b><small>Mise à jour vérifiée</small></li><li><b>Décision ministérielle</b><small>À venir</small></li></ol><div class="actions">' + button(page, 'refresh', 'Actualiser la progression', 'Refresh progress') + '</div><div class="inline-status" role="status"></div></div>');
  }

  function account(page, state) {
    var locked = state.id === 'locked';
    var otp = state.id === 'otp' || state.id === 'expired';
    var inputDisabled = locked || state.id === 'expired' ? ' disabled aria-disabled="true"' : '';
    var session = state.id === 'session-expired' ? notice('warning', 'Votre session a expiré. Reconnectez-vous; le retour sécurisé est conservé.', 'Your session expired. Sign in again; the safe return is preserved.', 'status') : '';
    var input = otp
      ? '<label for="otp-' + state.id + '">Code OTP à 6 chiffres</label>' + inputControl(page, 'otp', 'otp', 'id="otp-' + state.id + '" type="text" inputmode="numeric" pattern="\\d{6}" minlength="6" maxlength="6" required autocomplete="one-time-code" aria-label="Code OTP à 6 chiffres"' + inputDisabled)
      : '<label for="phone-' + state.id + '">Numéro de téléphone</label>' + inputControl(page, 'phone', 'phone', 'id="phone-' + state.id + '" type="tel" inputmode="numeric" pattern="\\d{8}" minlength="8" maxlength="8" required autocomplete="tel" aria-label="Numéro de téléphone à 8 chiffres" placeholder="69912345"' + inputDisabled);
    var message = locked ? notice('error', 'Compte verrouillé après cinq essais. Réessayez dans 30 minutes.', 'Account locked after five attempts. Try again in 30 minutes.', 'alert') : state.id === 'expired' ? notice('warning', 'Ce code a expiré. Demandez un nouveau code sans divulguer l’ancien.', 'This code expired. Request a new code without exposing the old one.', 'status') : session;
    var submitExtra = locked ? ' disabled aria-disabled="true"' : '';
    return publicShell(page, '<div class="content-wrap account-wrap" data-business-content><section class="account-card"><span class="kicker">COMPTE CITOYEN</span><h1>' + (otp ? i18n('Vérification par code', 'Verification code') : i18n('Connexion sécurisée', 'Secure sign in')) + '</h1><p>' + i18n('Votre identité protège les demandes et les reçus.', 'Your identity protects applications and receipts.') + '</p>' + message + input + '<div class="actions">' + button(page, 'submit', state.id === 'expired' ? 'Demander un nouveau code' : otp ? 'Vérifier le code' : 'Recevoir un code', state.id === 'expired' ? 'Request a new code' : otp ? 'Verify code' : 'Send code', submitExtra) + '</div><div class="notice error validation-message" role="alert" hidden></div></section></div>');
  }

  function searchPage(page, state) {
    var input = '<label for="query-' + state.id + '">' + i18n('Votre recherche', 'Your search') + '</label>' + inputControl(page, 'query', 'query', 'id="query-' + state.id + '" type="search" minlength="2" maxlength="64" required aria-label="Recherche de 2 à 64 caractères" value="administration"');
    var body = state.id === 'empty' ? '<div class="empty-state"><h2>Aucun résultat</h2><p>Utilisez un mot-clé de 2 à 64 caractères, par exemple « passeport ».</p></div>' : '<div class="search-result"><span>ACTUALITÉ · 07.09.2026</span><h2>Réforme de l’accueil administratif</h2><p>Un résultat vérifié dans la langue active.</p>' + link(page, 'result', 'Ouvrir le résultat', 'Open result') + '</div>';
    var mode = state.id === 'lagging' ? notice('warning', 'L’index se met à jour; les publications récentes peuvent manquer.', 'The index is updating; recent publications may be missing.', 'status') : state.id === 'basic' ? notice('info', 'Mode de recherche de base : correspondance sécurisée en base de données.', 'Basic search mode: secure database matching.', 'status') : '';
    return publicShell(page, '<div class="content-wrap narrow" data-business-content><span class="kicker">RECHERCHE NATIONALE</span><h1>' + i18n('Trouver une information', 'Find information') + '</h1><div class="search-large">' + input + '</div><div class="notice error validation-message" role="alert" hidden></div>' + mode + body + '</div>');
  }

  function openData(page, state) {
    var issue = state.id === 'key-needed' ? notice('warning', 'Une clé API active est nécessaire avant le téléchargement.', 'An active API key is required before download.', 'status') : state.id === 'unauthorized' ? notice('error', '401 · Clé non valide. Sa valeur reste masquée.', '401 · Invalid key. Its value remains masked.', 'alert') : state.id === 'rate-limited' ? notice('error', '429 · Quota atteint. Réessayez demain ou après la fenêtre de limite.', '429 · Quota reached. Retry tomorrow or after the rate window.', 'alert') : '';
    return publicShell(page, '<div class="content-wrap" data-business-content><span class="kicker">OPEN DATA CAMEROUN</span><h1>' + i18n('Jeux de données publics', 'Public datasets') + '</h1><div class="data-grid"><article class="dataset"><div class="dataset-meta"><span>CSV</span><span>Mise à jour mensuelle</span><span>Licence ouverte</span></div><h2>Statistiques administratives 2026</h2><p>Indicateurs agrégés des services publics, documentés en français et en anglais.</p><label for="api-' + state.id + '">Clé API</label>' + field(page, 'apiKey', 'id="api-' + state.id + '" type="password" required autocomplete="off" placeholder="cm_live_••••••"') + issue + '<div class="actions">' + link(page, 'dataset', 'Voir les métadonnées', 'View metadata') + link(page, 'get-key', 'Obtenir une clé', 'Get a key') + button(page, 'download', 'Télécharger CSV', 'Download CSV') + '</div><div class="inline-status" role="status"></div></article><aside class="quota"><b>Usage responsable</b><strong>60</strong><span>requêtes / minute / clé</span><p>Chaque téléchargement est rattaché à un scope et à un quota.</p></aside></div></div>');
  }

  function cmsLogin(page, state) {
    var denied = state.id === 'denied' ? notice('error', 'Accès refusé : ce rôle ne possède pas la permission demandée. Aucun outil protégé n’a été chargé.', 'Access denied: this role lacks the requested permission. No protected tool was loaded.', 'alert') : '';
    return cmsShell('Visiteur', '<div data-business-content class="login-card"><span class="kicker">ACCÈS PROTÉGÉ</span><h1>Connexion au CMS</h1><p>Choisissez un rôle de démonstration. Chaque espace applique ses propres permissions.</p>' + denied + '<div class="role-grid">' + button(page, 'sign-in', 'Éditeur de contenu', 'Content editor', ' data-role="editor"') + button(page, 'sign-in', 'Responsable de validation', 'Reviewer', ' data-role="reviewer"') + button(page, 'sign-in', 'Responsable de publication', 'Publisher', ' data-role="publisher"') + '</div><p class="security-note">Session courte · audit des actions · aucun mot de passe affiché</p></div>');
  }

  function dashboard(page, state) {
    var role = state.id === 'empty' ? 'Reviewer' : 'Editor';
    var body = state.id === 'empty' ? '<div class="empty-state"><h2>La file est vide</h2><p>Aucune tâche n’est inventée. Revenez lorsque du contenu est assigné.</p>' + link(page, 'review-queue', 'Ouvrir la file de validation', 'Open review queue', ' data-roles="reviewer"') + '</div>' : '<div class="metrics"><div><strong>12</strong><span>Brouillons</span></div><div><strong>4</strong><span>À valider</span></div><div><strong>2</strong><span>Traductions manquantes</span></div></div><section class="worklist"><div><span class="kicker">' + (state.id === 'missing-translation' ? 'EN MANQUANT · 3 JOURS' : 'VOS CONTENUS') + '</span><h2>Réforme de l’accueil administratif</h2><p>Actualités · paire FR/EN · révision 18</p></div><div class="actions">' + link(page, 'translation-item', 'Ouvrir la paire linguistique', 'Open language pair', ' data-roles="editor"') + button(page, 'new-content', 'Nouveau contenu', 'New content', ' data-roles="editor"') + link(page, 'review-queue', 'Ouvrir la file de validation', 'Open review queue', ' data-roles="reviewer"') + '</div></section>';
    return cmsShell(role, '<div data-business-content><div class="cms-title"><div><span class="kicker">TRAVAIL ASSIGNÉ</span><h1>Tableau de bord</h1></div><span class="date-chip">07 SEP 2026</span></div>' + body + '</div>');
  }

  function editor(page, state) {
    var message = state.id === 'conflict' ? notice('error', '409 · La révision 19 existe déjà. Comparez avant toute fusion; rien n’a été écrasé.', '409 · Revision 19 already exists. Compare before merging; nothing was overwritten.', 'alert') : state.id === 'validation' ? notice('error', 'Validation bloquée : titre français requis et bloc image sans légende.', 'Review blocked: French title required and image block has no caption.', 'alert') : state.id === 'submitted' ? notice('success', 'Révision 19 soumise à validation. Les actions d’édition sont maintenant verrouillées.', 'Revision 19 submitted for review. Editing actions are now locked.', 'status') : '';
    var disabled = state.id === 'submitted' ? ' disabled aria-disabled="true" data-roles="editor"' : ' data-roles="editor"';
    return cmsShell('Editor', '<div data-business-content><div class="cms-title"><div><span class="kicker">ACTUALITÉS · RÉVISION 19</span><h1>Éditeur bilingue</h1></div><span class="status-badge">draft</span></div>' + message + '<div class="editor-layout"><section class="editor-panel"><div class="tabs" role="tablist">' + button(page, 'language-tabs', 'Français', 'French', ' data-lang-tab="fr" data-roles="editor"') + button(page, 'language-tabs', 'English', 'English', ' data-lang-tab="en" data-roles="editor"') + '</div><label for="title-fr-' + state.id + '">Titre français *</label>' + field(page, 'titleFr', 'id="title-fr-' + state.id + '" type="text" required value="Réforme de l’accueil administratif"') + '<label for="title-en-' + state.id + '">English title</label>' + field(page, 'titleEn', 'id="title-en-' + state.id + '" type="text" value="Administrative service reception reform"') + '<div class="content-block"><span>¶ PARAGRAPHE</span><p>Les services numériques améliorent l’accès et la traçabilité des demandes.</p></div><div class="content-block image-block"><span>▧ IMAGE</span>' + field(page, 'imageBlock', 'type="file" accept="image/jpeg" aria-label="Image content block"') + '</div><div class="actions">' + button(page, 'block-add', 'Ajouter un bloc', 'Add block', disabled) + button(page, 'save', 'Enregistrer le brouillon', 'Save draft', disabled) + button(page, 'submit-review', 'Soumettre à validation', 'Submit for review', disabled) + '</div><div class="inline-status" role="status"></div></section><aside class="editor-guide"><b>Blocs autorisés</b><ul><li>Titre</li><li>Paragraphe</li><li>Image</li><li>Tableau</li><li>Citation</li></ul><hr><b>Complétude</b><p>FR 100 % · EN 88 %</p></aside></div></div>');
  }

  function review(page, state) {
    var message = state.id === 'approved' ? notice('success', 'Validation enregistrée. Le contenu attend désormais une publication séparée.', 'Approval recorded. Content now awaits separate publication.', 'status') : state.id === 'returned' ? notice('warning', 'Retour au brouillon avec l’avis visible : préciser la source du chiffre principal.', 'Returned to draft with visible note: cite the source of the main figure.', 'status') : state.id === 'forbidden' ? notice('error', 'Permission refusée : Reviewer peut comparer et décider, mais ne peut pas modifier le corps.', 'Permission denied: Reviewer may compare and decide, but cannot edit the body.', 'alert') : '';
    return cmsShell('Reviewer', '<div data-business-content><div class="cms-title"><div><span class="kicker">FILE DE VALIDATION · 04</span><h1>Contrôle éditorial</h1></div><span class="role-chip">Reviewer</span></div>' + message + '<article class="review-card"><header><div><h2>Réforme de l’accueil administratif</h2><p>Soumis par A. Mballa · révision 19 · 07 septembre 10:14</p></div><span class="status-badge">review</span></header><div class="diff"><section><b>FR · ORIGINAL</b><p>Accueil administratif modernisé. Les indicateurs sont publiés chaque mois.</p></section><section><b>EN · TRANSLATION</b><p>Modernised service reception. Indicators are published monthly.</p></section></div><div class="actions">' + button(page, 'compare', 'Afficher le détail en lecture seule', 'View read-only detail', ' data-roles="reviewer"') + button(page, 'return', 'Retourner avec un avis', 'Return with note', ' data-roles="reviewer"') + button(page, 'approve', 'Approuver pour publication', 'Approve for publish', ' data-roles="reviewer"') + '</div><div class="inline-status" role="status"></div></article></div>');
  }

  function publish(page, state) {
    var status = state.id;
    var message = state.id === 'preflight-failed' ? notice('error', 'Prévol bloqué : description EN manquante et métadonnée de source absente.', 'Preflight blocked: EN description and source metadata are missing.', 'alert') : state.id === 'published' ? notice('success', 'Publié le 07 septembre à 11:26. Invalidation cache et indexation ont été soumises.', 'Published September 7 at 11:26. Cache invalidation and indexing were submitted.', 'status') : state.id === 'event-retry' ? notice('warning', 'Publication conservée; l’événement d’indexation est en attente de réessai visible.', 'Publication is preserved; the indexing event is awaiting a visible retry.', 'status') : state.id === 'archived' ? notice('warning', 'Archivé sans destruction : le détail public affiche 410 et les métadonnées restent recherchables.', 'Archived without deletion: public detail returns 410 and metadata remains searchable.', 'status') : '';
    return cmsShell('Publisher', '<div data-business-content><div class="cms-title"><div><span class="kicker">PUBLICATION · LOT 2026-09-07</span><h1>Publication et audit</h1></div><span class="status-badge">' + esc(status) + '</span></div>' + message + '<article class="publish-card"><h2>Réforme de l’accueil administratif</h2><div class="preflight"><div><b>FR</b><span>Complet</span></div><div><b>EN</b><span>' + (state.id === 'preflight-failed' ? 'À corriger' : 'Complet') + '</span></div><div><b>Révision</b><span>19 approuvée</span></div><div><b>Audit</b><span>Actor · IP · objet · heure</span></div></div><div class="actions">' + button(page, 'publish', 'Publier', 'Publish', ' data-roles="publisher"') + button(page, 'unpublish', 'Mettre hors ligne', 'Unpublish', ' data-roles="publisher"') + button(page, 'archive', 'Archiver', 'Archive', ' data-roles="publisher"') + link(page, 'audit', 'Voir le journal d’audit', 'View audit log', ' data-roles="publisher"') + '</div><div class="inline-status" role="status"></div></article></div>');
  }

  function customerRuntime() {
    var catalog = window.__V19_CATALOG__;
    var app = document.getElementById('app');
    var contentKernel = createCustomerStateKernel();
    var cmsRoles = ['editor', 'reviewer', 'publisher'];
    var citizenPages = ['P-PUB-APPLICATION', 'P-PUB-RECEIPT', 'P-PUB-APPLICATION-STATUS'];
    var session = { authenticated: false, domain: 'anonymous', role: null, returnTo: null, renewAttempted: false, renewOutcome: null };
    var view = { page: 'P-PUB-HOME', state: 'ready', lang: 'fr', mode: 'customer', previewRole: null };
    var previewSelection = { page: null, state: null };
    var business = {
      sectionPage: 1,
      application: { operationKey: 'CMR-IDEMP-2026-001', submitted: false, receipt: 'CMR-2026-0917-042' },
      content: Object.assign(contentKernel.initial(), {
        revision: 18, blocks: 2, publicProjection: 'published'
      })
    };
    var pageSpec = function (id) { return catalog.pages.find(function (page) { return page.id === id; }); };
    var activePage = function () { return document.querySelector('#app > [data-prototype-page]:not([hidden])'); };
    var activeState = function () { var page = activePage(); return page && page.querySelector(':scope > [data-prototype-state]:not([hidden])'); };
    var requiredRole = function (pageId) {
      if (pageId === 'P-CMS-DASHBOARD') return 'cms';
      if (pageId === 'P-CMS-EDITOR') return 'editor';
      if (pageId === 'P-CMS-REVIEW') return 'reviewer';
      if (pageId === 'P-CMS-PUBLISH') return 'publisher';
      return null;
    };
    var isCitizenSession = function () { return session.authenticated && session.domain === 'citizen' && session.role === 'citizen'; };
    var previewRole = function (pageId, stateId) {
      if (pageId === 'P-CMS-DASHBOARD') return stateId === 'empty' ? 'reviewer' : 'editor';
      return requiredRole(pageId) === 'cms' ? 'editor' : requiredRole(pageId);
    };
    function routeFor(pageId) { return pageId.toLowerCase().replace(/^p-/, '').replace(/-/g, '/'); }
    function defaultRoute() { return { page: 'P-PUB-HOME', state: pageSpec('P-PUB-HOME').states[0].id, lang: 'fr', pageNumber: 1 }; }
    function parseRoute(hash) {
      var match = /^#\/(fr|en)\/([^?]+)(?:\?([^#]*))?$/.exec(hash || '');
      if (!match) return defaultRoute();
      var page = catalog.pages.find(function (item) { return routeFor(item.id) === match[2]; });
      if (!page) return defaultRoute();
      var pageNumber = 1;
      if (match[3]) {
        if (page.id !== 'P-PUB-SECTION') return defaultRoute();
        var params = new URLSearchParams(match[3]);
        var keys = Array.from(params.keys());
        if (keys.length !== 2 || keys.indexOf('page') < 0 || keys.indexOf('type') < 0 || params.get('type') !== 'news' || !/^[1-9]\d*$/.test(params.get('page') || '')) return defaultRoute();
        pageNumber = Number(params.get('page'));
      }
      return { page: page.id, state: page.states[0].id, lang: match[1], pageNumber: pageNumber };
    }
    function syncRoute() {
      var slug = routeFor(view.page);
      var suffix = view.page === 'P-PUB-SECTION' ? '?page=' + business.sectionPage + '&type=news' : '';
      var hash = '#/' + view.lang + '/' + slug + suffix;
      if (location.hash !== hash) history.replaceState(null, '', location.href.split('#')[0] + hash);
    }
    function updateLanguage() {
      document.documentElement.lang = view.lang;
      document.querySelectorAll('[data-i18n]').forEach(function (node) { node.textContent = node.getAttribute('data-' + view.lang); });
      document.querySelectorAll('[data-fr-placeholder]').forEach(function (node) { node.placeholder = node.getAttribute('data-' + view.lang + '-placeholder'); });
      document.querySelectorAll('[data-language],[data-language-toggle]').forEach(function (node) { node.dataset.active = String((node.dataset.language || node.dataset.languageToggle) === view.lang); });
    }
    function updateAccess() {
      var previewing = view.mode === 'preview';
      var actor = previewing ? view.previewRole : session.role;
      document.querySelectorAll('[data-roles]').forEach(function (node) {
        node.hidden = (node.dataset.roles || '').split(',').indexOf(actor || '') < 0;
      });
      var state = activeState();
      if (!state) return;
      state.querySelectorAll('[data-prototype-action="navigate-cms-page"]').forEach(function (node) {
        if (previewing) { node.hidden = false; return; }
        var needed = requiredRole(node.dataset.prototypeTarget);
        node.hidden = !session.authenticated || session.domain !== 'cms' || cmsRoles.indexOf(session.role) < 0 || (needed && needed !== 'cms' && needed !== session.role);
      });
      state.querySelectorAll('[data-prototype-action]').forEach(function (node) {
        var serviceAction = contentKernel.serviceAction(node.dataset.prototypeAction);
        if (!previewing && serviceAction) node.hidden = business.content.allowedActions.indexOf(serviceAction) < 0;
      });
      var roleNode = state.querySelector('.cms-head .role-chip');
      if (roleNode && !previewing) roleNode.textContent = session.role ? session.role.charAt(0).toUpperCase() + session.role.slice(1) : 'Visiteur';
      var shell = state.querySelector('.cms-shell');
      if (shell) shell.dataset.sessionRole = previewing ? (view.previewRole || 'preview') : (session.role || 'anonymous');
      if (!previewing && view.page === 'P-CMS-DASHBOARD') {
        var metrics = state.querySelectorAll('.metrics > div');
        metrics.forEach(function (node) { node.hidden = true; });
        if (session.role === 'editor') { if (metrics[0]) metrics[0].hidden = false; if (metrics[2]) metrics[2].hidden = false; }
        if (session.role === 'reviewer' && metrics[1]) metrics[1].hidden = false;
        if (session.role === 'publisher' && metrics[2]) { metrics[2].hidden = false; metrics[2].querySelector('span').textContent = 'À publier'; }
      }
    }
    function syncBusinessFacts(selected) {
      if (!selected) return;
      if (view.page.indexOf('P-CMS-') === 0) {
        selected.dataset.storageState = business.content.status;
        selected.dataset.workflowView = business.content.workflowView;
        selected.dataset.allowedActions = business.content.allowedActions.join(',');
        selected.dataset.lastTransition = business.content.lastTransition ? JSON.stringify(business.content.lastTransition) : '';
      } else {
        delete selected.dataset.storageState; delete selected.dataset.workflowView;
        delete selected.dataset.allowedActions; delete selected.dataset.lastTransition;
      }
      var projection = business.content.publicProjection;
      if (view.page === 'P-PUB-HOME' || view.page === 'P-PUB-SECTION' || view.page === 'P-PUB-CONTENT') {
        selected.dataset.publicProjection = projection;
        var businessRoot = selected.querySelector('[data-business-content]');
        var projected = selected.querySelector('[data-public-content-id="content-884"]');
        if (projected) projected.hidden = projection !== 'published';
        if (businessRoot) {
          var noticeNode = businessRoot.querySelector('.projection-notice');
          if (view.page === 'P-PUB-CONTENT' && view.state !== 'gone') {
            if (!noticeNode) { noticeNode = document.createElement('div'); noticeNode.className = 'notice warning projection-notice'; noticeNode.setAttribute('role', 'status'); businessRoot.insertBefore(noticeNode, businessRoot.firstChild); }
            noticeNode.hidden = projection === 'published';
            noticeNode.textContent = projection === 'archived' ? '410 · Ce contenu est archivé et retiré du portail public.' : 'Ce contenu est actuellement hors ligne.';
          } else if (noticeNode) noticeNode.hidden = true;
        }
      }
    }
    function clearTransient(state) {
      state.querySelectorAll('.inline-status').forEach(function (node) { node.textContent = ''; });
      state.querySelectorAll('.validation-message').forEach(function (node) { node.hidden = true; node.textContent = ''; });
    }
    function renderSurface(pageId, stateId, mode) {
      var spec = pageSpec(pageId);
      if (!spec || !spec.states.some(function (item) { return item.id === stateId; })) return false;
      var state = stateId;
      view.mode = mode;
      view.previewRole = mode === 'preview' ? previewRole(pageId, state) : null;
      document.querySelectorAll('#app > [data-prototype-page]').forEach(function (page) { page.hidden = page.dataset.prototypePage !== pageId; });
      var pageNode = document.querySelector('#app > [data-prototype-page="' + pageId + '"]');
      pageNode.querySelectorAll(':scope > [data-prototype-state]').forEach(function (node) { node.hidden = node.dataset.prototypeState !== state; });
      view.page = pageId; view.state = state;
      var selected = activeState();
      if (pageId === 'P-PUB-SECTION') selected.dataset.pageNumber = String(business.sectionPage);
      if (mode === 'preview') clearTransient(selected);
      syncBusinessFacts(selected); updateAccess(); updateLanguage();
      if (mode === 'customer') syncRoute();
      window.scrollTo(0, 0); return true;
    }
    function renderDesignPreview(selection) {
      var spec = selection && pageSpec(selection.page);
      if (!spec || !spec.states.some(function (item) { return item.id === selection.state; })) return false;
      previewSelection = { page: selection.page, state: selection.state };
      return renderSurface(previewSelection.page, previewSelection.state, 'preview');
    }
    function status(text) { var node = activeState().querySelector('.inline-status'); if (node) node.textContent = text; }
    function validation(text) { var node = activeState().querySelector('.validation-message'); if (node) { node.hidden = false; node.textContent = text; } }
    function deniedState() { return session.authenticated ? 'denied' : 'signed-out'; }
    function renderDenied() { return renderSurface('P-CMS-LOGIN', deniedState(), 'customer'); }
    function showEmptyDashboard() { return renderSurface('P-CMS-DASHBOARD', 'empty', 'customer'); }
    function renderCitizenSignIn(pageId, stateId) {
      if (pageId === 'P-PUB-APPLICATION-STATUS') rememberReturn(pageId, stateId);
      else rememberReturn('P-PUB-SERVICE-GUIDE', 'available');
      return renderSurface('P-PUB-ACCOUNT', 'register', 'customer');
    }
    function dashboardHasWork(role) {
      var actions = role === 'editor' ? ['edit', 'submit-review'] : role === 'reviewer' ? ['approve', 'return'] : role === 'publisher' ? ['publish', 'unpublish', 'archive'] : [];
      return contentKernel.validate(business.content).ok && actions.some(function (action) { return business.content.allowedActions.indexOf(action) >= 0; });
    }
    function customerRoute(pageId, stateId) {
      var spec = pageSpec(pageId);
      if (!spec) { var fallback = defaultRoute(); pageId = fallback.page; stateId = fallback.state; spec = pageSpec(pageId); }
      if (!spec.states.some(function (item) { return item.id === stateId; })) stateId = spec.states[0].id;
      if (citizenPages.indexOf(pageId) >= 0 && !isCitizenSession()) return renderCitizenSignIn(pageId, stateId);
      var needed = requiredRole(pageId);
      if (needed) {
        if (!session.authenticated) return renderDenied();
        if (session.domain !== 'cms' || cmsRoles.indexOf(session.role) < 0) return renderDenied();
        if (needed !== 'cms' && session.role !== needed) return renderDenied();
        var pair = business.content.status + '/' + business.content.workflowView;
        if (pageId === 'P-CMS-DASHBOARD') stateId = dashboardHasWork(session.role) ? 'role-filtered' : 'empty';
        if (pageId === 'P-CMS-EDITOR') {
          if (pair === 'draft/draft' || pair === 'draft/returned') stateId = 'draft';
          else if (!(pair === 'review/submitted' && stateId === 'submitted')) return showEmptyDashboard();
        }
        if (pageId === 'P-CMS-REVIEW') {
          if (pair === 'review/submitted') stateId = 'review-queue';
          else if (!(pair === 'review/pending-publish' && stateId === 'approved') && !(pair === 'draft/returned' && stateId === 'returned')) return showEmptyDashboard();
        }
        if (pageId === 'P-CMS-PUBLISH') {
          if (pair === 'review/pending-publish') stateId = 'pending-publish';
          else if (pair === 'published/published') stateId = 'published';
          else if (pair === 'archived/archived') stateId = 'archived';
          else return showEmptyDashboard();
        }
      }
      if (pageId === 'P-PUB-CONTENT' && business.content.publicProjection === 'archived') stateId = 'gone';
      return renderSurface(pageId, stateId, 'customer');
    }
    function rememberReturn(pageId, stateId) { session.returnTo = { pageId: pageId, stateId: stateId || pageSpec(pageId).states[0].id }; }
    function authenticateAccount(target) {
      var root = activeState();
      if (view.state === 'locked') { validation('Compte verrouillé : l’authentification reste bloquée.'); return; }
      if (view.state === 'expired') { validation('Code expiré : demandez un nouveau code.'); customerRoute('P-PUB-ACCOUNT', 'register'); return; }
      if (view.state === 'session-expired') {
        if (!session.renewAttempted) { session.renewAttempted = true; session.renewOutcome = 'failed'; app.dataset.renewalAttempts = '1'; app.dataset.renewalOutcome = 'failed'; }
        session.authenticated = false; session.domain = 'anonymous'; session.role = null;
        customerRoute('P-PUB-ACCOUNT', 'register'); validation('La reconnexion silencieuse a échoué; veuillez vous identifier.'); return;
      }
      var phone = root.querySelector('[data-prototype-field="phone"]');
      var otp = root.querySelector('[data-prototype-field="otp"]');
      if (phone) {
        if (!/^\d{8}$/.test(phone.value)) { validation('Le numéro doit contenir exactement 8 chiffres.'); return; }
        customerRoute('P-PUB-ACCOUNT', 'otp'); return;
      }
      if (otp) {
        if (!/^\d{6}$/.test(otp.value)) { validation('Le code OTP doit contenir exactement 6 chiffres.'); return; }
        session.authenticated = true; session.domain = 'citizen'; session.role = 'citizen';
        var submit = pageSpec('P-PUB-ACCOUNT').controls.find(function (control) { return control.id === 'submit'; });
        var allowed = submit.allowedReturnPageIds || [];
        var destination = session.returnTo && allowed.indexOf(session.returnTo.pageId) >= 0 ? session.returnTo : { pageId: target || submit.targetPageId, stateId: null };
        session.returnTo = null; customerRoute(destination.pageId, destination.stateId); return;
      }
      rememberReturn('P-PUB-SERVICE-GUIDE', 'available'); customerRoute('P-PUB-ACCOUNT', 'register');
    }
    function validateAttachment(input) {
      var spec = pageSpec('P-PUB-APPLICATION').fields.find(function (item) { return item.id === 'attachments'; });
      var file = input && input.files && input.files[0];
      if (!file) return 'Fichier requis : ajoutez la pièce d’identité obligatoire (PDF/JPG, 5 MB maximum).';
      if (spec.accept.indexOf(file.type) < 0) return 'Format refusé : utilisez un fichier PDF ou JPG.';
      if (file.size > spec.maxSizeMb * 1024 * 1024) return 'Fichier trop volumineux : 5 MB maximum.';
      return '';
    }
    function handleApplicationSubmit() {
      if (business.application.submitted) return;
      if (view.state === 'upstream-pending') { business.application.submitted = true; customerRoute('P-PUB-RECEIPT', 'pending'); return; }
      if (view.state !== 'details') return;
      business.application.submitted = true; customerRoute('P-PUB-APPLICATION', 'submitting');
      setTimeout(function () {
        if (view.page === 'P-PUB-APPLICATION' && view.state === 'submitting') {
          customerRoute('P-PUB-RECEIPT', 'accepted');
          activeState().dataset.operationKey = business.application.operationKey;
        }
      }, 40);
    }
    function canContent(action, role) {
      var serviceAction = contentKernel.serviceAction(action);
      return Boolean(serviceAction) && session.authenticated && session.domain === 'cms' && session.role === role && business.content.allowedActions.indexOf(serviceAction) >= 0;
    }
    function commitContentAction(action, role, reason) {
      var serviceAction = contentKernel.serviceAction(action);
      var options = { at: new Date().toISOString() };
      if (reason) options.reason = reason;
      var result = contentKernel.transition(business.content, serviceAction, { authenticated: session.authenticated, domain: session.domain, role: session.role }, options);
      if (!result.ok) return false;
      business.content = result.content;
      return true;
    }
    function canQuery(role) {
      return session.authenticated && session.domain === 'cms' && session.role === role;
    }
    function rejectContentAction(role) {
      if (!session.authenticated || session.domain !== 'cms' || session.role !== role) renderDenied();
      else showEmptyDashboard();
    }
    window.prototypeNavigate = function (pageId, stateId) { return renderDesignPreview({ page: pageId, state: stateId }); };
    var citizenBusinessActions = ['next-step', 'previous-step', 'submit-idempotent-application', 'copy-receipt', 'navigate-application-status', 'refresh-application-status'];
    window.prototypeAction = function (action, target, node) {
      if (citizenBusinessActions.indexOf(action) >= 0 && !isCitizenSession()) {
        renderCitizenSignIn(action === 'navigate-application-status' ? 'P-PUB-APPLICATION-STATUS' : view.page, action === 'navigate-application-status' ? 'processing' : view.state);
        return;
      }
      if (action === 'switch-language') { view.lang = node.dataset.language || 'fr'; updateLanguage(); syncRoute(); return; }
      if (action === 'navigate-public-page') { customerRoute(target); return; }
      if (action === 'navigate-cms-page') { customerRoute(target); return; }
      if (action === 'navigate-search' || action === 'submit-search') { var query = node.value.trim(); customerRoute('P-PUB-SEARCH', query.length >= 2 && query.length <= 64 ? 'results' : 'empty'); return; }
      if (action === 'navigate-service-guide') { customerRoute(target || 'P-PUB-SERVICE-GUIDE'); return; }
      if (action === 'navigate-content-detail') { customerRoute(target || 'P-PUB-CONTENT', 'published'); return; }
      if (action === 'navigate-section') { customerRoute(target || 'P-PUB-SECTION', 'loaded'); return; }
      if (action === 'change-page') { business.sectionPage = Math.max(1, business.sectionPage + (node.dataset.pageDirection === 'prev' ? -1 : 1)); activeState().dataset.pageNumber = String(business.sectionPage); status('Page ' + business.sectionPage + ' chargée; type news et langue conservés.'); syncRoute(); return; }
      if (action === 'reload-section') { customerRoute('P-PUB-SECTION', 'loaded'); return; }
      if (action === 'view-service-requirements') { status('Liste vérifiée : PDF/JPG, 5 MB maximum.'); return; }
      if (action === 'start-service-application') { if (!session.authenticated || session.role !== 'citizen') { rememberReturn('P-PUB-SERVICE-GUIDE', view.state === 'unavailable' ? 'available' : view.state); customerRoute('P-PUB-ACCOUNT', 'register'); } else { business.application.submitted = false; customerRoute(target || 'P-PUB-APPLICATION', 'materials'); } return; }
      if (action === 'validate-and-upload-attachment') { var issue = validateAttachment(node); if (issue) validation(issue); else { var alert = activeState().querySelector('.validation-message'); if (alert) alert.hidden = true; status('Pièce PDF/JPG conforme, taille inférieure ou égale à 5 MB.'); } return; }
      if (action === 'next-step') { var input = activeState().querySelector('[data-prototype-field="attachments"]'); var error = validateAttachment(input); if (error) validation(error); else customerRoute('P-PUB-APPLICATION', 'details'); return; }
      if (action === 'previous-step') { customerRoute('P-PUB-APPLICATION', view.state === 'details' ? 'materials' : 'details'); return; }
      if (action === 'submit-idempotent-application') { handleApplicationSubmit(); return; }
      if (action === 'copy-receipt') { if (navigator.clipboard) navigator.clipboard.writeText(business.application.receipt).catch(function () {}); status('Numéro de reçu copié : ' + business.application.receipt); return; }
      if (action === 'navigate-application-status') { customerRoute(target || 'P-PUB-APPLICATION-STATUS', 'processing'); return; }
      if (action === 'refresh-application-status') { status('Progression du reçu ' + business.application.receipt + ' actualisée.'); return; }
      if (action === 'validate-phone' || action === 'validate-otp') { authenticateAccount(target); return; }
      if (action === 'authenticate-and-return') { if (view.page !== 'P-PUB-ACCOUNT') { rememberReturn(view.page, view.state); customerRoute('P-PUB-ACCOUNT', 'register'); } else authenticateAccount(target); return; }
      if (action === 'navigate-dataset-detail') { status('Métadonnées : licence ouverte, schéma v2, mise à jour mensuelle.'); return; }
      if (action === 'authenticate-for-key-issuance') { rememberReturn('P-PUB-OPENDATA', 'catalog'); customerRoute(target || 'P-PUB-ACCOUNT', 'register'); return; }
      if (action === 'download-with-api-key') {
        if (view.state === 'unauthorized') { status('401 · Clé non valide.'); return; }
        if (view.state === 'rate-limited') { status('429 · Quota atteint; réessayez après la fenêtre de limite.'); return; }
        var key = activeState().querySelector('[data-prototype-field="apiKey"]'); status(key && key.value ? 'Téléchargement CSV préparé avec la clé active.' : 'Clé API requise avant téléchargement.'); return;
      }
      if (action === 'authenticate-cms') { if (cmsRoles.indexOf(node.dataset.role) < 0) { renderDenied(); return; } session.authenticated = true; session.domain = 'cms'; session.role = node.dataset.role; session.returnTo = null; customerRoute(target || 'P-CMS-DASHBOARD', 'role-filtered'); return; }
      if (action === 'create-content-draft' || action === 'navigate-lang-pair-editor') { customerRoute(target || 'P-CMS-EDITOR', 'draft'); return; }
      if (action === 'navigate-review-queue') { customerRoute(target || 'P-CMS-REVIEW', 'review-queue'); return; }
      if (action === 'switch-lang-pair-language') { if (!canContent(action, 'editor') || !commitContentAction(action, 'editor')) { rejectContentAction('editor'); return; } status(node.dataset.langTab === 'en' ? 'English selected.' : 'Français sélectionné.'); return; }
      if (action === 'add-content-block') {
        if (!canContent(action, 'editor') || !commitContentAction(action, 'editor')) { rejectContentAction('editor'); return; }
        var panel = activeState().querySelector('.editor-panel'); var block = document.createElement('div');
        block.className = 'content-block dynamic-block'; block.innerHTML = '<span>❝ CITATION</span><p>Nouvelle citation éditoriale.</p>';
        panel.insertBefore(block, panel.querySelector('.actions')); business.content.blocks += 1; activeState().dataset.blockCount = String(business.content.blocks); status('Bloc citation ajouté.'); return;
      }
      if (action === 'save-draft-with-revision') {
        if (!canContent(action, 'editor')) { rejectContentAction('editor'); return; }
        if (view.state === 'conflict') { status('409 · Révision distante détectée; fusion requise.'); return; }
        if (!commitContentAction(action, 'editor')) { rejectContentAction('editor'); return; }
        business.content.revision += 1; activeState().dataset.revision = String(business.content.revision); status('Brouillon révision ' + business.content.revision + ' enregistré.'); return;
      }
      if (action === 'submit-content-review') { if (!canContent(action, 'editor') || !commitContentAction(action, 'editor')) { rejectContentAction('editor'); return; } customerRoute('P-CMS-EDITOR', 'submitted'); return; }
      if (action === 'view-read-only-content') { if (!canQuery('reviewer')) { rejectContentAction('reviewer'); return; } status('Détail ouvert en lecture seule.'); return; }
      if (action === 'approve-for-publish') { if (!canContent(action, 'reviewer') || !commitContentAction(action, 'reviewer')) { rejectContentAction('reviewer'); return; } customerRoute('P-CMS-REVIEW', 'approved'); return; }
      if (action === 'return-to-draft') { if (!canContent(action, 'reviewer') || !commitContentAction(action, 'reviewer')) { rejectContentAction('reviewer'); return; } customerRoute('P-CMS-REVIEW', 'returned'); return; }
      if (action === 'publish-with-preflight') { if (!canContent(action, 'publisher')) { rejectContentAction('publisher'); return; } if (view.state === 'preflight-failed') return; if (!commitContentAction(action, 'publisher')) { rejectContentAction('publisher'); return; } customerRoute('P-CMS-PUBLISH', 'published'); return; }
      if (action === 'unpublish-content') { if (!canContent(action, 'publisher') || !commitContentAction(action, 'publisher')) { rejectContentAction('publisher'); return; } customerRoute('P-CMS-PUBLISH', 'pending-publish'); return; }
      if (action === 'archive-content') { if (!canContent(action, 'publisher') || !commitContentAction(action, 'publisher')) { rejectContentAction('publisher'); return; } customerRoute('P-CMS-PUBLISH', 'archived'); return; }
      if (action === 'view-audit-records') { if (!canQuery('publisher')) { rejectContentAction('publisher'); return; } status('Audit : Publisher · 10.4.8.21 · contenu 884 · 11:26.'); return; }
    };
    app.addEventListener('click', function (event) {
      var control = event.target.closest('[data-prototype-control]'); if (!control || control.tagName === 'INPUT') return;
      event.preventDefault(); window.prototypeAction(control.dataset.prototypeAction, control.dataset.prototypeTarget, control);
    });
    app.addEventListener('keydown', function (event) {
      var control = event.target.closest('input[data-prototype-control]'); if (!control || event.key !== 'Enter') return;
      if (control.disabled || control.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      event.preventDefault(); window.prototypeAction(control.dataset.prototypeAction, control.dataset.prototypeTarget, control);
    });
    app.addEventListener('change', function (event) {
      var control = event.target.closest('input[data-prototype-control]');
      if (control && control.dataset.prototypeAction === 'validate-and-upload-attachment') window.prototypeAction(control.dataset.prototypeAction, control.dataset.prototypeTarget, control);
    });
    window.addEventListener('message', function (event) { var data = event.data || {}; if (event.source === parent && data.type === 'v19-prototype-select') renderDesignPreview({ page: data.pageId, state: data.stateId }); });
    window.addEventListener('hashchange', function () { var route = parseRoute(location.hash); view.lang = route.lang; business.sectionPage = route.pageNumber; customerRoute(route.page, route.state); });
    var initialRoute = parseRoute(location.hash); view.lang = initialRoute.lang; business.sectionPage = initialRoute.pageNumber; customerRoute(initialRoute.page, initialRoute.state);
  }

  var renderers = {
    'P-PUB-HOME': home, 'P-PUB-SECTION': sectionPage, 'P-PUB-CONTENT': contentPage,
    'P-PUB-ARCHIVE': archivePage, 'P-PUB-SERVICE-GUIDE': guide, 'P-PUB-APPLICATION': application,
    'P-PUB-RECEIPT': receipt, 'P-PUB-APPLICATION-STATUS': statusPage, 'P-PUB-ACCOUNT': account,
    'P-PUB-SEARCH': searchPage, 'P-PUB-OPENDATA': openData, 'P-CMS-LOGIN': cmsLogin,
    'P-CMS-DASHBOARD': dashboard, 'P-CMS-EDITOR': editor, 'P-CMS-REVIEW': review, 'P-CMS-PUBLISH': publish
  };
  var pagesHTML = catalog.pages.map(function (page) {
    return '<section data-prototype-page="' + esc(page.id) + '"' + (page.id === 'P-PUB-HOME' ? '' : ' hidden') + '>' +
      page.states.map(function (state, index) {
        return '<section data-prototype-state="' + esc(state.id) + '"' + (page.id === 'P-PUB-HOME' && index === 0 ? '' : ' hidden') + '>' + renderers[page.id](page, state) + '</section>';
      }).join('') + '</section>';
  }).join('');
  var catalogJSON = JSON.stringify(catalog).replace(/</g, '\\u003c');
  var css = `
:root{--forest:#064f3b;--green:#087356;--red:#c31834;--gold:#efc247;--ink:#17251f;--muted:#617169;--line:#d6dfd8;--paper:#fffdf8;--wash:#f3f5ef;--white:#fff;--shadow:0 16px 45px rgba(16,46,35,.09)}
*{box-sizing:border-box}html{background:var(--wash)}body{margin:0;overflow-x:hidden;background:var(--wash);color:var(--ink);font:16px/1.58 Georgia,'Times New Roman',serif}button,input{font:inherit}button,a,input{max-width:100%}button,a{cursor:pointer}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid var(--gold);outline-offset:3px}[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.mast{background:linear-gradient(105deg,#043e31,var(--green));color:white;border-bottom:5px solid var(--gold)}.mast-inner,.nav-inner,.content-wrap,.footer{width:min(1160px,calc(100% - 40px));margin:auto}.mast-inner{min-height:78px;display:flex;align-items:center;gap:14px}.crest{width:50px;height:50px;border:2px solid var(--gold);border-radius:50%;display:grid;place-items:center;position:relative;background:var(--red);font:700 13px/1 system-ui}.crest span{position:absolute;bottom:4px;font-size:9px;color:var(--gold)}.brand strong,.brand small{display:block}.brand strong{font-size:20px}.brand small{font-size:12px;opacity:.85}.language-group{margin-left:auto;display:flex;gap:4px}.language-group button{border:1px solid rgba(255,255,255,.35);background:transparent;color:white;border-radius:3px;padding:6px 10px}.language-group button[data-active=true]{background:var(--gold);color:var(--ink)}
.public-nav{background:white;border-bottom:1px solid var(--line)}.nav-inner{min-height:54px;display:flex;align-items:stretch}.nav-inner>button{border:0;background:transparent;padding:0 16px;color:var(--forest);font-weight:bold}.nav-inner>button:hover{background:#eaf2ed}.header-search{margin-left:auto;display:flex;align-items:center}.header-search input{width:220px;border:1px solid var(--line);border-radius:4px;padding:9px 12px}.page-main{min-height:610px}.content-wrap{padding:42px 0 70px}.narrow{max-width:900px}.kicker{display:block;color:var(--red);font:800 12px/1.25 system-ui,sans-serif;letter-spacing:.13em;margin-bottom:10px}h1,h2,h3,p{overflow-wrap:anywhere}h1{font-size:clamp(30px,4vw,48px);line-height:1.08;margin:.15em 0 .55em}h2{line-height:1.22}.home-grid{display:grid;grid-template-columns:1.6fr 1fr;gap:18px}.hero,.agenda,.panel,.service-card,.story-list,.receipt-card,.dataset,.archive-card,.account-card,.search-result,.empty-state{background:var(--paper);border:1px solid var(--line);box-shadow:var(--shadow)}.hero{padding:48px;border-top:7px solid var(--red);background:linear-gradient(135deg,#fff7d9,#fffdf8 62%,#e7f2ec)}.hero p{max-width:650px;color:var(--muted);font-size:18px}.agenda{padding:28px;border-left:6px solid var(--gold)}.agenda ol{padding:0;list-style:none}.agenda li{padding:12px 0;border-bottom:1px solid var(--line)}.agenda time{font:bold 13px system-ui;margin-right:9px;color:var(--green)}.section-block{margin-top:42px}.section-title{display:flex;align-items:center;gap:12px}.section-title>span{color:var(--red);font:bold 20px system-ui}.service-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}.service-card{padding:23px;border-top:5px solid var(--green)}.service-card:nth-child(2){border-top-color:var(--red)}.service-card:nth-child(3){border-top-color:var(--gold)}.service-icon{font-size:28px;color:var(--green)}.action,.action-link{display:inline-flex;align-items:center;justify-content:center;min-height:42px;border:1px solid var(--green);border-radius:4px;padding:9px 14px;background:white;color:var(--green);font-weight:bold;text-decoration:none}.action.primary{background:var(--green);color:white}.action.danger{border-color:var(--red);color:var(--red)}.action:disabled{cursor:not-allowed;opacity:.55}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:20px}.notice{margin:18px 0;padding:14px 16px;border-left:5px solid}.notice.warning{background:#fff3d1;border-color:#bd7c00}.notice.error{background:#ffedef;border-color:var(--red)}.notice.info{background:#e9f1f7;border-color:#2d6f9d}.notice.success{background:#e5f3e9;border-color:var(--green)}.footer{display:flex;justify-content:space-between;gap:20px;padding:28px 0 90px;border-top:1px solid var(--line);color:var(--muted)}.footer p{margin:4px 0}.mobile-quick{display:none}.skeleton{height:110px;margin:16px 0;border-radius:5px;background:linear-gradient(95deg,#e4e9e5,#fafbf9,#e4e9e5);background-size:300% 100%;animation:shimmer 1.2s linear infinite}.skeleton.short{height:75px}@keyframes shimmer{to{background-position:-150% 0}}
.story-list{padding:0 26px}.story-list article{padding:24px 0;border-bottom:1px solid var(--line)}.story-list time{color:var(--red);font:bold 12px system-ui}.pager{display:flex;justify-content:space-between;margin-top:18px}.article{font-size:18px}.article .lede{font-size:21px;color:var(--forest)}.archive-card{display:grid;grid-template-columns:150px 1fr;gap:25px;padding:34px}.http-code{font:900 76px/.9 system-ui;color:var(--red)}.guide-grid,.data-grid{display:grid;grid-template-columns:1.6fr .8fr;gap:18px}.panel,.dataset{padding:28px}.guide-aside,.quota{padding:25px;background:var(--forest);color:white}.checklist li{padding:7px 0}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:16px}.steps span{border-top:5px solid var(--line);padding-top:7px;color:var(--muted);font:bold 12px system-ui}.steps .active{border-color:var(--green);color:var(--green)}label{display:block;font-weight:bold;margin:16px 0 6px}input[type=text],input[type=tel],input[type=search],input[type=password],input[type=file]{width:100%;min-width:0;border:1px solid #9daf9f;border-radius:4px;padding:11px;background:white}.summary{display:grid;grid-template-columns:140px 1fr}.summary dt,.summary dd{margin:0;padding:8px;border-bottom:1px solid var(--line)}.receipt-card{padding:38px;border-top:7px solid var(--green)}.receipt-number{font:800 clamp(20px,5vw,30px) ui-monospace,monospace;letter-spacing:.05em;background:#e6f1eb;padding:16px;overflow-wrap:anywhere}.status-badge{display:inline-block;background:#e5f2e9;color:var(--forest);border-radius:99px;padding:5px 10px;font:bold 12px system-ui}.timeline{border-left:3px solid var(--green);padding-left:25px}.timeline li{padding:14px 0 14px 7px}.timeline li::marker{color:var(--green)}.timeline small,.account-card small{display:block;color:var(--muted)}.account-wrap{max-width:680px}.account-card{padding:38px}.search-large{padding:20px;background:var(--forest);color:white}.search-result,.empty-state{margin-top:20px;padding:25px}.dataset-meta{display:flex;gap:8px;flex-wrap:wrap}.dataset-meta span{background:#e7f0ea;padding:3px 8px;font:700 11px system-ui}.quota strong,.quota span{display:block}.quota strong{font:800 70px/1 system-ui;color:var(--gold)}
.cms-shell{min-height:100vh;background:#f1f3f2;font-family:'Segoe UI',Tahoma,sans-serif}.cms-head{height:72px;display:flex;align-items:center;gap:12px;padding:0 28px;background:#1e2e29;color:white;border-bottom:4px solid var(--gold)}.cms-mark{width:39px;height:39px;display:grid;place-items:center;border:2px solid var(--gold);border-radius:50%;background:var(--red);font-weight:bold}.cms-head small{display:block;color:#b8c6c0}.role-chip{margin-left:auto;border:1px solid #6f8179;border-radius:99px;padding:5px 10px;font-size:12px}.cms-layout{display:grid;grid-template-columns:230px minmax(0,1fr);min-height:calc(100vh - 72px)}.cms-side{background:#20342e;color:white;padding:28px 14px}.cms-side>b{display:block;color:#91a59c;font-size:11px;letter-spacing:.12em;padding:0 10px 12px}.cms-side button{display:block;width:100%;border:0;border-radius:3px;background:transparent;color:white;text-align:left;padding:11px}.cms-side button:hover{background:#315247}.cms-main{min-width:0;padding:34px;max-width:1250px;width:100%}.cms-title{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.cms-title h1{font-size:36px}.date-chip{font-weight:bold;color:var(--muted)}.login-card{max-width:700px;margin:45px auto;padding:40px;background:white;border:1px solid var(--line);box-shadow:var(--shadow)}.role-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:24px}.role-grid button{min-height:85px}.security-note{color:var(--muted);font-size:13px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.metrics>div{background:white;border:1px solid var(--line);padding:20px}.metrics strong,.metrics span{display:block}.metrics strong{font-size:34px;color:var(--green)}.worklist,.review-card,.publish-card,.editor-panel,.editor-guide{background:white;border:1px solid var(--line);padding:24px;margin-top:20px}.editor-layout{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:16px}.editor-guide{margin-top:0}.tabs{display:flex;gap:5px;border-bottom:1px solid var(--line);padding-bottom:10px}.content-block{border:1px dashed #8ea197;padding:15px;margin:13px 0;background:#fbfcfa}.content-block>span{font:bold 11px system-ui;color:var(--muted)}.diff{display:grid;grid-template-columns:1fr 1fr;gap:10px}.diff section{background:#f7f8f6;padding:18px;border-top:4px solid var(--green)}.review-card header{display:flex;justify-content:space-between;gap:20px}.preflight{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.preflight>div{background:#f6f8f5;padding:14px}.preflight b,.preflight span{display:block}.preflight span{color:var(--muted);font-size:13px}
@media(max-width:950px){.home-grid,.guide-grid,.data-grid,.editor-layout{grid-template-columns:1fr}.service-grid,.metrics{grid-template-columns:repeat(2,1fr)}.cms-layout{grid-template-columns:180px minmax(0,1fr)}.preflight{grid-template-columns:repeat(2,1fr)}}
@media(max-width:767px){.mast-inner,.nav-inner,.content-wrap,.footer{width:min(100% - 28px,1160px)}.mast-inner{min-height:68px}.crest{width:42px;height:42px}.brand strong{font-size:16px}.brand small{display:none}.public-nav{overflow:auto}.nav-inner{width:max-content;min-width:100%;min-height:48px}.nav-inner>button{white-space:nowrap;padding:0 11px}.header-search{display:none}.content-wrap{padding-top:27px}.home-grid,.service-grid,.metrics{grid-template-columns:1fr}.hero{padding:26px}.agenda{padding:22px}.archive-card{grid-template-columns:1fr;padding:24px}.http-code{font-size:55px}.summary{grid-template-columns:1fr}.summary dt{font-weight:bold;border-bottom:0;padding-bottom:0}.account-card,.receipt-card{padding:24px}.footer{display:block;padding-bottom:88px}.mobile-quick{position:fixed;z-index:20;display:flex;bottom:0;left:0;right:0;background:white;border-top:3px solid var(--green);padding:7px;gap:6px;box-shadow:0 -8px 25px rgba(0,0,0,.1)}.mobile-quick button{flex:1;border:0;background:white;color:var(--forest);padding:8px}.cms-layout{grid-template-columns:1fr}.cms-side{display:none}.cms-main{padding:20px}.diff,.role-grid,.preflight{grid-template-columns:1fr}.review-card header,.cms-title{display:block}}
`;
  var runtime = 'window.__V19_CATALOG__=' + catalogJSON + ';' + createCustomerStateKernel.toString() + ';(' + customerRuntime.toString() + ')();';
  var closeScript = '<' + '/script>';
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Portail national du Cameroun</title><style>' + css + '</style></head><body><div id="app">' + pagesHTML + '</div><script>' + runtime + closeScript + '</body></html>';
}

function v19BuildCandidateHTML(){return v19BuildImplementationHTML(V19_BUILD_IMPLEMENTATION_SPEC).replace('<html','<html data-build-candidate="V1.9"');}
