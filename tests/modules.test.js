// O contrato que mantém a divisão em arquivos funcionando.
//
// O painel é um monte de script clássico num escopo global só. Isso é o que
// permite dividir o código sem reescrever tudo, e é também o que quebra em
// silêncio de três jeitos:
//
//   1. arquivo criado e esquecido no popup.html — ReferenceError em runtime;
//   2. mesmo nome declarado em dois arquivos — SyntaxError (let/const) ou,
//      pior, sombreamento silencioso (var/function): o último a carregar vence
//      e o comportamento muda dependendo da ORDEM das tags;
//   3. módulo que EXECUTA algo no carregamento dependendo de outro arquivo —
//      funciona ou não conforme quem carregou primeiro.
//
// Nenhum dos três aparece em `node --check`. Daí estes testes.
const fs = require('node:fs');
const path = require('node:path');
const { readSource, check, equal, group, ROOT } = require('./harness');

const html = readSource('popup.html');
const scripts = Array.from(html.matchAll(/<script\s+src="([^"]+)"/g)).map((m) => m[1]);

// Os módulos que nasceram da divisão do popup.js. Terceiros (dompurify, gsap)
// ficam de fora: não seguem a nossa convenção e não precisam seguir.
const NOSSOS = scripts.filter((s) => !/\.min\.js$/.test(s));

group('popup.html: toda tag <script> aponta para um arquivo que existe', () => {
  check('há tags de script', scripts.length > 0);
  for (const src of scripts) {
    check(src + ' existe', fs.existsSync(path.join(ROOT, src)));
  }
  check('popup.js é o ÚLTIMO', scripts[scripts.length - 1] === 'popup.js',
    'ele é quem chama os setup* no DOMContentLoaded; carregar antes de um módulo o deixaria sem as funções');
});

// Declarações no nível zero de indentação — que é o escopo global aqui.
function topLevelNames(file) {
  const names = new Map();
  const src = readSource(file).split('\n');
  const re = /^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
  src.forEach((line, i) => {
    const m = re.exec(line);
    if (m) names.set(m[1], i + 1);
  });
  return names;
}

group('Nenhum nome global é declarado em dois arquivos', () => {
  const dono = new Map();
  const colisoes = [];
  for (const file of NOSSOS) {
    for (const [name, line] of topLevelNames(file)) {
      if (dono.has(name)) {
        colisoes.push(`${name}: ${dono.get(name)} e ${file}:${line}`);
      } else {
        dono.set(name, `${file}:${line}`);
      }
    }
  }
  equal('sem colisão', colisoes, []);
  check('e há globais de verdade para colidir', dono.size > 200, `${dono.size} nomes`);
});

group('Módulos só DECLARAM no carregamento', () => {
  // popup.js é o dono da inicialização — é ele quem pode executar.
  const modulos = NOSSOS.filter((f) => f !== 'popup.js' && f !== 'i18n.js');
  check('há módulos para conferir', modulos.length >= 5);

  for (const file of modulos) {
    const linhas = readSource(file).split('\n');
    const execucoes = [];
    linhas.forEach((line, i) => {
      // Começa na coluna zero, não é declaração, não é comentário, não é
      // continuação de literal — e chama alguma coisa.
      if (!line || /^\s/.test(line)) return;
      if (/^(\/\/|\/\*|\*)/.test(line)) return;
      if (/^(?:async\s+)?(?:function|const|let|var|class)\s/.test(line)) return;
      if (/^[)}\]];?,?$/.test(line)) return;
      if (/^[A-Za-z_$][\w$.]*\s*\(/.test(line)) execucoes.push(`${file}:${i + 1} ${line.trim().slice(0, 60)}`);
    });
    equal(file + ' não executa nada no topo', execucoes, []);
  }
});

group('Os módulos extraídos continuam donos do que era deles', () => {
  // Guarda contra reintrodução acidental no popup.js: se alguém colar de volta
  // uma dessas funções, o nome passa a existir em dois arquivos e o teste de
  // colisão acima pega. Este aqui garante o outro lado — que o módulo não ficou
  // vazio depois de um merge malfeito.
  const esperado = {
    'store_catalog.js': ['STORE_SKILLS_CATALOG', 'getStoreSkillPresentation'],
    'ui_motion.js': ['MotionUI', 'setupMotion', 'streamAssistantMessage', 'prefersReducedMotion'],
    'activity_log.js': ['ACTIVITY_KINDS', 'AurexActivity', 'appendToolCallToUI',
                        'activityKindFor', 'activityTargetFor', 'appendToolResultToUI',
                        'buildVerificationEvidence'],
    'docx.js': ['buildDocxBytes', 'buildDocxBlob'],
    'net_guard.js': ['isPrivateNetworkHost', 'ipv4FromHostname', 'webFetchEgressBytes'],
    'web_tools.js': ['executeWebSearch', 'executeWebFetch', 'executeGooglePlaces',
                     'getToolingDirective', 'healGeminiModel'],
    'browser_tools.js': ['executeToolInBrowser', 'sanitizeMarkdownFilename', 'getActiveWebTab']
  };

  for (const [file, nomes] of Object.entries(esperado)) {
    const declarados = topLevelNames(file);
    const faltando = nomes.filter((n) => !declarados.has(n));
    equal(file + ' declara o que promete', faltando, []);
  }
});

group('O portão de permissão continua fora do alcance da página', () => {
  // A divisão em arquivos não muda fronteira de confiança nenhuma — só a
  // separação de CONTEXTO muda. Este teste existe para que a afirmação do
  // ARQUITETURA.md seja verificada, e não só escrita.
  const bg = readSource('background.js');
  check('background.js é quem decide a permissão',
    /requestPermission|permission_manager|PermissionManager/.test(bg));

  const content = readSource('content.js');
  check('content.js não concede permissão sozinho',
    !/grantPermission|permission_granted\s*=\s*true/.test(content));

  const manifest = JSON.parse(readSource('manifest.json'));
  const csp = (manifest.content_security_policy || {}).extension_pages || '';
  check('a CSP do painel proíbe script fora do pacote', /script-src 'self'/.test(csp), csp);
  check('e proíbe base-uri', /base-uri 'none'/.test(csp), csp);
});
