// Executor das ferramentas do agente: resolve a aba alvo, passa pelo portão
// de permissão do background e despacha cada ferramenta para o caminho
// certo (debugger, content script, sandbox, MCP).

// Formatos que o Aurex pode salvar. Inclui extensões de código para que ele
// consiga entregar sites, scripts e componentes como arquivos reais.
var AUREX_ALLOWED_FILE_EXTS = [
  'md', 'txt', 'html', 'csv', 'json', 'docx',
  'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'sql', 'xml', 'yml', 'yaml', 'svg', 'sh'
];
var AUREX_FILE_EXT_PATTERN = new RegExp('\\.(' + AUREX_ALLOWED_FILE_EXTS.join('|') + ')$', 'i');

function sanitizeMarkdownFilename(filename) {
  var defaultExt = (localStorage.getItem('aurex_file_ext') || 'md').toLowerCase();
  if (!AUREX_ALLOWED_FILE_EXTS.includes(defaultExt)) defaultExt = 'md';
  var value = String(filename || ("aurex_output." + defaultExt)).replace(/\\/g, "/").split("/").pop().trim();
  value = value.replace(/[<>:"|?*\x00-\x1F]/g, "_");
  value = value.replace(/^\.+/, "").trim();
  if (!value) value = "aurex_output." + defaultExt;

  // Se o modelo pediu explicitamente uma extensão suportada (ex: .docx quando
  // o usuário quer um documento Word), respeitamos. Senão, usamos o formato
  // padrão escolhido nas Configurações.
  var explicit = value.match(AUREX_FILE_EXT_PATTERN);
  var ext = explicit ? explicit[1].toLowerCase() : defaultExt;
  value = value.replace(AUREX_FILE_EXT_PATTERN, "");
  return value + "." + ext;
}

function fileMimeForExt(ext) {
  var map = {
    md: "text/markdown;charset=utf-8",
    txt: "text/plain;charset=utf-8",
    html: "text/html;charset=utf-8",
    csv: "text/csv;charset=utf-8",
    json: "application/json;charset=utf-8",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    css: "text/css;charset=utf-8",
    js: "text/javascript;charset=utf-8",
    mjs: "text/javascript;charset=utf-8",
    ts: "text/plain;charset=utf-8",
    tsx: "text/plain;charset=utf-8",
    jsx: "text/plain;charset=utf-8",
    py: "text/x-python;charset=utf-8",
    sql: "text/plain;charset=utf-8",
    xml: "text/xml;charset=utf-8",
    yml: "text/yaml;charset=utf-8",
    yaml: "text/yaml;charset=utf-8",
    svg: "image/svg+xml;charset=utf-8",
    sh: "text/x-shellscript;charset=utf-8"
  };
  return map[ext] || "text/plain;charset=utf-8";
}

// Retorna a aba web ativa (ignora chrome://, extensões e páginas restritas)
function getActiveWebTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      var restricted = !tab || !tab.url ||
        /^(chrome|edge|about|chrome-extension|devtools|view-source):/.test(tab.url) ||
        /^https:\/\/chrome\.google\.com\/webstore/.test(tab.url);
      resolve(restricted ? null : tab);
    });
  });
}

// Envia um comando ao content script. Se o content script ainda não estiver na
// aba (aba aberta antes da extensão, ou injeção pendente), injeta content.js
// programaticamente e tenta de novo — em vez de falhar com "Receiving end".
// Pede ao background a autorização da origem desta aba, usando exatamente o
// mesmo gate (banner, sites aprovados, revogação) das ferramentas de CDP.
function authorizeTabForPage(tabId) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage({ action: "authorize_tab_access", type: "authorize_tab_access", tabId: tabId }, function (response) {
      if (chrome.runtime.lastError) {
        // Sem resposta do background não dá para afirmar que há permissão.
        // Fail closed: recusar a leitura é o comportamento seguro.
        resolve({ success: false, error: "Não consegui verificar a permissão desta aba: " + (chrome.runtime.lastError.message || "sem resposta do Aurex.") });
        return;
      }
      resolve(response || { success: false, error: "Sem resposta do gate de permissão." });
    });
  });
}

