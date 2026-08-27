// Feed visual de atividade: uma linha por chamada de ferramenta, agrupadas
// por turno, com o resumo do que foi feito e a seta para abrir os detalhes.
// É a janela do usuário para o que o agente está fazendo.

// ========== LOG VISUAL DE ATIVIDADE ==========
//
// Antes, cada chamada de ferramenta virava um cartão próprio com um bloco de
// "detalhes técnicos" aberto por padrão. Numa tarefa que cria 26 arquivos isso
// vira 26 cartões e o usuário perde de vista o que está acontecendo.
//
// Aqui as chamadas de um mesmo turno entram num feed único: uma linha por
// ação, ícone por TIPO (comando, arquivo escrito, arquivo lido, navegação),
// alvo em fonte monoespaçada e duração. O resumo no topo conta por tipo, que é
// o que responde "o que ele fez até agora?" sem ter que ler linha por linha.
// O detalhe técnico continua ali, mas atrás de um clique.

// Tipo -> ícone. O tipo também alimenta a contagem do resumo, então mudar isto
// muda as duas coisas de uma vez.
var ACTIVITY_KINDS = {
  command:    { icon: 'fa-terminal',         verb: 'executou',  one: 'comando',  many: 'comandos' },
  write:      { icon: 'fa-file-circle-plus', verb: 'criou',     one: 'arquivo',  many: 'arquivos' },
  read:       { icon: 'fa-file-lines',       verb: 'leu',       one: 'arquivo',  many: 'arquivos' },
  browse:     { icon: 'fa-compass',          verb: 'navegou',   one: 'página',   many: 'páginas' },
  interact:   { icon: 'fa-hand-pointer',     verb: 'interagiu', one: 'vez',      many: 'vezes' },
  look:       { icon: 'fa-eye',              verb: 'observou',  one: 'vez',      many: 'vezes' },
  search:     { icon: 'fa-magnifying-glass', verb: 'pesquisou', one: 'vez',      many: 'vezes' },
  serve:      { icon: 'fa-server',           verb: 'serviu',    one: 'processo', many: 'processos' },
  deliver:    { icon: 'fa-box-open',         verb: 'entregou',  one: 'arquivo',  many: 'arquivos' },
  connect:    { icon: 'fa-plug',             verb: 'consultou', one: 'serviço',  many: 'serviços' },
  other:      { icon: 'fa-gear',             verb: 'fez',       one: 'ação',     many: 'ações' }
};

// Encurta um caminho preservando o que identifica: o fim.
function shortTarget(value, max) {
  var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  var limit = max || 52;
  if (text.length <= limit) return text;
  return '…' + text.slice(-(limit - 1));
}

