// O que "sair" precisa levar junto (docket ray-seam, STORE-02).
//
// O logout removia só o token do Aurex e deixava para trás as chaves de API do
// usuário, os tokens dos servidores MCP e o histórico completo das conversas —
// que carrega o conteúdo das páginas que o agente leu. Numa máquina
// compartilhada, um "sair" que não apaga nada disso é pior que não ter botão.
const { extractBlock, check, equal, group, fakeLocalStorage } = require('./harness');

const src = extractBlock('popup.js', 'var AUREX_SECRET_KEYS', 'var SYSTEM_PROMPT');

function load(inicial) {
  const storage = fakeLocalStorage(inicial);
  const scope = {};
  new Function('localStorage', 'scope', src +
    '\nscope.clear = clearLocalSecrets;' +
    '\nscope.KEYS = AUREX_SECRET_KEYS;')(storage, scope);
  scope.storage = storage;
  return scope;
}

group('Logout: credenciais e histórico são apagados', () => {
  const s = load({
    aurex_api_key: 'chave-do-servidor',
    aurex_places_key: 'chave-places',
    aurex_search_key: 'chave-busca',
    aurex_api_integrations: '[{"host":"api.exemplo.com","key":"segredo"}]',
    aurex_mcp_servers: '[{"name":"viagens","token":"bearer-do-mcp"}]',
    aurex_chats: '[{"messages":[{"role":"user","content":"conteudo da pagina lida"}]}]',
    aurex_active_task: 'tarefa em andamento',
    // Preferências: NÃO são segredo e devem sobreviver
    aurex_lang: 'pt',
    aurex_mode: 'plan',
    aurex_shortcuts: '[]',
    aurex_user_skills: '[]',
    aurex_personality: 'seja conciso'
  });

  s.clear();

  ['aurex_api_key', 'aurex_places_key', 'aurex_search_key', 'aurex_api_integrations']
    .forEach((k) => check('apaga ' + k, s.storage.getItem(k) === null));

  check('apaga o token dos servidores MCP', s.storage.getItem('aurex_mcp_servers') === null);
  check('apaga o histórico (contém o conteúdo das páginas lidas)',
    s.storage.getItem('aurex_chats') === null);
  check('apaga a tarefa em andamento', s.storage.getItem('aurex_active_task') === null);
});

group('Logout: preferências sobrevivem', () => {
  const s = load({
    aurex_api_key: 'segredo',
    aurex_lang: 'pt', aurex_mode: 'plan', aurex_shortcuts: '[]',
    aurex_user_skills: '[]', aurex_personality: 'seja conciso'
  });
  s.clear();

  // Apagar preferência não protege ninguém e só irrita quem sai e volta.
  equal('idioma fica', s.storage.getItem('aurex_lang'), 'pt');
  equal('modo fica', s.storage.getItem('aurex_mode'), 'plan');
  equal('atalhos ficam', s.storage.getItem('aurex_shortcuts'), '[]');
  equal('skills ficam', s.storage.getItem('aurex_user_skills'), '[]');
  equal('personalidade fica', s.storage.getItem('aurex_personality'), 'seja conciso');
});

group('Logout: a lista cobre tudo que guarda segredo', () => {
  const s = load({});
  // Guarda contra alguém adicionar uma chave nova de credencial e esquecer
  // de listá-la aqui. Se um destes sumir da lista, o teste avisa.
  ['aurex_api_key', 'aurex_places_key', 'aurex_search_key',
   'aurex_api_integrations', 'aurex_mcp_servers', 'aurex_chats'
  ].forEach((k) => check(k + ' está na lista de limpeza', s.KEYS.includes(k)));

  check('não apaga sem necessidade', s.KEYS.includes('aurex_lang') === false);
  check('storage vazio não quebra', (() => { try { s.clear(); return true; } catch (e) { return false; } })());
});
