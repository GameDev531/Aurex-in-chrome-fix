// ========== CLIENTE DA SANDBOX ==========
// Script clássico (o popup.js não é módulo): expõe o global AurexSandbox.
//
// A sandbox roda no SERVIDOR Aurex, dentro de um container Docker isolado.
// Ela não tem acesso nenhum ao computador do usuário — isso é uma extensão
// de navegador, que não pode criar processos.

var AurexSandbox = (function () {
  var _probe = null;          // último resultado de disponibilidade
  var _probedAt = 0;
  var PROBE_TTL_MS = 60000;
  var FAILED_PROBE_TTL_MS = 3000;

  function apiBase() {
    return (typeof getAurexApiBase === 'function')
      ? getAurexApiBase()
      : 'https://api.aurexai.com/v1';
  }

  function serverRoot() {
    return apiBase().replace(/\/v\d+$/, '');
  }

  // Mesma lógica de autenticação usada pelo chat
  async function headers(extra) {
    var base = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    var apiKey = (localStorage.getItem('aurex_api_key') || '').trim();
    var localMode = localStorage.getItem('aurex_local_mode') === 'true';
    if (apiKey) {
      base['Authorization'] = 'Bearer ' + apiKey;
    } else if (!localMode && typeof getAurexAccessToken === 'function') {
      try {
        base['Authorization'] = 'Bearer ' + (await getAurexAccessToken());
      } catch (e) { /* sem token: o servidor decide se aceita */ }
    }
    return base;
  }

  // O id da sessão amarra o workspace à conversa: escrever um script numa
  // mensagem e executá-lo na seguinte funciona porque o diretório persiste.
  function sessionId() {
    var chatId = (typeof currentChatId !== 'undefined' && currentChatId) ? String(currentChatId) : 'default';
    return ('aurex-' + chatId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  }

  // Sonda o /health (sem autenticação) para saber se pode oferecer as
  // ferramentas ao modelo.
  async function probe(force) {
    // Resultado NEGATIVO vale pouco tempo. Cachear "indisponível" pelos mesmos
    // 60s de um "disponível" é o que fazia o usuário subir o servidor e o
    // Aurex continuar jurando que não existia — um /health que falha é
    // barato de repetir; um que funciona é que vale a pena guardar.
    var ttl = (_probe && _probe.ready) ? PROBE_TTL_MS : FAILED_PROBE_TTL_MS;
    if (!force && _probe && (Date.now() - _probedAt) < ttl) return _probe;
    try {
      var res = await fetch(serverRoot() + '/health', { method: 'GET' });
      if (!res.ok) throw new Error('health ' + res.status);
      var data = await res.json();
      var sandbox = data.sandbox || {};
      _probe = {
        enabled: !!sandbox.enabled,
        ready: !!sandbox.ready,
        // Rede é opt-in do OPERADOR (AUREX_SANDBOX_ALLOW_NETWORK). Quando
        // ligada, o modelo pode pedir internet por execução — é o que permite
        // npm install / pip install e, com isso, montar um projeto de verdade.
        allowNetwork: !!sandbox.allow_network,
        allowServices: !!sandbox.allow_services,
        reason: sandbox.reason || (sandbox.enabled ? null : 'Sandbox desativada no servidor.')
      };
    } catch (err) {
      // O endereço PRECISA aparecer aqui. "Servidor inacessível" sozinho
      // esconde a causa mais comum: a extensão continua apontando para o
      // endpoint padrão em vez do servidor local que o usuário subiu, e
      // nenhum .env na máquina dele muda isso.
      _probe = {
        enabled: false,
        ready: false,
        allowNetwork: false,
        allowServices: false,
        reason: 'não consegui falar com ' + serverRoot() + ' (' + err.message + ')',
        endpoint: serverRoot()
      };
    }
    _probedAt = Date.now();
    return _probe;
  }

  function isReady() {
    return !!(_probe && _probe.ready);
  }

  // Valor já conhecido, sem ir à rede — a diretiva do system prompt é montada
  // de forma síncrona a cada requisição.
  function cached() {
    return _probe;
  }

  async function request(method, path, options) {
    options = options || {};
    var url = apiBase() + '/sandbox' + path;
    var init = { method: method, headers: await headers() };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    var res = await fetch(url, init);
    var text = await res.text();
    var data;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

    if (!res.ok) {
      var err = (data && data.error) || {};
      return {
        success: false,
        error: err.message || ('O servidor respondeu ' + res.status),
        code: err.code || ('http_' + res.status)
      };
    }
    return Object.assign({ success: true }, data);
  }

  async function exec(spec) {
    var status = await probe();
    if (!status.ready) {
      return { success: false, error: 'Sandbox indisponivel: ' + status.reason, code: 'sandbox_unavailable' };
    }
    return request('POST', '/sessions/' + sessionId() + '/exec', { body: spec });
  }

  // ---------- Serviços de longa duração ----------
  //
  // A porta é publicada na loopback do HOST DO SERVIDOR. Isso só é alcançável
  // pelo navegador do usuário quando o servidor Aurex roda na mesma máquina —
  // que é o caso do modo local, mas não de um servidor remoto. Em vez de
  // devolver uma URL que não abre, dizemos qual é a situação.
  function browserReachableUrl(hostPort) {
    var host;
    try { host = new URL(serverRoot()).hostname; } catch (e) { return null; }
    var isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return isLocal ? 'http://' + host + ':' + hostPort : null;
  }

  function decorateService(res) {
    if (!res || !res.host_port) return res;
    var reachable = browserReachableUrl(res.host_port);
    res.browser_url = reachable;
    if (!reachable) {
      res.browser_note = 'O servico esta de pe na maquina do servidor Aurex, que nao e esta. ' +
        'O navegador daqui nao alcanca 127.0.0.1:' + res.host_port + ', entao voce NAO consegue ' +
        'abrir nem tirar screenshot dele. Use os logs para verificar, ou rode o servidor Aurex localmente.';
    }
    return res;
  }

  async function startService(spec) {
    var status = await probe();
    if (!status.ready) {
      return { success: false, error: 'Sandbox indisponivel: ' + status.reason, code: 'sandbox_unavailable' };
    }
    var res = await request('POST', '/sessions/' + sessionId() + '/service', { body: spec });
    return decorateService(res);
  }

  async function serviceStatus() {
    var res = await request('GET', '/sessions/' + sessionId() + '/service');
    return decorateService(res);
  }

  async function stopService() {
    return request('DELETE', '/sessions/' + sessionId() + '/service');
  }

  async function listFiles(path, depth) {
    var query = '?path=' + encodeURIComponent(path || '.') + '&depth=' + (depth || 3);
    return request('GET', '/sessions/' + sessionId() + '/files' + query);
  }

  async function readFile(path, maxBytes) {
    var query = '?path=' + encodeURIComponent(path) + '&max_bytes=' + (maxBytes || 65536);
    return request('GET', '/sessions/' + sessionId() + '/files/content' + query);
  }

  async function writeFile(path, content, encoding) {
    return request('POST', '/sessions/' + sessionId() + '/files', {
      body: { path: path, content: content, encoding: encoding || 'utf8' }
    });
  }

  async function deleteFile(path) {
    return request('DELETE', '/sessions/' + sessionId() + '/files?path=' + encodeURIComponent(path));
  }

  // Traz o arquivo do servidor e entrega na pasta Downloads do usuário.
  // Não dá para colocar header Authorization num chrome.downloads.download,
  // por isso buscamos os bytes e criamos um Blob.
  async function deliver(path, saveAs) {
    var url = apiBase() + '/sandbox/sessions/' + sessionId() +
      '/files/raw?path=' + encodeURIComponent(path);
    var res = await fetch(url, { headers: await headers() });
    if (!res.ok) {
      return { success: false, error: 'Nao consegui baixar o arquivo do servidor (' + res.status + ')' };
    }
    var blob = await res.blob();
    var filename = sanitizeArtifactFilename(saveAs || path.split('/').pop());
    var objectUrl = URL.createObjectURL(blob);

    return new Promise(function (resolve) {
      chrome.downloads.download({ url: objectUrl, filename: filename, saveAs: false }, function (downloadId) {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve({
            success: true,
            message: 'Arquivo entregue na pasta Downloads: ' + filename,
            filename: filename,
            size: blob.size,
            downloadId: downloadId
          });
        }
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 2000);
      });
    });
  }

  return {
    probe: probe,
    cached: cached,
    isReady: isReady,
    sessionId: sessionId,
    exec: exec,
    listFiles: listFiles,
    readFile: readFile,
    writeFile: writeFile,
    deleteFile: deleteFile,
    deliver: deliver,
    startService: startService,
    serviceStatus: serviceStatus,
    stopService: stopService,
    browserReachableUrl: browserReachableUrl
  };
})();

// A sandbox pode produzir bytes arbitrários. Preservamos a extensão real
// (sanitizeMarkdownFilename transformaria relatorio.xlsx em relatorio.xlsx.md)
// e bloqueamos executáveis — nunca entregar ao usuário um clique-e-executa.
var AUREX_BLOCKED_ARTIFACT_EXTS = [
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'dll', 'lnk', 'ps1', 'vbs', 'jar', 'app', 'deb', 'rpm'
];

function sanitizeArtifactFilename(name) {
  var value = String(name || 'arquivo').replace(/\\/g, '/').split('/').pop().trim();
  value = value.replace(/[<>:"|?*\x00-\x1F]/g, '_').replace(/^\.+/, '').trim();
  if (!value) value = 'arquivo';
  if (value.length > 120) {
    var parts = value.split('.');
    var ext = parts.length > 1 ? '.' + parts.pop() : '';
    value = parts.join('.').slice(0, 120 - ext.length) + ext;
  }
  var extMatch = value.match(/\.([A-Za-z0-9]+)$/);
  if (extMatch && AUREX_BLOCKED_ARTIFACT_EXTS.indexOf(extMatch[1].toLowerCase()) !== -1) {
    value += '.txt';
  }
  return value;
}