var AurexActivity = (function () {
  var group = null;
  var timer = null;

  function formatElapsed(ms) {
    var seconds = Math.round(ms / 1000);
    if (seconds < 60) return seconds + 's';
    return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
  }

  function tick() {
    if (!group) return;
    var el = group.node.querySelector('.activity-elapsed');
    if (el) el.textContent = formatElapsed(Date.now() - group.startedAt);
  }

  function ensureGroup() {
    if (group) return group;
    var container = document.getElementById('messages-container');
    if (!container) return null;

    var node = document.createElement('div');
    node.className = 'activity-log running';

    var head = document.createElement('button');
    head.className = 'activity-head';
    head.type = 'button';
    head.setAttribute('aria-expanded', 'true');

    var caret = document.createElement('i');
    caret.className = 'fa-solid fa-chevron-down activity-caret';
    head.appendChild(caret);

    var title = document.createElement('span');
    title.className = 'activity-title';
    title.textContent = t('activity.working');
    head.appendChild(title);

    var elapsed = document.createElement('span');
    elapsed.className = 'activity-elapsed';
    elapsed.textContent = '0s';
    head.appendChild(elapsed);

    var rows = document.createElement('div');
    rows.className = 'activity-rows';

    head.addEventListener('click', function () {
      var collapsed = node.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });

    node.appendChild(head);
    node.appendChild(rows);
    container.appendChild(node);
    container.scrollTop = container.scrollHeight;

    group = { node: node, rows: rows, startedAt: Date.now(), counts: {}, failures: 0 };
    timer = setInterval(tick, 1000);
    return group;
  }

  function addRow(desc) {
    var current = ensureGroup();
    if (!current) return null;

    var row = document.createElement('div');
    row.className = 'activity-row running';
    row.dataset.kind = desc.kind;
    row.dataset.startedAt = String(Date.now());

    var icon = document.createElement('i');
    icon.className = 'fa-solid ' + desc.icon + ' activity-icon';
    row.appendChild(icon);

    var label = document.createElement('span');
    label.className = 'activity-label';
    label.textContent = desc.label;
    row.appendChild(label);

    if (desc.target) {
      var target = document.createElement('code');
      target.className = 'activity-target';
      target.textContent = shortTarget(desc.target);
      row.appendChild(target);
    }

    var time = document.createElement('span');
    time.className = 'activity-time';
    row.appendChild(time);

    current.rows.appendChild(row);
    current.node.scrollTop = current.node.scrollHeight;
    var container = document.getElementById('messages-container');
    if (container) container.scrollTop = container.scrollHeight;
    return row;
  }

  function countRow(kind) {
    if (!group) return;
    group.counts[kind] = (group.counts[kind] || 0) + 1;
  }

  function markFailure() {
    if (group) group.failures++;
  }

  // Frase de resumo: "Criou 26 arquivos · executou 12 comandos · leu 8 arquivos".
  // Só os três tipos mais frequentes: listar os onze faz a linha estourar e
  // deixa de responder "o que ele fez?" de relance, que é a razão de existir.
  function summaryText() {
    if (!group) return '';
    var kinds = Object.keys(group.counts).sort(function (a, b) {
      return group.counts[b] - group.counts[a];
    });
    if (!kinds.length) return t('activity.nothing');

    var shown = kinds.slice(0, 3).map(function (kind) {
      var meta = ACTIVITY_KINDS[kind] || ACTIVITY_KINDS.other;
      var n = group.counts[kind];
      return meta.verb + ' ' + n + ' ' + (n === 1 ? meta.one : meta.many);
    });

    var rest = kinds.slice(3).reduce(function (sum, kind) { return sum + group.counts[kind]; }, 0);
    var text = shown.join(' · ') + (rest ? ' · +' + rest : '');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Fecha o grupo quando o turno acaba (chega texto do assistente ou o laço
  // termina). Sem isto o feed do turno seguinte cairia dentro deste.
  function close() {
    if (!group) return;
    if (timer) { clearInterval(timer); timer = null; }
    tick();
    group.node.classList.remove('running');
    if (group.failures) group.node.classList.add('had-failure');
    var title = group.node.querySelector('.activity-title');
    if (title) {
      var summary = summaryText();
      title.textContent = summary;
      title.title = summary; // o texto completo, já que a linha corta com reticências
    }
    group = null;
  }

  return { addRow: addRow, countRow: countRow, markFailure: markFailure, close: close };
})();

function appendToolCallToUI(name, args) {
  const container = document.getElementById('messages-container');
  const msgDiv = document.createElement('div');
  msgDiv.className = `tool-execution`;

  let humanMessage = "Executando ação no navegador...";
  if (name === "capture_screenshot") humanMessage = "📸 Capturando a tela da página...";
  else if (name === "dom_action") {
    if (args.command === "get_accessibility_tree") humanMessage = "🔍 Mapeando elementos da tela...";
    else if (args.command === "read_dom") humanMessage = "🔍 Analisando estrutura da página...";
    else if (args.command === "simulate_click" || args.command === "click") humanMessage = `🖱️ Clicando em um elemento...`;
    else if (args.command === "simulate_type" || args.command === "type") humanMessage = `⌨️ Digitando texto...` + (args.submit ? " (+ Enter)" : "");
    else if (args.command === "press_key") humanMessage = `⌨️ Pressionando tecla: ${args.key || "Enter"}`;
    else if (args.command === "scroll") humanMessage = `⏬ Rolando a página...`;
    else if (args.command === "navigate") humanMessage = `🌐 Navegando para URL...`;
    else if (args.command === "search_web") humanMessage = `🔎 Pesquisando no Google...`;
    else if (args.command === "wait") humanMessage = `⏳ Aguardando carregamento da página...`;
  }
  else if (name === "save_markdown_file") {
    humanMessage = "📝 Salvando Markdown em Downloads: " + (args.filename || "aurex_output.md");
  }
  else if (name === "tab_manager") {
    if (args.command === "create_tab") humanMessage = "✨ Abrindo nova aba: " + (args.url || "");
    else if (args.command === "list_tabs") humanMessage = "📋 Listando abas abertas";
    else if (args.command === "switch_tab") humanMessage = "🔄 Mudando para aba: " + args.tabId;
    else if (args.command === "close_tab") humanMessage = "❌ Fechando aba: " + args.tabId;
  }
  else if (typeof AurexMCP !== 'undefined' && AurexMCP.findTool(name)) {
    var mcpFound = AurexMCP.findTool(name);
    humanMessage = "🔌 " + (mcpFound.server.label || mcpFound.server.name) + ": " + mcpFound.tool.name;
  }
  else if (name === "workflow") {
    if (args.command === "replay") humanMessage = "▶️ Reexecutando o fluxo: " + (args.name || "");
    else if (args.command === "list") humanMessage = "📋 Listando fluxos gravados...";
    else humanMessage = "🗑️ Removendo fluxo: " + (args.name || "");
  }
  else if (name === "run_command") {
    // A rede é a diferença que o usuário precisa enxergar: com ela o
    // container passa a ter por onde falar com fora.
    humanMessage = (args.network === true ? "🌐 Executando na sandbox COM internet: " : "⚙️ Executando na sandbox: ") +
      String(args.command || "").substring(0, 60);
  }
  else if (name === "run_code") {
    var langLabel = { python: "Python", node: "Node", bash: "Bash" }[args.language] || args.language;
    humanMessage = (args.network === true ? "🌐 Rodando código " + langLabel + " na sandbox COM internet..." : "🧪 Rodando código " + langLabel + " na sandbox...");
  }
  else if (name === "dev_server") {
    if (args.command === "start") humanMessage = "🚀 Subindo servidor de preview: " + String(args.run || "").substring(0, 50);
    else if (args.command === "stop") humanMessage = "🛑 Derrubando o servidor de preview";
    else humanMessage = "📡 Checando o servidor de preview...";
  }
  else if (name === "sandbox_files") {
    if (args.command === "deliver") humanMessage = "📦 Entregando arquivo: " + (args.path || "");
    else if (args.command === "list") humanMessage = "🗂️ Listando arquivos da sandbox...";
    else if (args.command === "read") humanMessage = "📖 Lendo arquivo da sandbox: " + (args.path || "");
    else if (args.command === "write") humanMessage = "✍️ Gravando arquivo na sandbox: " + (args.path || "");
    else humanMessage = "🗑️ Apagando arquivo da sandbox: " + (args.path || "");
  }
  else if (name === "find_element") {
    humanMessage = "🎯 Localizando na página: " + (args.query || "");
  }
  else if (name === "wait_for") {
    var condLabels = {
      text_present: "o texto aparecer", text_absent: "o texto sumir",
      element_visible: "o elemento aparecer", element_gone: "o elemento sumir",
      url_matches: "a URL bater", url_changed: "a página mudar", title_changed: "o título mudar"
    };
    humanMessage = "⏱️ Aguardando " + (condLabels[args.condition] || args.condition) +
      (args.value ? ": " + String(args.value).substring(0, 40) : "") + "...";
  }
  else if (name === "web_search") {
    humanMessage = "🔎 Pesquisando na web: " + (args.query || "");
  }
  else if (name === "web_fetch") {
    var fetchHost = "";
    try { fetchHost = new URL(args.url).hostname; } catch (e) { fetchHost = args.url || ""; }
    humanMessage = "📄 Lendo página: " + fetchHost;
  }
  else if (name === "extract_page") {
    humanMessage = "📑 Extraindo conteúdo da aba atual...";
  }
  else if (name === "google_places") {
    if (args.command === "place_details") humanMessage = "📍 Buscando detalhes do local...";
    else if (args.command === "search_nearby") humanMessage = "📍 Procurando lugares por perto...";
    else humanMessage = "📍 Buscando no Google Places: " + (args.query || "");
  }
  else if (name === "api_request") {
    var apiHost = "";
    try { apiHost = new URL(args.url).hostname; } catch (e) { apiHost = ""; }
    humanMessage = "🔌 Consultando API oficial" + (apiHost ? ": " + apiHost : "") + "...";
  }
  else if (name === "task_memory") {
    humanMessage = "🧠 Salvando estado da tarefa...";
  }

  // O ícone tipado substitui o emoji: manter os dois seria ruído dobrado.
  var cleanLabel = humanMessage.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\.{3}$/, '').trim();
  var target = activityTargetFor(name, args);

  // O alvo já aparece no chip ao lado. Sem isto a linha lia
  // "Executando na sandbox: npm run build" seguida de `npm run bui…` — o
  // mesmo dado duas vezes, e o truncado empurrando o resto para fora.
  if (target) cleanLabel = cleanLabel.replace(/\s*[:—-]\s*.*$/, '').trim() || cleanLabel;

  var row = AurexActivity.addRow({
    kind: activityKindFor(name, args),
    icon: (ACTIVITY_KINDS[activityKindFor(name, args)] || ACTIVITY_KINDS.other).icon,
    label: cleanLabel,
    target: target
  });

  if (!row) return msgDiv; // sem container (aba de configurações aberta, etc.)

  row.dataset.originalMessage = cleanLabel;
  row.dataset.callSummary = name + '(' + safeJson(args) + ')';
  return row;
}

// Que TIPO de ação é esta. Alimenta o ícone e a contagem do resumo.
function activityKindFor(name, args) {
  args = args || {};
  // O prefixo é a nossa convenção de nome, então ele basta: exigir que o
  // cliente MCP esteja carregado só faria a linha perder o ícone certo se o
  // script tivesse falhado — e é aí que enxergar a origem importa mais.
  if (String(name).indexOf('mcp__') === 0) return 'connect';

  switch (name) {
    case 'run_command':
    case 'run_code':
      return 'command';
    case 'dev_server':
      return 'serve';
    case 'save_markdown_file':
      return 'write';
    case 'sandbox_files':
      if (args.command === 'deliver') return 'deliver';
      if (args.command === 'write') return 'write';
      return 'read';
    case 'capture_screenshot':
      return 'look';
    case 'web_search':
    case 'google_places':
      return 'search';
    case 'web_fetch':
    case 'extract_page':
      return 'read';
    case 'api_request':
      return 'connect';
    case 'tab_manager':
      return 'browse';
    case 'find_element':
    case 'wait_for':
      return 'look';
    case 'workflow':
      return 'interact';
    case 'task_memory':
      return 'other';
    case 'dom_action':
      if (args.command === 'navigate' || args.command === 'search_web') return 'browse';
      if (args.command === 'simulate_click' || args.command === 'simulate_type' ||
          args.command === 'press_key' || args.command === 'scroll') return 'interact';
      return 'look';
    default:
      return 'other';
  }
}

// O identificador que o usuário reconhece: o arquivo, o comando, o domínio.
// É o que transforma "Executando na sandbox" em "Executando `npm run build`".
function activityTargetFor(name, args) {
  args = args || {};
  // Domínio, mais a porta quando ela não é a padrão. Sem a porta,
  // "127.0.0.1:47000" vira só "127.0.0.1" e some justamente o que identifica
  // qual servidor de preview está sendo aberto.
  function host(url) {
    try {
      var parsed = new URL(url);
      return parsed.hostname + (parsed.port ? ':' + parsed.port : '');
    } catch (e) { return url || ''; }
  }

  switch (name) {
    case 'run_command': return args.command;
    case 'run_code': return args.filename || args.language;
    case 'dev_server': return args.run || '';
    case 'save_markdown_file': return args.filename;
    case 'sandbox_files': return args.path;
    case 'web_fetch': return host(args.url);
    case 'api_request': return host(args.url);
    case 'web_search': return args.query;
    case 'google_places': return args.query || args.place_id;
    case 'workflow': return args.name;
    case 'dom_action':
      if (args.command === 'navigate') return host(args.value);
      if (args.command === 'search_web') return args.value;
      if (args.command === 'simulate_type') return args.value;
      return '';
    case 'tab_manager':
      return args.url ? host(args.url) : '';
    case 'find_element': return args.description || args.query;
    case 'wait_for': return args.value;
    default: return '';
  }
}

function appendToolResultToUI(row, result) {
  if (!row || !row.classList || !row.classList.contains('activity-row')) return;

  row.classList.remove('running');
  row.classList.add(result.success ? 'ok' : 'failed');

  var startedAt = parseInt(row.dataset.startedAt, 10) || Date.now();
  var elapsed = Date.now() - startedAt;
  var timeEl = row.querySelector('.activity-time');
  // Só mostra duração quando ela diz alguma coisa. "0.1s" em toda linha é ruído.
  if (timeEl && elapsed >= 1000) {
    timeEl.textContent = elapsed < 60000
      ? (elapsed / 1000).toFixed(1) + 's'
      : Math.floor(elapsed / 60000) + 'm ' + Math.round((elapsed % 60000) / 1000) + 's';
  }

  AurexActivity.countRow(row.dataset.kind || 'other');
  if (!result.success) AurexActivity.markFailure();

  // Evidência visível: o que foi REALMENTE observado depois da ação. Sem isto,
  // só o modelo enxerga a verificação e o usuário precisa confiar na palavra dele.
  var evidence = buildVerificationEvidence(result);
  if (evidence) {
    var evidenceEl = document.createElement('div');
    evidenceEl.className = 'activity-note' + (evidence.warning ? ' warn' : '');
    var evidenceIcon = document.createElement('i');
    evidenceIcon.className = 'fa-solid ' + (evidence.warning ? 'fa-triangle-exclamation' : 'fa-eye');
    evidenceEl.appendChild(evidenceIcon);
    var evidenceText = document.createElement('span');
    evidenceText.textContent = evidence.text;
    evidenceEl.appendChild(evidenceText);
    row.insertAdjacentElement('afterend', evidenceEl);
  }

  // Falha aparece SEM precisar de clique: é o que o usuário precisa ler.
  if (!result.success && result.error) {
    var errorEl = document.createElement('div');
    errorEl.className = 'activity-note error';
    var errorIcon = document.createElement('i');
    errorIcon.className = 'fa-solid fa-circle-exclamation';
    errorEl.appendChild(errorIcon);
    var errorText = document.createElement('span');
    errorText.textContent = String(result.error).slice(0, 400);
    errorEl.appendChild(errorText);
    row.insertAdjacentElement('afterend', errorEl);
  }

  // O detalhe técnico continua acessível, mas atrás de um clique na linha.
  var resultStr = JSON.stringify(result);
  if (resultStr.length > 1200) resultStr = resultStr.substring(0, 1200) + '… [truncado para exibição]';
  row.dataset.resultSummary = resultStr;
  row.classList.add('inspectable');
  row.addEventListener('click', function () {
    var existing = row.nextElementSibling;
    if (existing && existing.classList.contains('activity-detail')) {
      existing.remove();
      return;
    }
    var detail = document.createElement('pre');
    detail.className = 'activity-detail';
    detail.textContent = (row.dataset.callSummary || '') + '\n\n→ ' + (row.dataset.resultSummary || '');
    row.insertAdjacentElement('afterend', detail);
  });
}

// Traduz a verificação técnica numa frase que o usuário entende, para ele
// poder auditar o que o agente afirma ter feito.
function buildVerificationEvidence(result) {
  if (!result || typeof result !== 'object') return null;

  // web_fetch precisou abrir uma aba: o usuário viu isso acontecer na tela,
  // então a interface diz por que, em vez de deixar parecer efeito colateral.
  if (result.via === 'navegador') {
    return { text: 'O download direto não funcionou; li a página abrindo-a numa aba.' };
  }

  // Digitação: o texto entrou mesmo no campo?
  if (result.text_confirmed === false) {
    return { warning: true, text: 'O texto não apareceu no campo — o foco pode ter se perdido.' };
  }
  if (result.text_confirmed === true) {
    return { text: 'Confirmado: o texto entrou no campo.' };
  }

  // Clique/navegação: a página reagiu?
  if (typeof result.effect === 'string' && result.effect) {
    if (/nenhuma mudanca detectada/i.test(result.effect)) {
      return { warning: true, text: 'Nenhuma mudança detectada na página após a ação.' };
    }
    if (result.effect !== 'nao verificado') {
      return { text: 'Verificado: ' + result.effect.split(';')[0] + '.' };
    }
  }

  // wait_for: condição observada ou estourou o tempo
  if (result.condition) {
    if (result.success) {
      return { text: 'Condição confirmada em ' + (result.waited_ms || 0) + 'ms.' };
    }
    return { warning: true, text: 'A condição não se cumpriu em ' + (result.waited_ms || 0) + 'ms.' };
  }

  // find_element: houve ambiguidade entre candidatos?
  if (result.confidence === 'ambigua') {
    return { warning: true, text: 'Mais de um elemento parecido — o alvo pode estar errado.' };
  }

  // Sandbox: o que foi produzido
  if (Array.isArray(result.artifacts) && result.artifacts.length) {
    return { text: 'Arquivo(s) gerado(s): ' + result.artifacts.map(function (a) { return a.path; }).join(', ') };
  }
  if (result.timed_out) return { warning: true, text: 'A execução estourou o tempo limite.' };
  if (result.oom_killed) return { warning: true, text: 'A execução estourou o limite de memória.' };

  return null;
}
