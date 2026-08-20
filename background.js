import { PermissionManager } from './permission_manager.js';
import { InjectionGuard } from './injection_guard.js';
import { WorkflowRecorder } from './workflow_recorder.js';

const attachedTabs = new Set();

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] ? tabs[0].id : null);
    });
  });
}

// Lê o modo de operação atual (plan / normal / autonomous) gravado pelo popup
function getAurexModeFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["aurex_mode"], (result) => {
      resolve((result && result.aurex_mode) || "plan");
    });
  });
}

function ensureDebuggerAttached(tabId) {
  return new Promise((resolve, reject) => {
    if (attachedTabs.has(tabId)) {
      return resolve();
    }
    chrome.debugger.attach({ tabId: tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      attachedTabs.add(tabId);
      resolve();
    });
  });
}

chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
});

function executeCDPCommand(tabId, command, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId: tabId }, command, params, (result) => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      resolve(result);
    });
  });
}

// Roles interativos: sempre mantidos, mesmo sem nome acessível (um combobox
// ou checkbox sem rótulo continua sendo clicável e precisa aparecer na árvore).
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "option",
  "checkbox", "radio", "switch", "slider", "spinbutton", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "textarea"
]);

// Roles puramente textuais: só entram se ainda houver orçamento, porque são
// a maior fonte de ruído (e de estouro de contexto) numa página real.
const TEXT_ROLES = new Set(["StaticText", "text", "paragraph", "LineBreak", "InlineTextBox"]);

function axProperty(node, name) {
  if (!node.properties) return undefined;
  var found = node.properties.find(function (p) { return p.name === name; });
  return found && found.value ? found.value.value : undefined;
}

// Extrai um nó da árvore de acessibilidade preservando o que o resolver de
// elementos precisa: hierarquia, estado e a que frame pertence.
function mapAXNode(node, frameId) {
  var role = node.role && node.role.value;
  var mapped = {
    id: node.backendDOMNodeId, // ID crucial para interações futuras
    role: role,
    name: (node.name && node.name.value) || ""
  };

  if (frameId) mapped.frameId = frameId;

  var value = node.value && node.value.value;
  if (value !== undefined && value !== "") mapped.value = String(value).substring(0, 200);

  var description = node.description && node.description.value;
  if (description) mapped.description = String(description).substring(0, 120);

  if (node.parentId) mapped.parentId = node.parentId;
  if (node.nodeId) mapped.axId = node.nodeId;

  // Estado — só incluímos o que for verdadeiro/relevante, para não inflar o JSON
  var disabled = axProperty(node, "disabled");
  if (disabled === true) mapped.disabled = true;
  var checked = axProperty(node, "checked");
  if (checked !== undefined && checked !== "false") mapped.checked = checked;
  var expanded = axProperty(node, "expanded");
  if (expanded !== undefined) mapped.expanded = expanded;
  var required = axProperty(node, "required");
  if (required === true) mapped.required = true;
  var focusable = axProperty(node, "focusable");
  if (focusable === true) mapped.focusable = true;
  var level = axProperty(node, "level");
  if (level !== undefined) mapped.level = level;

  return mapped;
}

function isUsefulAXNode(node) {
  if (node.ignored) return false;
  if (!node.backendDOMNodeId) return false;
  var role = node.role && node.role.value;
  if (INTERACTIVE_ROLES.has(role)) return true;
  // Nós não interativos só valem se tiverem nome (rótulo, cabeçalho, texto)
  return !!(node.name && node.name.value);
}

// Caminho curto de ancestrais ("form > fieldset"). É o que permite distinguir
// dois botões "Salvar" em seções diferentes da mesma página.
const CONTEXT_ROLES = new Set([
  'form', 'dialog', 'navigation', 'main', 'banner', 'contentinfo', 'search',
  'table', 'list', 'article', 'region', 'tabpanel', 'group', 'menu', 'complementary'
]);

function attachAncestorPaths(nodes) {
  var byAxId = new Map();
  nodes.forEach(function (node) {
    if (node.axId) byAxId.set(String(node.axId), node);
  });

  nodes.forEach(function (node) {
    var trail = [];
    var current = node.parentId ? byAxId.get(String(node.parentId)) : null;
    var depth = 0;
    while (current && depth < 12 && trail.length < 3) {
      if (CONTEXT_ROLES.has(current.role)) {
        var label = current.name ? current.role + '[' + current.name.substring(0, 24) + ']' : current.role;
        trail.unshift(label);
      }
      current = current.parentId ? byAxId.get(String(current.parentId)) : null;
      depth++;
    }
    if (trail.length) node.context = trail.join(' > ');
  });
  return nodes;
}

function filterAXTree(nodes, frameId) {
  var mapped = nodes.filter(isUsefulAXNode).map(function (node) {
    return mapAXNode(node, frameId);
  });
  return attachAncestorPaths(mapped);
}

// Envia um comando CDP diretamente a um TARGET (não à aba).
// Necessário para iframes cross-origin: eles rodam num processo separado
// (OOPIF) e a sessão da aba não alcança a árvore deles.
function executeCDPOnTarget(targetId, command, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ targetId: targetId }, command, params, (result) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(result);
    });
  });
}

function attachToTarget(targetId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ targetId: targetId }, "1.3", () => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve();
    });
  });
}

function detachTarget(targetId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ targetId: targetId }, () => {
      void chrome.runtime.lastError; // já desanexado é aceitável
      resolve();
    });
  });
}

