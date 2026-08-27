// Classificação do log de atividade.
//
// O feed troca 26 cartões soltos por 26 linhas tipadas. O que sustenta a
// legibilidade é a classificação: o ÍCONE diz o tipo da ação e o ALVO diz em
// quê. Se um dos dois erra, o feed vira uma lista de "Executando ação..."
// idênticas — exatamente o que ele veio resolver. Daí estes testes.
const { extractBlock, check, equal, group } = require('./harness');

const src =
  extractBlock('activity_log.js', 'var ACTIVITY_KINDS', 'var AurexActivity = (function') +
  extractBlock('activity_log.js', 'function activityKindFor', 'function appendToolResultToUI');

const scope = {};
new Function('scope', src +
  '\nscope.kindFor = activityKindFor;' +
  '\nscope.targetFor = activityTargetFor;' +
  '\nscope.shortTarget = shortTarget;' +
  '\nscope.KINDS = ACTIVITY_KINDS;')(scope);

const { kindFor, targetFor, shortTarget, KINDS } = scope;

group('Atividade: cada tipo tem ícone e vocabulário de resumo', () => {
  Object.keys(KINDS).forEach((kind) => {
    const meta = KINDS[kind];
    check(kind + ' tem ícone', typeof meta.icon === 'string' && meta.icon.startsWith('fa-'));
    // Singular E plural: "serviu 1 processos" é o tipo de detalhe que faz a
    // interface parecer descuidada.
    check(kind + ' tem verbo, singular e plural', !!meta.verb && !!meta.one && !!meta.many);
    check(kind + ' distingue singular de plural', meta.one !== meta.many, meta.one + '/' + meta.many);
  });
});

group('Atividade: ações da sandbox', () => {
  equal('run_command é comando', kindFor('run_command', { command: 'npm ci' }), 'command');
  equal('run_code é comando', kindFor('run_code', { language: 'python' }), 'command');
  equal('dev_server é serviço', kindFor('dev_server', { command: 'start' }), 'serve');
  equal('escrever arquivo é escrita', kindFor('sandbox_files', { command: 'write' }), 'write');
  equal('entregar arquivo tem tipo próprio', kindFor('sandbox_files', { command: 'deliver' }), 'deliver');
  equal('listar arquivo é leitura', kindFor('sandbox_files', { command: 'list' }), 'read');
});

group('Atividade: dom_action separa olhar de agir', () => {
  // A distinção importa: um feed que mostra ler e clicar com o mesmo ícone
  // esconde exatamente o que o usuário quer auditar.
  equal('navegar é navegação', kindFor('dom_action', { command: 'navigate' }), 'browse');
  equal('clicar é interação', kindFor('dom_action', { command: 'simulate_click' }), 'interact');
  equal('digitar é interação', kindFor('dom_action', { command: 'simulate_type' }), 'interact');
  equal('rolar é interação', kindFor('dom_action', { command: 'scroll' }), 'interact');
  equal('ler a árvore é observação', kindFor('dom_action', { command: 'get_accessibility_tree' }), 'look');
  equal('screenshot é observação', kindFor('capture_screenshot', {}), 'look');
});

group('Atividade: ferramenta MCP e desconhecida', () => {
  equal('MCP é conexão externa', kindFor('mcp__viagens__buscar', {}), 'connect');
  equal('ferramenta desconhecida cai em "other"', kindFor('ferramenta_nova', {}), 'other');
  check('e "other" existe no mapa de ícones', !!KINDS.other);
});

group('Atividade: o alvo identifica a ação', () => {
  equal('comando aparece inteiro', targetFor('run_command', { command: 'npm run build' }), 'npm run build');
  equal('arquivo do script', targetFor('run_code', { filename: 'gerar.py', language: 'python' }), 'gerar.py');
  equal('sem filename, cai na linguagem', targetFor('run_code', { language: 'python' }), 'python');
  equal('caminho do arquivo', targetFor('sandbox_files', { command: 'write', path: 'src/App.tsx' }), 'src/App.tsx');
  equal('busca mostra a consulta', targetFor('web_search', { query: 'preço do dólar' }), 'preço do dólar');
});

group('Atividade: URLs viram só o domínio', () => {
  // A URL inteira estoura a linha; o domínio é o que identifica.
  equal('web_fetch', targetFor('web_fetch', { url: 'https://www.joescoffee.com/menu?x=1' }), 'www.joescoffee.com');
  equal('navigate', targetFor('dom_action', { command: 'navigate', value: 'https://exemplo.com/a/b' }), 'exemplo.com');
  equal('api_request', targetFor('api_request', { url: 'https://api.exemplo.com/v1/x' }), 'api.exemplo.com');
  // Num servidor de preview local, a PORTA é o que identifica qual é
  equal('porta não padrão é preservada',
    targetFor('dom_action', { command: 'navigate', value: 'http://127.0.0.1:47000/' }), '127.0.0.1:47000');
  equal('porta padrão não polui', targetFor('web_fetch', { url: 'https://exemplo.com:443/x' }), 'exemplo.com');
  // URL inválida não pode quebrar o feed
  equal('URL inválida devolve o texto cru', targetFor('web_fetch', { url: 'nao-e-url' }), 'nao-e-url');
  equal('sem URL devolve vazio', targetFor('web_fetch', {}), '');
});

group('Atividade: alvo longo é cortado preservando o fim', () => {
  // Num caminho, o que identifica é o fim — cortar o começo é o certo.
  const longo = 'src/components/sections/hero/HeroSectionContainer.tsx';
  const curto = shortTarget(longo, 30);
  check('cabe no limite', curto.length <= 30, curto);
  check('preserva o nome do arquivo', curto.endsWith('HeroSectionContainer.tsx'), curto);
  check('sinaliza o corte', curto.startsWith('…'), curto);

  equal('texto curto passa intacto', shortTarget('npm ci', 30), 'npm ci');
  equal('nulo vira vazio', shortTarget(null, 30), '');
  equal('quebra de linha vira espaço', shortTarget('a\n  b', 30), 'a b');
});

group('Atividade: args ausentes não quebram a classificação', () => {
  check('sem args', kindFor('run_command') === 'command');
  check('args nulo', kindFor('dom_action', null) === 'look');
  equal('alvo sem args é vazio', targetFor('run_command'), undefined);
});
