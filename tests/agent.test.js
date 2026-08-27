// Testes de comportamento do agente: resolução de elementos, resiliência do
// replay e dispensa de banners. Cada caso aqui já quebrou em algum momento.
const { extractBlock, check, equal, group } = require('./harness');

function loadResolver() {
  // capAXTree fica depois da seção de verificação no arquivo: dois blocos
  const src = extractBlock('background.js', 'const INTERACTIVE_ROLES', '// ========== INTERRUPÇÕES') +
    extractBlock('background.js', '// Corta a árvore para caber', 'async function handleDebuggerAction');
  const scope = {};
  new Function('scope', src +
    '\nscope.resolveElements = resolveElements;' +
    '\nscope.filterAXTree = filterAXTree;' +
    '\nscope.capAXTree = capAXTree;' +
    '\nscope.normalizeText = normalizeText;'
  )(scope);
  return scope;
}

group('Resolver de elementos', () => {
  const { resolveElements } = loadResolver();
  const page = [
    { id: 1, role: 'link', name: 'Início' },
    { id: 2, role: 'button', name: 'Entrar' },
    { id: 3, role: 'button', name: 'Entrar com Google' },
    { id: 4, role: 'textbox', name: 'E-mail' },
    { id: 5, role: 'textbox', name: 'Senha' },
    { id: 6, role: 'searchbox', name: 'Pesquisar no site' },
    { id: 7, role: 'StaticText', name: 'Entrar na sua conta para continuar' },
    { id: 8, role: 'button', name: 'Comprar', disabled: true },
    { id: 9, role: 'button', name: 'Comprar agora' },
    { id: 10, role: 'button', name: 'Acessar M.A.P.A' }
  ];
  const best = (q, role) => (resolveElements(page, q, role, 3)[0] || {}).id;

  check('"botão Entrar" escolhe o botão, não o texto solto', best('botão Entrar') === 2);
  // Regressão: hífen impedia "email" de casar com "E-mail"
  check('"campo de email" acha "E-mail"', best('campo de email') === 4);
  // Regressão: pontuação impedia "MAPA" de casar com "M.A.P.A"
  check('"M.A.P.A" casa apesar da pontuação', best('acessar o M.A.P.A') === 10);
  check('"pesquisar" prefere o searchbox', best('pesquisar') === 6);
  check('desabilitado não fica em primeiro', best('comprar') === 9);
  // Regressão: busca sem sentido devolvia candidatos com ar de confiança
  equal('termo inexistente não devolve candidato', resolveElements(page, 'xyzabc123', null, 3).length, 0);
});

group('Contexto de ancestrais desempata elementos idênticos', () => {
  const { filterAXTree, resolveElements } = loadResolver();
  const nodes = [
    { backendDOMNodeId: 1, nodeId: 'a1', role: { value: 'form' }, name: { value: 'Perfil' } },
    { backendDOMNodeId: 2, nodeId: 'a2', parentId: 'a1', role: { value: 'button' }, name: { value: 'Salvar' } },
    { backendDOMNodeId: 3, nodeId: 'a3', role: { value: 'form' }, name: { value: 'Senha' } },
    { backendDOMNodeId: 4, nodeId: 'a4', parentId: 'a3', role: { value: 'button' }, name: { value: 'Salvar' } }
  ];
  const tree = filterAXTree(nodes, 'F1');
  const byId = (id) => tree.find((n) => n.id === id);

  equal('contexto do primeiro Salvar', byId(2).context, 'form[Perfil]');
  equal('contexto do segundo Salvar', byId(4).context, 'form[Senha]');
  check('"salvar senha" escolhe o do formulário de senha',
    resolveElements(tree, 'salvar senha', null, 2)[0].id === 4);
  check('"salvar perfil" escolhe o do formulário de perfil',
    resolveElements(tree, 'salvar perfil', null, 2)[0].id === 2);
});