// Última tentativa para um frame cross-origin: anexar ao target do próprio
// iframe. Para OOPIFs o targetId coincide com o frameId.
async function readAXTreeViaTarget(frameId) {
  var attached = false;
  try {
    await attachToTarget(frameId);
    attached = true;
    var res = await executeCDPOnTarget(frameId, "Accessibility.getFullAXTree");
    return filterAXTree(res.nodes || [], frameId);
  } catch (e) {
    return [];
  } finally {
    if (attached) await detachTarget(frameId);
  }
}

// Lê a árvore de acessibilidade de TODOS os frames da aba, não só do principal.
// Sem isto, conteúdo dentro de iframe (comum em LMS, players de PDF e
// checkouts) fica invisível para clique e digitação.
async function getAccessibilityTreeAllFrames(tabId) {
  await executeCDPCommand(tabId, "DOM.enable");

  var frameIds = [];
  try {
    var frameTree = await executeCDPCommand(tabId, "Page.getFrameTree");
    (function collect(entry) {
      if (!entry || !entry.frame) return;
      frameIds.push(entry.frame.id);
      (entry.childFrames || []).forEach(collect);
    })(frameTree && frameTree.frameTree);
  } catch (e) {
    // Page domain indisponível: seguimos só com o frame principal
  }

  var combined = [];
  var framesRead = 0;
  var crossOriginFrames = 0;

  if (frameIds.length === 0) {
    var main = await executeCDPCommand(tabId, "Accessibility.getFullAXTree");
    combined = filterAXTree(main.nodes || []);
    framesRead = 1;
  } else {
    for (var i = 0; i < frameIds.length; i++) {
      var nodes = [];
      try {
        var res = await executeCDPCommand(tabId, "Accessibility.getFullAXTree", { frameId: frameIds[i] });
        nodes = filterAXTree(res.nodes || [], frameIds[i]);
      } catch (e) {
        nodes = []; // provavelmente OOPIF: tratado abaixo
      }

      // Frame que não respondeu pela sessão da aba costuma ser cross-origin.
      // Tentamos alcançá-lo pelo target dele antes de desistir.
      if (!nodes.length && i > 0) {
        nodes = await readAXTreeViaTarget(frameIds[i]);
        if (nodes.length) crossOriginFrames++;
      }

      if (nodes.length) {
        combined = combined.concat(nodes);
        framesRead++;
      }
    }
  }

  // Remove duplicatas por backendDOMNodeId (um nó pode aparecer em mais de
  // uma leitura quando frames se sobrepõem)
  var seen = new Set();
  var unique = [];
  for (var j = 0; j < combined.length; j++) {
    var key = combined[j].id;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(combined[j]);
  }

  return {
    tree: unique,
    framesRead: framesRead,
    framesTotal: frameIds.length || 1,
    crossOriginFrames: crossOriginFrames
  };
}

