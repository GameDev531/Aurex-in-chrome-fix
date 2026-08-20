// Testes de segurança: cada um destes cobre um defeito REAL que já existiu
// neste código. Servem para impedir que voltem em silêncio.
const { extractBlock, check, equal, group, fakeLocalStorage } = require('./harness');

// ---------- Sanitização de nome de artefato ----------
group('Entrega de arquivo: sanitizador de nome', () => {
  const src = extractBlock('sandbox_client.js', 'var AUREX_BLOCKED_ARTIFACT_EXTS');
  const scope = {};
  new Function('scope', src + '\nscope.sanitizeArtifactFilename = sanitizeArtifactFilename;')(scope);
  const fn = scope.sanitizeArtifactFilename;

  // Regressão: o sanitizador antigo transformava relatorio.xlsx em .xlsx.md
  equal('preserva a extensão real', fn('relatorio.xlsx'), 'relatorio.xlsx');
  equal('preserva .docx', fn('planilha.docx'), 'planilha.docx');
  check('corta path traversal', fn('../../etc/passwd') === 'passwd');
  check('neutraliza .exe', fn('virus.exe').endsWith('.txt'));
  check('neutraliza .ps1', fn('script.ps1').endsWith('.txt'));
  check('neutraliza .jar', fn('app.jar').endsWith('.txt'));
  check('remove ponto inicial', !fn('.oculto').startsWith('.'));
  check('limita o tamanho', fn('a'.repeat(300) + '.pdf').length <= 124);
});

// ---------- Limpeza de segredos ----------
group('Chaves de API: limpeza antes de chegar ao modelo', () => {
  // collectConfiguredSecrets depende de getApiIntegrations, definida antes no arquivo
  const src = extractBlock('popup.js', 'function getApiIntegrations', 'function saveApiIntegrations') +
    extractBlock('popup.js', 'function collectConfiguredSecrets', '// Executa a chamada de API injetando');
  const scope = {
    localStorage: fakeLocalStorage({
      aurex_api_integrations: JSON.stringify([
        { host: 'maps.googleapis.com', key: 'AIzaSyD-CHAVE-SECRETA-LONGA-123' }
      ]),
      aurex_places_key: 'AIzaPLACES-SECRETA-456789',
      aurex_search_key: 'tvly-BUSCA-SECRETA-98765'
    })
  };
  new Function('localStorage', 'scope', src + '\nscope.scrubSecrets = scrubSecrets;')(scope.localStorage, scope);
  const scrub = scope.scrubSecrets;

  // Regressão: APIs do Google ecoam a chave na mensagem de erro
  check('remove chave ecoada pela API',
    !scrub('API key not valid: AIzaSyD-CHAVE-SECRETA-LONGA-123').includes('AIzaSyD'));
  check('remove chave do Places',
    !scrub('{"error":"Invalid AIzaPLACES-SECRETA-456789"}').includes('AIzaPLACES'));
  check('remove chave de busca',
    !scrub('rejected tvly-BUSCA-SECRETA-98765').includes('tvly-BUSCA'));
  check('não altera texto sem segredo',
    scrub('resposta normal') === 'resposta normal');
  check('ignora strings curtas (sem substituição acidental)',
    scrub('abc') === 'abc');
});

// ---------- Domínio registrável (anti-phishing) ----------
group('Alerta de troca de domínio', () => {
  const src = extractBlock('popup.js', 'var COMPOUND_SUFFIXES', 'function resetTaskOrigin');
  const scope = {};
  new Function('scope', src + '\nscope.registrableRoot = registrableRoot;')(scope);
  const root = scope.registrableRoot;
  const shifts = (a, b) => root(a) !== root(b);

  // Regressão: reduzir aos 2 últimos rótulos fazia todo .com.br parecer o mesmo dono
  check('phishing em .edu.br é detectado',
    shifts('studeo.unicesumar.edu.br', 'site-falso.edu.br'));
  check('bancos distintos em .com.br são detectados',
    shifts('meubanco.com.br', 'outrobanco.com.br'));
  check('subdomínio do mesmo dono NÃO alarma',
    !shifts('studeo.unicesumar.edu.br', 'portal.unicesumar.edu.br'));
  check('login do mesmo site NÃO alarma',
    !shifts('exemplo.com', 'login.exemplo.com'));
  check('sufixo enganoso é detectado',
    shifts('exemplo.com', 'exemplo.com.evil.net'));
  check('.co.uk tratado corretamente',
    shifts('loja.co.uk', 'fake.co.uk'));
  check('maiúsculas normalizadas',
    !shifts('LOJA.COM', 'loja.com'));
});