// Todo acesso pelo content script passa por aqui — read_dom, scroll,
// get_element_text, extract_page e o fallback da árvore de acessibilidade.
// A permissão é verificada NESTE ponto porque era exatamente por esta porta
// que as ferramentas contornavam o gate que existia só no caminho do CDP.
function sendToContentScript(tabId, payload) {
  return authorizeTabForPage(tabId).then(function (auth) {
    if (!auth.success) return { success: false, error: auth.error };
    return sendToContentScriptUnchecked(tabId, payload);
  });
}

function sendToContentScriptUnchecked(tabId, payload) {
  return new Promise(function (resolve) {
    function attempt(isRetry) {
      chrome.tabs.sendMessage(tabId, { action: "dom_action", payload: payload }, function (response) {
        if (chrome.runtime.lastError) {
          var errMsg = chrome.runtime.lastError.message || "";
          if (!isRetry && errMsg.indexOf("Receiving end does not exist") !== -1) {
            // Injeta o content script e repete uma vez
            chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["content.js"] }, function () {
              if (chrome.runtime.lastError) {
                resolve({ success: false, error: "Não consegui preparar esta aba para leitura (" + (chrome.runtime.lastError.message || "injeção falhou") + "). A página pode ser restrita pelo navegador." });
                return;
              }
              setTimeout(function () { attempt(true); }, 150);
            });
            return;
          }
          resolve({ success: false, error: errMsg || "Falha ao falar com a aba." });
          return;
        }
        // Truncar resultados muito grandes para não estourar o contexto do LLM
        var resultStr = JSON.stringify(response);
        if (resultStr.length > 20000 && response) {
          response.data = {
            warning: "O DOM era muito grande e foi truncado.",
            content: resultStr.substring(0, 20000) + "... [TRUNCADO]"
          };
        }
        resolve(response || { success: false, error: "Resposta vazia da aba." });
      });
    }
    attempt(false);
  });
}