// ========== ELEMENT RESOLVER ==========
// Traduz uma descrição em linguagem natural ("o botão de login") no elemento
// certo da página, com pontuação de confiança — em vez de o modelo ter que
// copiar um id de uma árvore inteira despejada no contexto.

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    // Pontua\u00e7\u00e3o vira espa\u00e7o para "email" casar com "e-mail" e
    // "MAPA" casar com "M.A.P.A"
    .replace(/[.\-_/\\|:,;!?()[\]{}'"\u00ab\u00bb]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Vers\u00e3o sem espa\u00e7os, para casar siglas escritas de formas diferentes
// ("m a p a" vs "mapa")
function compactText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

// Palavras sem valor discriminante numa descrição ("clique no botão de login")
const RESOLVER_STOPWORDS = new Set([
  "o", "a", "os", "as", "de", "do", "da", "dos", "das", "no", "na", "nos", "nas",
  "em", "um", "uma", "para", "por", "com", "que", "e", "ou", "clique", "clicar",
  "clica", "digite", "digitar", "preencha", "preencher", "abra", "abrir",
  "selecione", "selecionar", "the", "click", "on", "in", "of", "to", "button",
  "link", "field", "campo", "icone", "icon"
]);

// Pistas de role dentro da própria descrição do usuário
const ROLE_HINTS = [
  { words: ["botao", "button", "botão"], roles: ["button", "link"] },
  { words: ["link", "atalho"], roles: ["link", "button"] },
  { words: ["campo", "input", "caixa", "field", "textbox"], roles: ["textbox", "searchbox", "combobox", "textarea"] },
  { words: ["busca", "pesquisa", "search", "procurar"], roles: ["searchbox", "textbox", "combobox"] },
  { words: ["menu", "dropdown", "lista", "select"], roles: ["combobox", "listbox", "menuitem", "option"] },
  { words: ["caixa de selecao", "checkbox", "marcar"], roles: ["checkbox", "switch"] },
  { words: ["aba", "tab", "guia"], roles: ["tab"] }
];

// Além dos roles, devolve as palavras que serviram como pista de tipo: elas
// NÃO devem ser exigidas no texto do elemento ("botão Entrar" procura um
// elemento chamado "Entrar", não um chamado "botão Entrar").
function inferRolesFromQuery(normalizedQuery) {
  var roles = [];
  var consumed = [];
  ROLE_HINTS.forEach(function (hint) {
    hint.words.forEach(function (w) {
      var normalized = normalizeText(w);
      if (normalized && normalizedQuery.indexOf(normalized) !== -1) {
        hint.roles.forEach(function (r) { if (roles.indexOf(r) === -1) roles.push(r); });
        normalized.split(" ").forEach(function (part) {
          if (consumed.indexOf(part) === -1) consumed.push(part);
        });
      }
    });
  });
  return { roles: roles, consumed: consumed };
}

// Pontua o quanto um nó corresponde à descrição. Combina correspondência de
// texto, compatibilidade de role, estado e interatividade.
function scoreCandidate(node, ctx) {
  var haystack = normalizeText([node.name, node.value, node.description].filter(Boolean).join(" "));
  var compactHaystack = compactText(haystack);
  if (!haystack && !ctx.wantedRoles.length) return null;

  var score = 0;
  var reasons = [];
  var textMatched = false;

  // --- Texto ---
  if (haystack && ctx.query) {
    if (haystack === ctx.query) {
      score += 100; reasons.push("texto exato"); textMatched = true;
    } else if (haystack.indexOf(ctx.query) === 0) {
      score += 70; reasons.push("comeca com o texto"); textMatched = true;
    } else if (haystack.indexOf(ctx.query) !== -1) {
      score += 55; reasons.push("contem o texto"); textMatched = true;
    } else if (ctx.compactQuery && compactHaystack.indexOf(ctx.compactQuery) !== -1) {
      // Casa siglas escritas de formas diferentes (MAPA / M.A.P.A)
      score += 60; reasons.push("sigla equivalente"); textMatched = true;
    }

    // Cobertura por palavra: robusto a ordem e a palavras extras
    if (ctx.terms.length) {
      var hit = ctx.terms.filter(function (t) {
        return haystack.indexOf(t) !== -1 || compactHaystack.indexOf(t) !== -1;
      });
      if (hit.length) {
        textMatched = true;
        score += Math.round((hit.length / ctx.terms.length) * 45);
        if (hit.length === ctx.terms.length) { score += 12; reasons.push("todas as palavras"); }
        else reasons.push(hit.length + "/" + ctx.terms.length + " palavras");
      }
    }

    // Penaliza rótulo muito mais longo que a busca (provável match acidental)
    if (haystack.length > ctx.query.length * 6) score -= 10;
  }

  // Se a busca tem texto e NADA casou, este não é um candidato — devolver
  // elementos aleatórios com ar de confiança é pior que não achar nada.
  if (ctx.terms.length && !textMatched) return null;

  // --- Role ---
  if (ctx.wantedRoles.length) {
    if (ctx.wantedRoles.indexOf(node.role) !== -1) { score += 30; reasons.push("tipo compativel"); }
    else if (INTERACTIVE_ROLES.has(node.role)) score += 5;
    else score -= 18;
  } else if (INTERACTIVE_ROLES.has(node.role)) {
    score += 15;
  }

  // --- Contexto (desempata "Salvar" do formulário vs "Salvar" do menu) ---
  if (node.context && ctx.terms.length) {
    var contextText = normalizeText(node.context);
    var contextHits = ctx.terms.filter(function (term) { return contextText.indexOf(term) !== -1; });
    if (contextHits.length) {
      score += 14;
      reasons.push("contexto: " + node.context);
    }
  }

  // --- Estado / interatividade ---
  if (node.disabled) { score -= 35; reasons.push("desabilitado"); }
  if (node.focusable) score += 6;
  if (!INTERACTIVE_ROLES.has(node.role)) score -= 8;

  if (score <= 0) return null;
  return { score: score, reasons: reasons };
}

function resolveElements(tree, query, roleFilter, limit) {
  var normalizedQuery = normalizeText(query);
  var inferred = inferRolesFromQuery(normalizedQuery);
  var wantedRoles = roleFilter ? [roleFilter] : inferred.roles;

  // Descarta palavras vazias E as que já foram consumidas como pista de tipo
  var terms = normalizedQuery.split(" ").filter(function (t) {
    return t.length > 1 &&
      !RESOLVER_STOPWORDS.has(t) &&
      inferred.consumed.indexOf(t) === -1;
  });

  var effectiveQuery = terms.join(" ");
  var ctx = {
    query: effectiveQuery,
    compactQuery: compactText(effectiveQuery),
    terms: terms,
    wantedRoles: wantedRoles
  };

  var scored = [];
  tree.forEach(function (node) {
    var result = scoreCandidate(node, ctx);
    if (!result) return;
    scored.push({
      id: node.id,
      role: node.role,
      name: node.name,
      value: node.value,
      context: node.context,
      frameId: node.frameId,
      disabled: node.disabled || undefined,
      score: result.score,
      why: result.reasons.join(", ")
    });
  });

  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, limit || 3);
}

// ========== INTERRUPÇÕES (BANNERS DE CONSENTIMENTO E MODAIS) ==========
// Banner de cookie é o bloqueador prático mais comum: além de sobrecarregar
// a leitura com texto jurídico irrelevante, muitos travam a página até
// alguém clicar. Detectamos e resolvemos antes de o agente tentar trabalhar.
const CONSENT_ACCEPT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#onetrust-reject-all-handler',
  '.ot-pc-refuse-all-handler',
  'button[id*="accept" i][id*="cookie" i]',
  'button[class*="accept" i][class*="cookie" i]',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonDecline',
  'button[data-testid="uc-accept-all-button"]',
  'button[aria-label*="aceitar" i]',
  'button[aria-label*="accept" i]',
  '.cc-allow', '.cc-dismiss', '.js-accept-cookies',
  '#didomi-notice-agree-button',
  '.fc-cta-consent'
];

// Textos usados nos botões, para o caso de nenhum seletor conhecido bater
const CONSENT_TEXTS = [
  'aceitar todos', 'aceitar tudo', 'aceitar cookies', 'aceitar e continuar',
  'accept all', 'accept cookies', 'i accept', 'allow all',
  'concordo', 'entendi', 'ok, entendi', 'prosseguir',
  'aceptar todo', 'aceptar cookies'
];

