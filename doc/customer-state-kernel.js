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
