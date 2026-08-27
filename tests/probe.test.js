// Sonda de disponibilidade da sandbox.
//
// Regressão real, relatada pelo usuário: ele subiu o servidor DEPOIS de abrir
// o Aurex e o agente continuou dizendo que a sandbox não existia — pior, disse
// "testei e confirmei" sem nunca ter chamado a ferramenta.
//
// A causa eram duas coisas somadas: probe() rodava uma única vez ao abrir o
// painel, e o resultado NEGATIVO era cacheado pelos mesmos 60s de um positivo.
// Como a diretiva mandava o modelo não chamar as ferramentas, exec() nunca
// rodava, probe() nunca era refeita e o estado errado se sustentava sozinho.
const http = require('node:http');
const { readSource, check, equal, group } = require('./harness');

const PORT = 47317;

function loadClient(apiBase) {
  const src = readSource('sandbox_client.js');
  const body = src.slice(src.indexOf('var AurexSandbox'), src.indexOf('// A sandbox pode produzir bytes'));
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const factory = new Function(
    'localStorage', 'getAurexApiBase', 'fetch', 'chrome', 'URL', 'sanitizeArtifactFilename',
    body + '\nreturn AurexSandbox;'
  );
  return factory(localStorage, () => apiBase, globalThis.fetch, { downloads: {} }, URL, (n) => n);
}

function startServer(payload, port) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

group('Sonda: servidor que sobe DEPOIS é reconhecido', async () => {
  const api = 'http://127.0.0.1:' + PORT + '/v1';
  const client = loadClient(api);

  // 1. Servidor ainda não está de pé
  let probe = await client.probe();
  equal('começa indisponível', probe.ready, false);
  check('o motivo diz PARA ONDE tentou falar', probe.reason.includes('127.0.0.1:' + PORT), probe.reason);
  check('e expõe o endpoint para a UI', probe.endpoint === 'http://127.0.0.1:' + PORT, probe.endpoint);

  // 2. O usuário sobe o servidor agora
  const server = await startServer({
    ok: true,
    sandbox: { enabled: true, ready: true, allow_network: true, allow_services: false }
  }, PORT);

  try {
    // 3. force=true reconhece imediatamente
    probe = await client.probe(true);
    equal('com force, reconhece na hora', probe.ready, true);
    equal('lê a permissão de rede', probe.allowNetwork, true);
    equal('lê a permissão de serviços', probe.allowServices, false);

    // 4. O positivo agora é cacheado (não bate no servidor a cada mensagem)
    const cached = await client.probe();
    equal('positivo é reaproveitado do cache', cached.ready, true);
  } finally {
    server.close();
  }
});

group('Sonda: resultado negativo não é cacheado como positivo', async () => {
  const api = 'http://127.0.0.1:' + (PORT + 1) + '/v1';
  const client = loadClient(api);

  const primeira = await client.probe();
  equal('falhou', primeira.ready, false);

  // O TTL de falha é curto de propósito: um /health que não responde é barato
  // de repetir, e cacheá-lo por um minuto é o que travava o usuário.
  await new Promise((r) => setTimeout(r, 3200));

  const server = await startServer({ ok: true, sandbox: { enabled: true, ready: true } }, PORT + 1);
  try {
    const segunda = await client.probe(); // SEM force
    equal('depois do TTL curto, resonda sozinha', segunda.ready, true);
  } finally {
    server.close();
  }
});

group('Sonda: sandbox desligada é diferente de servidor fora do ar', async () => {
  const api = 'http://127.0.0.1:' + (PORT + 2) + '/v1';
  const client = loadClient(api);

  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, sandbox: { enabled: false, ready: false } }));
    });
    s.listen(PORT + 2, '127.0.0.1', () => resolve(s));
  });

  try {
    const probe = await client.probe(true);
    equal('servidor respondeu, então não é "inacessível"', probe.enabled, false);
    equal('não está pronta', probe.ready, false);
    check('o motivo aponta a configuração, não a rede',
      /desativada/i.test(probe.reason), probe.reason);
    check('sem endpoint de erro (o servidor respondeu)', probe.endpoint === undefined);
  } finally {
    server.close();
  }
});