async function dismissInterruptions(tabId) {
  var expression = `(function(){
    var accepted = null;
    var SELECTORS = ${JSON.stringify(CONSENT_ACCEPT_SELECTORS)};
    var TEXTS = ${JSON.stringify(CONSENT_TEXTS)};

    function visible(el) {
      if (!el) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      var style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    var CONSENT_WORDS = ['cookie', 'consent', 'consentimento', 'privacy', 'privacidade', 'lgpd', 'gdpr'];

    // Um aviso de consentimento quase sempre está num container cujo id/classe
    // menciona cookie/consent/lgpd, ou flutua sobre a página (fixed/sticky).
    function looksLikeConsentContext(node) {
      var el = node;
      for (var depth = 0; el && depth < 8; depth++) {
        var id = (el.id || '').toLowerCase();
        var cls = (el.className && el.className.toString ? el.className.toString() : '').toLowerCase();
        var aria = (el.getAttribute && el.getAttribute('aria-label') || '').toLowerCase();
        for (var w = 0; w < CONSENT_WORDS.length; w++) {
          if (id.indexOf(CONSENT_WORDS[w]) !== -1 ||
              cls.indexOf(CONSENT_WORDS[w]) !== -1 ||
              aria.indexOf(CONSENT_WORDS[w]) !== -1) {
            return true;
          }
        }
        try {
          var pos = getComputedStyle(el).position;
          if (pos === 'fixed' || pos === 'sticky') return true;
        } catch (e) {}
        if (el.getAttribute && el.getAttribute('role') === 'dialog') return true;
        el = el.parentElement;
      }
      return false;
    }

    for (var i = 0; i < SELECTORS.length && !accepted; i++) {
      try {
        var el = document.querySelector(SELECTORS[i]);
        if (visible(el)) { el.click(); accepted = SELECTORS[i]; }
      } catch (e) {}
    }

    if (!accepted) {
      var buttons = Array.prototype.slice.call(
        document.querySelectorAll('button, [role="button"], a[href="#"], input[type="button"], input[type="submit"]')
      ).slice(0, 400);
      for (var b = 0; b < buttons.length && !accepted; b++) {
        var node = buttons[b];
        if (!visible(node)) continue;
        // innerText cobre o caso comum, mas botões rotulados por aria-label
        // (ícone + texto oculto) ficariam de fora sem os outros fallbacks.
        var label = (node.innerText || node.textContent || node.value ||
          (node.getAttribute && node.getAttribute('aria-label')) || '').trim().toLowerCase();
        if (!label || label.length > 40) continue;
        for (var t = 0; t < TEXTS.length; t++) {
          if (label === TEXTS[t] || label.indexOf(TEXTS[t]) !== -1) {
            // Só clica se o botão estiver mesmo dentro de um aviso de
            // consentimento. Subimos os ancestrais na mão: closest() com flag
            // case-insensitive não é confiável em todo ambiente, e um falso
            // positivo aqui clicaria num botão real do site.
            if (looksLikeConsentContext(node)) {
              node.click();
              accepted = 'texto: ' + label;
            }
            break;
          }
        }
      }
    }

    // Rolagem travada por modal aberto é outro sintoma clássico
    var bodyStyle = getComputedStyle(document.body);
    var scrollLocked = bodyStyle.overflow === 'hidden' || bodyStyle.position === 'fixed';
    return JSON.stringify({ accepted: accepted, scrollLocked: scrollLocked });
  })()`;

  try {
    var res = await executeCDPCommand(tabId, "Runtime.evaluate", {
      expression: expression,
      returnByValue: true,
      awaitPromise: false
    });
    var parsed = JSON.parse(res.result.value);
    if (parsed.accepted) {
      // Dá tempo do banner sumir e a página liberar o conteúdo
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    return parsed;
  } catch (e) {
    return { accepted: null, scrollLocked: false };
  }
}

// ========== REPLAY DE WORKFLOW ==========
// Reexecuta um fluxo gravado. Cada passo é verificado: se o elemento não
// aparecer, o replay PARA e diz onde parou — em vez de seguir cegamente e
// deixar a página num estado imprevisível.
function cssEscapeValue(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

async function resolveSelectorToNodeId(tabId, selector) {
  if (!selector) return null;
  var doc = await executeCDPCommand(tabId, "DOM.getDocument", { depth: -1 });
  var found = await executeCDPCommand(tabId, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: selector
  });
  if (!found || !found.nodeId) return null;
  var described = await executeCDPCommand(tabId, "DOM.describeNode", { nodeId: found.nodeId });
  return described && described.node ? described.node.backendNodeId : null;
}

// Deriva de seletor é a maior causa de replay quebrado: basta um rename de
// classe para o caminho CSS gravado deixar de existir. Por isso tentamos
// várias âncoras, da mais estável para a mais frágil, e reportamos qual delas
// funcionou — assim o usuário sabe que o fluxo está envelhecendo.
async function resolveStepToNodeId(tabId, step) {
  var attempts = [];

  if (step.testId) {
    attempts.push({ how: 'data-testid', selector: '[data-testid="' + cssEscapeValue(step.testId) + '"]' });
  }
  if (step.id) {
    attempts.push({ how: 'id', selector: idSelector(step.id) });
  }
  if (step.nameAttr) {
    attempts.push({ how: 'name', selector: (step.tag || '') + '[name="' + cssEscapeValue(step.nameAttr) + '"]' });
  }
  if (step.ariaLabel) {
    attempts.push({ how: 'aria-label', selector: '[aria-label="' + cssEscapeValue(step.ariaLabel) + '"]' });
  }
  if (step.placeholder) {
    attempts.push({ how: 'placeholder', selector: '[placeholder="' + cssEscapeValue(step.placeholder) + '"]' });
  }
  // O caminho CSS é o mais frágil: fica por último, não primeiro
  if (step.selector) {
    attempts.push({ how: 'caminho CSS', selector: step.selector });
  }

  for (var i = 0; i < attempts.length; i++) {
    try {
      var nodeId = await resolveSelectorToNodeId(tabId, attempts[i].selector);
      if (nodeId) return { backendNodeId: nodeId, how: attempts[i].how };
    } catch (e) { /* seletor inválido nesta página: tenta o próximo */ }
  }

  // Último recurso: procurar pelo texto visível, via árvore de acessibilidade
  if (step.text) {
    try {
      var read = await getAccessibilityTreeAllFrames(tabId);
      var matches = resolveElements(read.tree, step.text, null, 1);
      if (matches.length && matches[0].score >= 90) {
        return { backendNodeId: matches[0].id, how: 'texto visivel' };
      }
    } catch (e) { /* sem árvore: desiste */ }
  }

  return null;
}

// '#id' quebra quando o id tem caracteres especiais (comum em frameworks):
// nesse caso caímos na forma por atributo, que aceita qualquer valor.
function idSelector(id) {
  return /^[A-Za-z][\w-]*$/.test(id) ? '#' + id : '[id="' + cssEscapeValue(id) + '"]';
}

async function replayWorkflow(tabId, workflow, options) {
  options = options || {};
  var stepTimeout = options.step_timeout_ms || 8000;
  var results = [];
  var degradedSteps = 0;

  for (var i = 0; i < workflow.steps.length; i++) {
    var step = workflow.steps[i];
    var record = { index: i, type: step.type, selector: step.selector };

    // Espera o elemento existir: a página pode ainda estar renderizando
    var resolved = null;
    var start = Date.now();
    while (Date.now() - start < stepTimeout) {
      try {
        resolved = await resolveStepToNodeId(tabId, step);
        if (resolved) break;
      } catch (e) { /* documento trocando: tenta de novo */ }
      await new Promise(function (r) { setTimeout(r, 250); });
    }

    if (!resolved) {
      record.success = false;
      record.error = "Elemento nao encontrado: " + (step.selector || step.text || 'sem ancora');
      results.push(record);
      return {
        success: false,
        completed_steps: i,
        total_steps: workflow.steps.length,
        results: results,
        error: "O replay parou no passo " + (i + 1) + ": o elemento nao existe mais nesta pagina.",
        hint: "A pagina provavelmente mudou desde a gravacao. Grave o fluxo de novo ou faca este passo manualmente."
      };
    }

    var backendNodeId = resolved.backendNodeId;
    record.matched_by = resolved.how;
    // Ter caído numa âncora de reserva é sinal de que o fluxo está envelhecendo
    if (resolved.how !== 'caminho CSS') degradedSteps++;

    try {
      if (step.type === "click") {
        await focusAndClick(tabId, backendNodeId);
      } else if (step.type === "type") {
        await focusAndType(tabId, backendNodeId, String(step.value || ""));
      }
      record.success = true;
    } catch (err) {
      record.success = false;
      record.error = err.message;
      results.push(record);
      return {
        success: false,
        completed_steps: i,
        total_steps: workflow.steps.length,
        results: results,
        error: "Falha ao executar o passo " + (i + 1) + ": " + err.message
      };
    }

    results.push(record);
    await new Promise(function (r) { setTimeout(r, 350); }); // deixa a página reagir
  }

  var summary = {
    success: true,
    completed_steps: workflow.steps.length,
    total_steps: workflow.steps.length,
    results: results,
    message: "Fluxo \"" + workflow.name + "\" reexecutado: " + workflow.steps.length + " passo(s)."
  };
  if (degradedSteps) {
    summary.degraded_steps = degradedSteps;
    summary.hint = degradedSteps + " passo(s) so foram encontrados por ancora alternativa (a pagina mudou desde a gravacao). " +
      "O fluxo ainda funciona, mas vale regravar antes que quebre de vez.";
  }
  return summary;
}

// ========== VERIFICAÇÃO PÓS-AÇÃO ==========
// Sinais baratos do estado da página, usados para responder "a ação surtiu
// efeito?" sem gastar um round-trip de screenshot com o modelo.
async function capturePageSignals(tabId) {
  try {
    var res = await executeCDPCommand(tabId, "Runtime.evaluate", {
      expression: "JSON.stringify({u:location.href,t:document.title,n:document.body?document.body.innerText.length:0})",
      returnByValue: true
    });
    return JSON.parse(res.result.value);
  } catch (e) {
    return null;
  }
}

function describePageChange(before, after) {
  if (!before || !after) return "nao verificado";
  var changes = [];
  if (before.u !== after.u) changes.push("a URL mudou para " + after.u);
  if (before.t !== after.t) changes.push("o titulo mudou para \"" + after.t + "\"");
  var delta = Math.abs((after.n || 0) - (before.n || 0));
  if (delta > 50) changes.push("o conteudo da pagina mudou (" + delta + " caracteres de diferenca)");
  if (!changes.length) {
    return "nenhuma mudanca detectada na pagina — a acao pode nao ter surtido efeito; confirme com wait_for ou releia a pagina antes de seguir";
  }
  return changes.join("; ");
}

// Espera até uma condição observável se cumprir. É o "assert" do agente:
// evita declarar sucesso só porque a ferramenta não deu erro.
async function waitForCondition(tabId, payload) {
  var condition = payload.condition;
  var value = payload.value;
  var timeout = Math.min(parseInt(payload.timeout_ms) || 10000, 60000);
  var start = Date.now();
  var pollDelay = 300;

  function evaluate(expression) {
    return executeCDPCommand(tabId, "Runtime.evaluate", {
      expression: expression,
      returnByValue: true
    }).then(function (r) { return r.result.value; }).catch(function () { return null; });
  }

  var jsonValue = JSON.stringify(String(value === undefined ? "" : value));

  var checks = {
    text_present: function () { return evaluate("(document.body?document.body.innerText:'').includes(" + jsonValue + ")"); },
    text_absent: function () { return evaluate("!(document.body?document.body.innerText:'').includes(" + jsonValue + ")"); },
    url_matches: function () { return evaluate("location.href.includes(" + jsonValue + ")"); },
    url_changed: function () { return evaluate("location.href !== " + jsonValue); },
    title_changed: function () { return evaluate("document.title !== " + jsonValue); },
    element_visible: async function () {
      var box = await executeCDPCommand(tabId, "DOM.getBoxModel", { backendNodeId: parseInt(payload.id) }).catch(function () { return null; });
      return !!(box && box.model && box.model.content &&
        Math.abs(box.model.content[2] - box.model.content[0]) > 0 &&
        Math.abs(box.model.content[5] - box.model.content[1]) > 0);
    },
    element_gone: async function () {
      var box = await executeCDPCommand(tabId, "DOM.getBoxModel", { backendNodeId: parseInt(payload.id) }).catch(function () { return null; });
      return !(box && box.model && box.model.content &&
        Math.abs(box.model.content[2] - box.model.content[0]) > 0);
    }
  };

  var check = checks[condition];
  if (!check) {
    return {
      success: false,
      error: "Condicao desconhecida: " + condition,
      hint: "Use uma destas: " + Object.keys(checks).join(", ")
    };
  }

  while (Date.now() - start < timeout) {
    var ok = await check();
    if (ok === true) {
      return {
        success: true,
        condition: condition,
        waited_ms: Date.now() - start,
        message: "Condicao satisfeita: " + condition + (value !== undefined ? " (" + value + ")" : "")
      };
    }
    await new Promise(function (r) { setTimeout(r, pollDelay); });
  }

  return {
    success: false,
    condition: condition,
    waited_ms: Date.now() - start,
    error: "A condicao \"" + condition + "\" nao se cumpriu em " + timeout + "ms.",
    hint: "A acao anterior pode nao ter funcionado. Releia a pagina (get_accessibility_tree ou find_element) antes de repetir, e nao declare a tarefa concluida."
  };
}

// Corta a árvore para caber no contexto do modelo, preservando o que importa:
// elementos interativos primeiro, texto só com o orçamento que sobrar.
function capAXTree(tree, maxNodes) {
  maxNodes = maxNodes || 300;
  if (tree.length <= maxNodes) return { tree: tree, truncated: false };

  var interactive = tree.filter(function (n) { return INTERACTIVE_ROLES.has(n.role); });
  var others = tree.filter(function (n) { return !INTERACTIVE_ROLES.has(n.role); });

  var kept = interactive.slice(0, maxNodes);
  if (kept.length < maxNodes) {
    kept = kept.concat(others.slice(0, maxNodes - kept.length));
  }

  return {
    tree: kept,
    truncated: true,
    omitted: tree.length - kept.length,
    totalNodes: tree.length
  };
}

// === FASE 1: waitForElement — polling até o elemento existir e ter tamanho ===
async function waitForElement(tabId, backendNodeId, timeout) {
  timeout = timeout || 5000;
  var start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      var box = await executeCDPCommand(tabId, "DOM.getBoxModel", { backendNodeId: backendNodeId });
      if (box && box.model && box.model.content) {
        var q = box.model.content;
        var w = Math.abs(q[2] - q[0]);
        var h = Math.abs(q[5] - q[1]);
        if (w > 0 && h > 0) return box;
      }
    } catch (e) {
      // Elemento ainda não existe no DOM, continua tentando
    }
    await new Promise(function(r) { setTimeout(r, 200); });
  }
  throw new Error("Elemento nao encontrado ou invisivel apos " + timeout + "ms");
}

