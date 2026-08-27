// Diagnóstico de conexão do servidor.
//
// Bug relatado: "o teste acusa que não conecta, mas o chat funciona".
// Reproduzido carregando a extensão de verdade no Chrome e clicando no botão:
// o diagnóstico NÃO estava errado, estava mal comunicado. Com o servidor no ar
// e a sandbox desligada, ele imprimia "✕ Sandbox desligada" em âmbar logo
// abaixo de "✓ Servidor respondeu" — e um ✕ alaranjado lê-se como falha de
// conexão. Recurso desligado por configuração é ESTADO, não erro.
const { extractBlock, check, equal, group } = require('./harness');

const src = extractBlock('popup.js', '  function buildServerDiagnostic', '  function renderServerDiagnostic');
const scope = {};
new Function('scope', 't', src + '\nscope.build = buildServerDiagnostic;')(scope, (k) => k);
const build = scope.build;

group('Diagnóstico: servidor no ar é SUCESSO, mesmo sem os opcionais', () => {
  const d = build({
    endpoint: 'http://127.0.0.1:3000',
    probe: { enabled: false, ready: false, allowNetwork: false, allowServices: false,
             reason: 'Sandbox desativada no servidor.' }
  });

  // O ponto do bug: isto precisa ser 'good', não 'warn'/'bad'.
  equal('status é sucesso', d.status, 'good');
  equal('a manchete fala da CONEXÃO', d.headline, 'settings.server.reachable');
  check('sem dica de erro', !d.hint);
  equal('lista as três capacidades', d.capabilities.length, 3);
  check('todas aparecem como desligadas, não como falha',
    d.capabilities.every((c) => c.on === false));
});

group('Diagnóstico: tudo ligado', () => {
  const d = build({
    endpoint: 'http://127.0.0.1:3000',
    probe: { enabled: true, ready: true, allowNetwork: true, allowServices: true }
  });
  equal('status é sucesso', d.status, 'good');
  check('as três capacidades ligadas', d.capabilities.every((c) => c.on === true));
  check('sem dica', !d.hint);
});

group('Diagnóstico: servidor inalcançável é o ÚNICO caso de falha', () => {
  const d = build({
    endpoint: 'https://api.aurexai.com',
    // `endpoint` no probe só é preenchido no ramo de exceção da sonda
    probe: { enabled: false, ready: false, endpoint: 'https://api.aurexai.com',
             reason: 'não consegui falar com https://api.aurexai.com (Failed to fetch)' }
  });

  equal('status é falha', d.status, 'bad');
  equal('a manchete diz que não respondeu', d.headline, 'settings.server.unreachable');
  check('o motivo cita o endereço tentado', /api\.aurexai\.com/.test(d.detail), d.detail);
  check('traz a dica acionável', !!d.hint);
  equal('não lista capacidade nenhuma', d.capabilities.length, 0);

  // Sonda ausente (script não carregou) também é falha, sem quebrar
  const semSonda = build({ endpoint: 'http://x', probe: null });
  equal('sem sonda também é falha', semSonda.status, 'bad');
  equal('e não inventa capacidades', semSonda.capabilities.length, 0);
});

group('Diagnóstico: sandbox LIGADA mas quebrada merece atenção', () => {
  // Este é o único caso em que o operador provavelmente não quis o resultado
  const d = build({
    endpoint: 'http://127.0.0.1:3000',
    probe: { enabled: true, ready: false, allowNetwork: false, allowServices: false,
             reason: 'Imagem "aurex/sandbox:1" não encontrada.' }
  });

  equal('status é aviso, não falha', d.status, 'warn');
  equal('a conexão continua reportada como boa', d.headline, 'settings.server.reachable');
  check('a dica diz o que fazer', /aurex\/sandbox/.test(d.hint), d.hint);
  check('a sandbox aparece desligada', d.capabilities[0].on === false);
});