// ---------- Separação leitura/escrita por modo ----------
group('Modo Plano: dry-run garantido por estrutura', () => {
  const toolsSrc = extractBlock('popup.js', 'const TOOLS = [', 'let chatHistory = [');
  const modeSrc = extractBlock('popup.js', 'var AUREX_MODES =', 'function setupModeSelector');
  const scope = {};
  const storage = fakeLocalStorage({ aurex_mode: 'plan' });
  new Function('localStorage', 'chrome', 'scope',
    toolsSrc + modeSrc +
    '\nscope.TOOLS = TOOLS; scope.toolsForMode = toolsForMode;' +
    '\nscope.toolAccessFor = toolAccessFor; scope.approve = approvePlanForConversation;'
  )(storage, { storage: { local: { set: () => {} } } }, scope);

  const plano = scope.toolsForMode('plan').map((t) => t.function.name);
  const escrita = ['save_markdown_file', 'tab_manager', 'api_request', 'run_command', 'run_code', 'sandbox_files', 'workflow'];
  check('nenhuma ferramenta de escrita em modo Plano',
    escrita.every((n) => !plano.includes(n)),
    'presentes: ' + escrita.filter((n) => plano.includes(n)).join(','));

  const dom = scope.toolsForMode('plan').find((t) => t.function.name === 'dom_action');
  const cmds = dom.function.parameters.properties.command.enum;
  check('dom_action sem comandos de escrita',
    !cmds.includes('simulate_click') && !cmds.includes('navigate'));

  // Regressão: filtro raso mutava o array original
  const orig = scope.TOOLS.find((t) => t.function.name === 'dom_action');
  check('array TOOLS original não é mutado',
    orig.function.parameters.properties.command.enum.includes('simulate_click'));

  scope.approve();
  check('aprovar o plano destrava as ferramentas',
    scope.toolsForMode('plan').length === scope.TOOLS.length);

  equal('ferramenta desconhecida é tratada como escrita (fail-safe)',
    scope.toolAccessFor('inventada', {}), 'write');
  equal('dom_action/get_accessibility_tree é leitura',
    scope.toolAccessFor('dom_action', { command: 'get_accessibility_tree' }), 'read');
  equal('dom_action/simulate_click é escrita',
    scope.toolAccessFor('dom_action', { command: 'simulate_click' }), 'write');
});

// ---------- Teto de consumo ----------
group('Teto de consumo (unbounded consumption)', () => {
  const src = extractBlock('popup.js', 'var _usage = {', '// ========== ESTADO DA TAREFA');
  const scope = {};
  const storage = fakeLocalStorage({ aurex_token_cap: '10000' });
  new Function('localStorage', 'document', 't', 'scope',
    src + '\nscope.recordUsage = recordUsage; scope.isOverSpendCap = isOverSpendCap;' +
    '\nscope.usageTotal = usageTotal; scope.formatTokens = formatTokens;'
  )(storage, { getElementById: () => null }, (k) => k, scope);

  check('abaixo do teto não bloqueia', !scope.isOverSpendCap());
  scope.recordUsage({ prompt_tokens: 6000, completion_tokens: 1000 });
  check('ainda abaixo do teto', !scope.isOverSpendCap());
  scope.recordUsage({ prompt_tokens: 4000, completion_tokens: 500 });
  check('acima do teto bloqueia', scope.isOverSpendCap());
  equal('formatação de milhares', scope.formatTokens(25000), '25.0k');
  equal('formatação de milhões', scope.formatTokens(1500000), '1.5M');
});