// === FASE 1: getElementCenter — calcula centro do elemento ===
function getElementCenter(boxResult) {
  var q = boxResult.model.content;
  var x = (q[0] + q[2] + q[4] + q[6]) / 4;
  var y = (q[1] + q[3] + q[5] + q[7]) / 4;
  return { x: x, y: y };
}

// === FASE 1: focusAndClick — garante foco + scroll + clique fisico ===
async function focusAndClick(tabId, backendNodeId) {
  // 1. Scroll into view
  try {
    await executeCDPCommand(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: backendNodeId });
  } catch (e) { /* ignore se nao suportado */ }

  // 2. Espera elemento estar visivel
  var box = await waitForElement(tabId, backendNodeId);
  var center = getElementCenter(box);

  // 3. Focus via DOM
  try {
    await executeCDPCommand(tabId, "DOM.focus", { backendNodeId: backendNodeId });
  } catch (e) { /* ignore */ }

  // 4. Pequeno delay para SPA processar
  await new Promise(function(r) { setTimeout(r, 80); });

  // 5. Clique fisico com mousedown + mouseup
  await executeCDPCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: center.x, y: center.y, button: "left", clickCount: 1
  });
  await executeCDPCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: center.x, y: center.y, button: "left", clickCount: 1
  });

  return center;
}