function executeToolInBrowser(name, args) {
  return new Promise((resolve) => {
    // Trava em tempo de execução: mesmo que uma ferramenta de escrita chegue
    // aqui em modo Plano (histórico antigo, modelo insistente, injeção na
    // página), ela não executa. O filtro do payload é a primeira barreira;
    // esta é a segunda.
    if (isWriteBlocked() && toolAccessFor(name, args) === "write") {
      resolve({
        success: false,
        error: "BLOQUEADO PELO MODO PLANO: acoes que alteram algo estao desativadas ate o usuario aprovar o plano.",
        hint: "Apresente o plano ao usuario e aguarde a aprovacao. Voce ainda pode LER a pagina, pesquisar e inspecionar para montar o plano."
      });
      return;
    }

    if (name === "dom_action") {

      if (args.command === "wait") {
        var ms = parseInt(args.value) || 5000;
        setTimeout(function() { resolve({ success: true, message: "Aguardou por " + ms + "ms" }) }, ms);
        return;
      }

      // NAVEGAÇÃO: via chrome.tabs.update (confiável) em vez do content script.
      // Assim funciona mesmo em abas onde o content script não foi injetado.
      if (args.command === "navigate" || args.command === "search_web") {
        var targetUrl = args.command === "search_web"
          ? "https://www.google.com/search?q=" + encodeURIComponent(args.value || "")
          : (args.value || "");
        if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;
        getActiveWebTab().then(function (tab) {
          var doNavigate = function (tabId) {
            chrome.tabs.update(tabId, { url: targetUrl }, function () {
              if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve({ success: true, message: "Navegando para " + targetUrl + ". Use wait antes de ler a página." });
              }
            });
          };
          if (tab) {
            doNavigate(tab.id);
          } else {
            // Sem aba web utilizável: abre uma nova aba já na URL desejada
            chrome.tabs.create({ url: targetUrl, active: true }, function (newTab) {
              if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
              else resolve({ success: true, message: "Abri uma nova aba em " + targetUrl + ". Use wait antes de ler a página." });
            });
          }
        });
        return;
      }

      // Comandos que usam a API Debugger (leitura semântica e interação real)
      if (["get_accessibility_tree", "simulate_click", "simulate_type", "press_key"].includes(args.command)) {
        chrome.runtime.sendMessage({ action: "debugger_action", payload: args }, (response) => {
          if (chrome.runtime.lastError) {
            response = { success: false, error: chrome.runtime.lastError.message };
          }

          // Fallback de LEITURA: se a árvore de acessibilidade falhar ou vier
          // vazia (comum em SPAs pesados), tenta ler o DOM pelo content script.
          // EXCEÇÃO: se o usuário negou a permissão, respeitamos e NÃO lemos.
          var treeEmpty = response && response.success && (!response.tree || response.tree.length === 0);
          // Qualquer estado de permissão (recusada, aguardando ou painel
          // fechado) bloqueia o fallback — nunca lemos a página por outro
          // caminho sem a autorização do usuário.
          var permissionDenied = response && !response.success &&
            /PERMISS[ÃA]O (RECUSADA|PENDENTE)|AGUARDANDO PERMISS[ÃA]O/i.test(response.error || "");
          if (!permissionDenied && args.command === "get_accessibility_tree" && (!response || !response.success || treeEmpty)) {
            getActiveWebTab().then(function (tab) {
              if (!tab) { resolve(response || { success: false, error: "Aba atual não pode ser lida." }); return; }
              sendToContentScript(tab.id, { command: "read_dom" }).then(function (domRes) {
                if (domRes && domRes.success) {
                  resolve({ success: true, fallback: "read_dom", tree: [], data: domRes.data,
                    message: "A árvore de acessibilidade veio vazia; li o conteúdo do DOM da página." });
                } else {
                  resolve(response || domRes || { success: false, error: "Não consegui ler a página." });
                }
              });
            });
            return;
          }
          resolve(response);
        });
        return;
      }

      // Demais comandos (read_dom, scroll, get_element_text) via content script
      getActiveWebTab().then(function (tab) {
        if (!tab) {
          resolve({ success: false, error: "A aba atual é uma página restrita do navegador. Peça ao usuário para abrir uma página web comum (ex: o site do curso) e tente de novo." });
          return;
        }
        sendToContentScript(tab.id, args).then(resolve);
      });
    } else if (name === "capture_screenshot") {
      // A captura leva para o modelo TUDO que está na tela — inclusive o que
      // o usuário nunca autorizou a ler. Passa pelo mesmo gate de origem.
      getActiveWebTab().then(function (tab) {
        if (!tab) {
          resolve({ success: false, error: "A aba atual e uma pagina restrita do navegador. Peca ao usuario para abrir uma pagina web comum." });
          return;
        }
        authorizeTabForPage(tab.id).then(function (auth) {
          if (!auth.success) { resolve({ success: false, error: auth.error }); return; }
          chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              // Pass the dataUrl back so we can inject it into the LLM context!
              resolve({ success: true, message: "Screenshot capturada com sucesso (" + Math.round(dataUrl.length / 1024) + " KB)", dataUrl: dataUrl });
            }
          });
        });
      });
    } else if (name === "save_markdown_file") {
      var fileName = sanitizeMarkdownFilename(args.filename);
      var content = typeof args.content === "string" ? args.content : "";
      if (!content) {
        resolve({ success: false, error: "Conteudo Markdown vazio." });
        return;
      }
      var fileExt = fileName.split('.').pop().toLowerCase();

      // Arquivos de código: se o modelo envolveu o conteúdo em cercas ```,
      // removemos para o arquivo salvo ser código puro e executável.
      var isDoc = ['md', 'txt', 'docx', 'csv'].includes(fileExt);
      if (!isDoc) {
        var fenced = content.match(/^\s*```[a-zA-Z0-9+#-]*\s*\n([\s\S]*?)\n?\s*```\s*$/);
        if (fenced) content = fenced[1];
      }

      // .docx: converte o Markdown num documento Word real (títulos, listas,
      // tabelas e negrito preservados). Demais formatos: texto puro.
      var blob = fileExt === 'docx'
        ? buildDocxBlob(content)
        : new Blob([content], { type: fileMimeForExt(fileExt) });
      var url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: url,
        filename: fileName,
        saveAs: false
      }, function(downloadId) {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve({ success: true, message: "Arquivo salvo na pasta Downloads: " + fileName, downloadId: downloadId });
        }
        setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
      });
    } else if (name === "tab_manager") {
      if (args.command === "create_tab") {
        chrome.tabs.create({ url: args.url, active: true }, function(tab) {
          resolve({ success: true, message: "Aba criada e focada", tabId: tab.id });
        });
      } else if (args.command === "list_tabs") {
        chrome.tabs.query({}, function(tabs) {
          var tabList = tabs.map(function(t) { return { id: t.id, url: t.url, title: t.title, active: t.active }; });
          resolve({ success: true, tabs: tabList });
        });
      } else if (args.command === "switch_tab") {
        chrome.tabs.update(parseInt(args.tabId), { active: true }, function(tab) {
          resolve({ success: true, message: "Foco alterado para aba " + args.tabId });
        });
      } else if (args.command === "close_tab") {
        chrome.tabs.remove(parseInt(args.tabId), function() {
          resolve({ success: true, message: "Aba fechada" });
        });
      } else {
        resolve({ success: false, error: "Comando tab_manager desconhecido" });
      }
    } else if (name === "find_element" || name === "wait_for") {
      // Ferramentas de nível superior que rodam via CDP no background
      var debuggerPayload = Object.assign({ command: name }, args);
      chrome.runtime.sendMessage({ action: "debugger_action", payload: debuggerPayload }, function (response) {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    } else if (name === "web_search") {
      executeWebSearch(args).then(resolve);
    } else if (name === "web_fetch") {
      executeWebFetch(args).then(resolve);
    } else if (name === "extract_page") {
      // Lê o conteúdo legível da aba ativa (usa o content script, respeitando
      // a mesma via de leitura das Browser Tools)
      getActiveWebTab().then(function (tab) {
        if (!tab) {
          resolve({ success: false, error: "A aba atual e uma pagina restrita do navegador. Peca ao usuario para abrir uma pagina web comum." });
          return;
        }
        sendToContentScript(tab.id, { command: "read_dom" }).then(function (res) {
          if (res && res.success) {
            resolve({ success: true, url: tab.url, title: tab.title, data: res.data });
          } else {
            resolve(res || { success: false, error: "Nao consegui extrair o conteudo da aba." });
          }
        });
      });
    } else if (name === "run_command") {
      AurexSandbox.exec({ command: args.command, network: args.network === true, timeout_ms: args.timeout_ms })
        .then(function (res) { resolve(shapeSandboxResult(res)); });
    } else if (name === "run_code") {
      AurexSandbox.exec({
        language: args.language,
        code: args.code,
        filename: args.filename,
        args: args.args,
        network: args.network === true,
        timeout_ms: args.timeout_ms
      }).then(function (res) { resolve(shapeSandboxResult(res)); });
    } else if (name === "sandbox_files") {
      executeSandboxFiles(args).then(resolve);
    } else if (name === "dev_server") {
      executeDevServer(args).then(resolve);
    } else if (name === "google_places") {
      executeGooglePlaces(args).then(resolve);
    } else if (name === "api_request") {
      executeApiRequest(args).then(resolve);
    } else if (name === "task_memory") {
      if (args.command === "set_task") {
        localStorage.setItem("aurex_active_task", args.task_content);
        saveTaskState({ note: args.task_content });
        resolve({ success: true, message: "Memoria salva" });
      } else if (args.command === "get_task") {
        // Devolve a nota E o estado observável (onde a tarefa parou), para
        // retomar sem ter que re-navegar tudo do zero.
        var t = localStorage.getItem("aurex_active_task");
        var state = loadTaskState();
        resolve({
          success: true,
          task_content: t || "Nenhuma memoria salva",
          last_state: state || undefined
        });
      } else if (args.command === "clear_task") {
        localStorage.removeItem("aurex_active_task");
        clearTaskState();
        resolve({ success: true, message: "Memoria limpa" });
      } else {
        resolve({ success: false, error: "Comando desconhecido em task_memory: " + args.command });
      }
    } else if (name === "workflow") {
      executeWorkflowTool(args).then(resolve);
    } else if (typeof AurexMCP !== 'undefined' && AurexMCP.findTool(name)) {
      AurexMCP.callTool(name, args).then(resolve);
    } else {
      resolve({ success: false, error: "Unknown tool: " + name });
    }
  });
}
