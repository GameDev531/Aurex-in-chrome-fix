// Resiliência das ferramentas web.
//
// Contexto: o Aurex parou de pesquisar porque o nome do modelo do Gemini
// estava fixo no código e o Google aposentou aquele modelo — 404 em toda
// busca. Nome de modelo caduca; o código não pode depender de alguém editar
// uma constante para a ferramenta voltar a funcionar. A resposta do Google
// já diz qual modelo usar, então aproveitamos isso.
const { extractBlock, check, equal, group, fakeLocalStorage } = require('./harness');

function loadSearchConfig(stored) {
  const src = extractBlock('popup.js', 'var AUREX_DEFAULT_GEMINI_MODEL', 'function getPlacesKey');
  const scope = {};
  const storage = fakeLocalStorage(stored || {});
  new Function('scope', 'localStorage', src +
    '\nscope.heal = healGeminiModel;' +
    '\nscope.config = getSearchConfig;' +
    '\nscope.DEFAULT = AUREX_DEFAULT_GEMINI_MODEL;')(scope, storage);
  scope.storage = storage;
  return scope;
}

const ERRO_404 = JSON.stringify({
  error: {
    code: 404,
    message: 'This model models/gemini-2.0-flash is no longer available. ' +
      'Please update your code to use models/gemini-3.6-flash for the latest features and improvements.',
    status: 'NOT_FOUND'
  }
});

group('Busca: modelo aposentado se conserta sozinho', () => {
  const s = loadSearchConfig({ aurex_search_model: 'gemini-2.0-flash' });

  equal('lê o modelo que está configurado', s.config().model, 'gemini-2.0-flash');

  const novo = s.heal(ERRO_404);
  equal('extrai o substituto que o Google indicou', novo, 'gemini-3.6-flash');
  equal('e o grava, para a próxima chamada já nascer certa',
    s.config().model, 'gemini-3.6-flash');
});

group('Busca: só troca quando há substituto de verdade', () => {
  const s = loadSearchConfig({ aurex_search_model: 'gemini-3.6-flash' });

  check('erro sem sugestão não muda nada',
    s.heal('{"error":{"code":403,"message":"API key not valid"}}') === null);
  check('erro vazio não muda nada', s.heal('') === null);
  check('erro nulo não muda nada', s.heal(null) === null);
  equal('modelo permanece', s.config().model, 'gemini-3.6-flash');

  // Sugerir o modelo que já está em uso significaria repetir a chamada à toa
  const mesmo = 'This model models/x is no longer available. Please update your code to use models/gemini-3.6-flash';
  check('não repete a chamada se o sugerido já é o atual', s.heal(mesmo) === null);
});

group('Busca: sem configuração, cai no padrão atual', () => {
  const s = loadSearchConfig({});
  equal('usa o padrão embutido', s.config().model, s.DEFAULT);
  check('e o padrão não é o modelo aposentado', s.DEFAULT !== 'gemini-2.0-flash', s.DEFAULT);
});

group('Busca: aceita nomes de modelo com pontuação', () => {
  const s = loadSearchConfig({ aurex_search_model: 'antigo' });
  equal('ponto e hífen no nome',
    s.heal('Please update your code to use models/gemini-2.5-flash-preview.09-2025'),
    'gemini-2.5-flash-preview.09-2025');
});