// === FASE 1: focusAndType — foco verificado + digitacao ===
async function focusAndType(tabId, backendNodeId, text) {
  // 1. Clica para focar
  await focusAndClick(tabId, backendNodeId);

  // 2. Delay pos-clique
  await new Promise(function(r) { setTimeout(r, 150); });

  // 3. Verifica se realmente focou (via evaluate)
  try {
    var evalResult = await executeCDPCommand(tabId, "Runtime.evaluate", {
      expression: "document.activeElement ? document.activeElement.tagName : 'NONE'"
    });
    var tag = evalResult.result.value;
    // Se nao focou em input/textarea, tenta focus de novo
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "DIV") {
      await executeCDPCommand(tabId, "DOM.focus", { backendNodeId: backendNodeId });
      await new Promise(function(r) { setTimeout(r, 100); });
    }
  } catch (e) { /* ignore */ }

  // 4. Digita caractere por caractere
  for (var i = 0; i < text.length; i++) {
    await executeCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "char", text: text[i]
    });
  }
}

// Ações que apenas LEEM conteúdo da página. O Injection Guard é caro
// (TreeWalker + getComputedStyle na página inteira), então só faz sentido
// rodá-lo aqui — não a cada clique ou tecla digitada.
const CONTENT_READING_ACTIONS = new Set(["get_accessibility_tree", "find_element"]);