group('Truncagem da árvore preserva o que importa', () => {
  const { capAXTree } = loadResolver();
  const big = Array.from({ length: 500 }, (_, i) => ({
    id: i, role: i < 20 ? 'button' : 'StaticText', name: 'n' + i
  }));
  const capped = capAXTree(big, 100);
  equal('respeita o limite', capped.tree.length, 100);
  equal('preserva TODOS os interativos', capped.tree.filter((n) => n.role === 'button').length, 20);
  check('sinaliza truncagem', capped.truncated === true);
  check('árvore pequena passa intacta', capAXTree(big.slice(0, 10), 100).truncated === false);
});

group('Replay resiste a deriva de seletor', () => {
  const src = extractBlock('background.js', 'function cssEscapeValue', 'async function replayWorkflow');
  const scope = {};
  // A página "mudou": as classes CSS foram renomeadas, ids/labels sobreviveram
  const dom = { '#entrar': true, '[aria-label="Enviar"]': true, '[data-testid="submit"]': true };
  const executeCDPCommand = async (t, cmd, p) => {
    if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (cmd === 'DOM.querySelector') return dom[p.selector] ? { nodeId: 42 } : { nodeId: 0 };
    if (cmd === 'DOM.describeNode') return { node: { backendNodeId: 99 } };
    return {};
  };
  const getAccessibilityTreeAllFrames = async () => ({ tree: [{ id: 777, role: 'button', name: 'Continuar' }] });
  const resolveElements = (tree, q) =>
    tree.filter((n) => n.name.toLowerCase() === String(q).toLowerCase()).map((n) => ({ id: n.id, score: 187 }));

  new Function('executeCDPCommand', 'getAccessibilityTreeAllFrames', 'resolveElements', 'scope',
    src + '\nscope.resolveStepToNodeId = resolveStepToNodeId; scope.idSelector = idSelector;'
  )(executeCDPCommand, getAccessibilityTreeAllFrames, resolveElements, scope);

  const run = async () => {
    const byTestId = await scope.resolveStepToNodeId(1, { testId: 'submit', selector: 'div.classe-antiga > button' });
    check('cai no data-testid quando o CSS quebra', byTestId && byTestId.how === 'data-testid');

    const byId = await scope.resolveStepToNodeId(1, { id: 'entrar', selector: '.sumiu' });
    check('cai no id quando o CSS quebra', byId && byId.how === 'id');

    const byAria = await scope.resolveStepToNodeId(1, { ariaLabel: 'Enviar', selector: '.sumiu' });
    check('cai no aria-label', byAria && byAria.how === 'aria-label');

    const byText = await scope.resolveStepToNodeId(1, { text: 'Continuar', selector: '.sumiu' });
    check('última reserva: texto visível', byText && byText.how === 'texto visivel');

    const none = await scope.resolveStepToNodeId(1, { selector: '.nada', text: 'Inexistente' });
    check('sem âncora válida devolve nulo', none === null);

    equal('id normal vira #id', scope.idSelector('meu-botao'), '#meu-botao');
    equal('id com caractere especial vira seletor de atributo',
      scope.idSelector('form:field:2'), '[id="form:field:2"]');
  };
  // O harness é síncrono; resolvemos aqui e deixamos as checagens registrarem
  return run();
});

group('Verificação pós-ação vira evidência legível', () => {
  const src = extractBlock('activity_log.js', 'function buildVerificationEvidence');
  const scope = {};
  new Function('scope', src + '\nscope.build = buildVerificationEvidence;')(scope);
  const build = scope.build;

  check('digitação confirmada', build({ text_confirmed: true }).warning !== true);
  check('foco perdido vira aviso', build({ text_confirmed: false }).warning === true);
  check('clique sem efeito vira aviso',
    build({ effect: 'nenhuma mudanca detectada na pagina' }).warning === true);
  check('navegação é reportada',
    build({ effect: 'a URL mudou para https://x' }).text.includes('URL'));
  check('condição não cumprida vira aviso',
    build({ condition: 'text_present', success: false, waited_ms: 10000 }).warning === true);
  check('ambiguidade vira aviso', build({ confidence: 'ambigua' }).warning === true);
  check('artefatos são listados',
    build({ artifacts: [{ path: 'a.docx' }] }).text.includes('a.docx'));
  check('resultado irrelevante não gera ruído', build({ success: true }) === null);
});
