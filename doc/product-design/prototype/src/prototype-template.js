/* 客户门户独立原型维护源：生成阶段输出完整业务 DOM，运行时仅切换已有页态。 */
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
function v19CustomerPrototypeHTML(catalog) {
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