async function handleDebuggerAction(action, payload) {
  // Respeita o tabId explícito quando o agente está operando várias abas;
  // sem isto, uma troca de aba entre a leitura e o clique faz a ação cair
  // na aba errada.
  var tabId = (payload && payload.tabId) ? parseInt(payload.tabId) : await getActiveTabId();
  if (!tabId) throw new Error("No active tab found");

  const tab = await chrome.tabs.get(tabId);
  const origin = new URL(tab.url).origin;

  // Modo Autônomo: concede permissões automaticamente (sem pedir ao usuário)
  const mode = await getAurexModeFromStorage();
  if (mode === "autonomous") {
    await PermissionManager.grantPermission(origin);
  }

  const decision = await PermissionManager.requirePermission(tabId, origin);
  if (!decision.granted) {
    if (decision.reason === 'pending') {
      // O usuário ainda não decidiu. A tarefa NÃO falhou — o agente deve
      // aguardar e tentar de novo, não declarar que não conseguiu.
      throw new Error(`AGUARDANDO PERMISSÃO: o banner de permissão para ${origin} está na tela e o usuário ainda não decidiu. NÃO desista da tarefa e NÃO diga que falhou: use o comando wait (3000 a 5000 ms) e repita esta mesma ação até o usuário aprovar ou bloquear.`);
    }
    if (decision.reason === 'no-panel') {
      throw new Error(`PERMISSÃO PENDENTE: o painel do Aurex está fechado, então não foi possível mostrar o pedido de permissão para ${origin}. Peça ao usuário para abrir o painel lateral do Aurex e então tente novamente.`);
    }
    throw new Error(`PERMISSÃO RECUSADA: o usuário bloqueou o acesso a ${origin}. Não tente acessar este site de novo; siga com outra abordagem ou pergunte ao usuário como proceder.`);
  }

  await ensureDebuggerAttached(tabId);

  // Injection Guard: só nas ações que trazem conteúdo da página para o modelo
  if (CONTENT_READING_ACTIONS.has(action)) {
    const hasInjection = await InjectionGuard.scanForHiddenContent(tabId);
    if (hasInjection) {
      throw new Error("ALERTA DE SEGURANÇA: Prompt Injection oculto detectado na página. Ação abortada.");
    }
  }

  if (action === "get_accessibility_tree") {
    // Resolve banner de consentimento ANTES de ler: senão o agente gasta
    // contexto com texto jurídico e, pior, tenta clicar em elementos que
    // estão atrás de um modal bloqueante.
    var interruption = payload && payload.skip_interruptions
      ? { accepted: null }
      : await dismissInterruptions(tabId);

    var axRead = await getAccessibilityTreeAllFrames(tabId);

    if (!InjectionGuard.validateAXTree(axRead.tree)) {
      throw new Error("ALERTA DE SEGURANÇA: Padrão malicioso detectado na Accessibility Tree. Ação abortada.");
    }

    var capped = capAXTree(axRead.tree, payload && payload.max_nodes);
    var response = {
      success: true,
      tree: capped.tree,
      frames_read: axRead.framesRead,
      url: tab.url
    };
    if (capped.truncated) {
      response.truncated = true;
      response.note = "Arvore truncada: " + capped.omitted + " de " + capped.totalNodes +
        " nos omitidos (elementos interativos foram preservados). Use find_element para localizar algo especifico.";
    }
    if (interruption && interruption.accepted) {
      response.interruption_dismissed = interruption.accepted;
    }
    return response;
  }

  if (action === "find_element") {
    // Mesmo motivo do get_accessibility_tree: um modal aberto esconde o alvo
    if (!(payload && payload.skip_interruptions)) await dismissInterruptions(tabId);
    var findRead = await getAccessibilityTreeAllFrames(tabId);

    if (!InjectionGuard.validateAXTree(findRead.tree)) {
      throw new Error("ALERTA DE SEGURANÇA: Padrão malicioso detectado na Accessibility Tree. Ação abortada.");
    }

    var matches = resolveElements(
      findRead.tree,
      payload.query,
      payload.role,
      payload.limit || 3
    );

    if (!matches.length) {
      return {
        success: false,
        error: "Nenhum elemento correspondente a \"" + (payload.query || "") + "\" foi encontrado nesta pagina.",
        hint: "A pagina pode ainda estar carregando (use wait_for), o elemento pode estar atras de um menu, ou a descricao pode nao bater com o rotulo visivel. Use get_accessibility_tree para inspecionar."
      };
    }

    return {
      success: true,
      query: payload.query,
      url: tab.url,
      matches: matches,
      best: matches[0],
      confidence: matches.length > 1 && matches[0].score - matches[1].score < 15 ? "ambigua" : "alta"
    };
  }

  if (action === "wait_for") {
    return await waitForCondition(tabId, payload);
  }

  if (action === "replay_workflow") {
    var workflow = await WorkflowRecorder.getWorkflow(payload.name);
    if (!workflow) {
      return {
        success: false,
        error: "Fluxo nao encontrado: " + payload.name,
        hint: "Use list_workflows para ver os fluxos gravados."
      };
    }
    if (!workflow.steps || !workflow.steps.length) {
      return { success: false, error: "O fluxo \"" + payload.name + "\" nao tem passos gravados." };
    }
    return await replayWorkflow(tabId, workflow, payload);
  }

  if (action === "simulate_click") {
    var nodeId = parseInt(payload.id);
    var beforeClick = await capturePageSignals(tabId);
    var center = await focusAndClick(tabId, nodeId);
    // Espera a pagina reagir (SPA pode re-renderizar)
    await new Promise(function(r) { setTimeout(r, 300); });
    var afterClick = await capturePageSignals(tabId);
    return {
      success: true,
      message: "Clicked element at " + Math.round(center.x) + ", " + Math.round(center.y),
      effect: describePageChange(beforeClick, afterClick)
    };
  }

  if (action === "simulate_type") {
    var typeNodeId = parseInt(payload.id);
    var text = payload.value;
    var beforeType = await capturePageSignals(tabId);
    await focusAndType(tabId, typeNodeId, text);

    // Se o LLM pedir submit: true, pressiona Enter automaticamente
    if (payload.submit) {
      await new Promise(function(r) { setTimeout(r, 100); });
      await executeCDPCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
      });
      await executeCDPCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
      });
    }
    // Confirma que o texto realmente entrou no campo — digitar sem foco é
    // uma falha silenciosa comum em SPAs.
    var typedOk = null;
    try {
      var check = await executeCDPCommand(tabId, "Runtime.evaluate", {
        expression: "(function(){var a=document.activeElement;if(!a)return null;return (a.value!==undefined?a.value:a.textContent)||'';})()",
        returnByValue: true
      });
      var current = check.result.value;
      if (typeof current === "string") typedOk = current.indexOf(text) !== -1;
    } catch (e) { /* verificação é best-effort */ }

    var afterType = payload.submit ? await capturePageSignals(tabId) : null;

    var typeResult = {
      success: true,
      message: "Typed text into element" + (payload.submit ? " and submitted" : ""),
      text_confirmed: typedOk
    };
    if (typedOk === false) {
      typeResult.warning = "O texto NAO foi encontrado no campo apos digitar. O foco pode ter sido perdido: releia a pagina e tente outro elemento antes de prosseguir.";
    }
    if (afterType) typeResult.effect = describePageChange(beforeType, afterType);
    return typeResult;
  }

  if (action === "press_key") {
    var keyName = payload.key || "Enter";
    var keyCodeMap = {
      "Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8,
      "ArrowDown": 40, "ArrowUp": 38, "ArrowLeft": 37, "ArrowRight": 39,
      "Space": 32
    };
    var vkCode = keyCodeMap[keyName] || 0;
    await executeCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown", key: keyName, code: keyName, windowsVirtualKeyCode: vkCode, nativeVirtualKeyCode: vkCode
    });
    await executeCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key: keyName, code: keyName, windowsVirtualKeyCode: vkCode, nativeVirtualKeyCode: vkCode
    });
    return { success: true, message: "Pressed key: " + keyName };
  }

  throw new Error("Unknown debugger action: " + action);
}

