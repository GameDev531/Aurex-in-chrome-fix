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

function filterAXTree(nodes) {
  return nodes
    .filter(n => n.name?.value || n.role?.value === "button" || n.role?.value === "link" || n.role?.value === "textbox")
    .map(n => ({
      id: n.backendDOMNodeId, // ID crucial para interações futuras
      role: n.role?.value,
      name: n.name?.value || ""
    }));
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

async function handleDebuggerAction(action, payload) {
  var tabId = await getActiveTabId();
  if (!tabId) throw new Error("No active tab found");

  const tab = await chrome.tabs.get(tabId);
  const origin = new URL(tab.url).origin;

  // Modo Autônomo: concede permissões automaticamente (sem pedir ao usuário)
  const mode = await getAurexModeFromStorage();
  if (mode === "autonomous") {
    await PermissionManager.grantPermission(origin);
  }

  const isAllowed = await PermissionManager.requirePermission(tabId, origin);
  if (!isAllowed) {
    throw new Error(`PERMISSÃO RECUSADA: ${origin}.`);
  }

  await ensureDebuggerAttached(tabId);

  // Injection Guard: bloqueia antes mesmo de extrair
  const hasInjection = await InjectionGuard.scanForHiddenContent(tabId);
  if (hasInjection) {
     throw new Error("ALERTA DE SEGURANÇA: Prompt Injection oculto detectado na página. Ação abortada.");
  }

  if (action === "get_accessibility_tree") {
    await executeCDPCommand(tabId, "DOM.enable");
    var axResult = await executeCDPCommand(tabId, "Accessibility.getFullAXTree");
    var filteredTree = filterAXTree(axResult.nodes);
    
    if (!InjectionGuard.validateAXTree(filteredTree)) {
      throw new Error("ALERTA DE SEGURANÇA: Padrão malicioso detectado na Accessibility Tree. Ação abortada.");
    }

    return { success: true, tree: filteredTree };
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
      console.warn(`[Aurex Security] Bloqueada tentativa de forjar permissão para: ${request.origin}`);
      sendResponse({ success: false, error: "Nenhuma permissão pendente para esta origem." });
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
