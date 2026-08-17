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

function filterAXTree(nodes, frameId) {
  return nodes.filter(isUsefulAXNode).map(function (node) {
    return mapAXNode(node, frameId);
  });
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

  if (frameIds.length === 0) {
    var main = await executeCDPCommand(tabId, "Accessibility.getFullAXTree");
    combined = filterAXTree(main.nodes || []);
    framesRead = 1;
  } else {
    for (var i = 0; i < frameIds.length; i++) {
      try {
        var res = await executeCDPCommand(tabId, "Accessibility.getFullAXTree", { frameId: frameIds[i] });
        var nodes = filterAXTree(res.nodes || [], frameIds[i]);
        if (nodes.length) {
          combined = combined.concat(nodes);
          framesRead++;
        }
      } catch (e) {
        // Frame cross-origin fora de alcance ou já destruído: ignora e segue
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

  return { tree: unique, framesRead: framesRead, framesTotal: frameIds.length || 1 };
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
    return response;
  }

  if (action === "simulate_click") {
    var nodeId = parseInt(payload.id);
    var center = await focusAndClick(tabId, nodeId);
    // Espera a pagina reagir (SPA pode re-renderizar)
    await new Promise(function(r) { setTimeout(r, 300); });
    return { success: true, message: "Clicked element at " + Math.round(center.x) + ", " + Math.round(center.y) };
  }

  if (action === "simulate_type") {
    var typeNodeId = parseInt(payload.id);
    var text = payload.value;
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
    return { success: true, message: "Typed text into element" + (payload.submit ? " and submitted" : "") };
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
    PermissionManager.revokePermission(request.origin).then(() => {
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
      PermissionManager.grantPermission(request.origin).then(() => {
        PermissionManager.resolvePending(request.origin, true);
        sendResponse({ success: true });
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