// Configura o painel lateral para abrir ao clicar no ícone
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  }
});

// Fallback robusto: se clicar no ícone e o painel não abrir sozinho, forçamos a abertura
chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Permite que o popup local use os poderes de Debugger também!
  if (request.action === "debugger_action") {
    handleDebuggerAction(request.payload.command, request.payload)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open
  }

  // Comandos do Workflow Recorder
  if (request.type === "start_recording") {
    getActiveTabId().then(id => WorkflowRecorder.startRecording(id));
    sendResponse({ success: true });
  } else if (request.type === "stop_recording") {
    WorkflowRecorder.stopRecording().then(w => sendResponse({ success: true, workflow: w }));
    return true;
  } else if (request.type === "recorder_event") {
    WorkflowRecorder.recordEvent(request.event);
  }

  // Revogar permissão de uma origem aprovada (a partir das Configurações)
  if (request.type === "revoke_permission") {
    // Revoga nas duas listas: sessão e permanente
    Promise.all([
      PermissionManager.revokePermission(request.origin),
      PermissionManager.untrustOrigin(request.origin)
    ]).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  // Comandos de Permissão
  if (request.type === "grant_permission" || request.type === "deny_permission") {
    // SECURITY FIX: Impede que widgets maliciosos forjem a concessão/negação
    const pending = PermissionManager.pendingResolvers ? PermissionManager.pendingResolvers[request.origin] : null;
    
    if (!pending) {
      // Ou é uma tentativa forjada, ou o service worker reiniciou e o pedido
      // ficou órfão (stale). O popup usa "stale" para dispensar o banner.
      console.warn(`[Aurex Security] Sem permissão pendente para: ${request.origin} (forjada ou expirada)`);
      sendResponse({ success: false, stale: true, error: "Nenhuma permissão pendente para esta origem." });
      return true;
    }

    if (pending.token !== request.token) {
      console.warn(`[Aurex Security] TOKEN INVÁLIDO para origem: ${request.origin}`);
      sendResponse({ success: false, error: "Token de segurança inválido." });
      return true;
    }

    if (request.type === "grant_permission") {
      // "sempre permitir" grava também na lista permanente
      const persist = request.scope === 'always'
        ? PermissionManager.trustOriginForever(request.origin)
        : Promise.resolve();
      persist
        .then(() => PermissionManager.grantPermission(request.origin))
        .then(() => {
          PermissionManager.resolvePending(request.origin, true);
          sendResponse({ success: true, scope: request.scope || 'session' });
        });
    } else {
      // deny_permission
      PermissionManager.resolvePending(request.origin, false);
      sendResponse({ success: true });
    }
    return true;
  }

  return true;
});
