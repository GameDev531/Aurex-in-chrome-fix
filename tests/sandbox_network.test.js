// Rede na sandbox: o caminho ponta a ponta.
//
// Regressão real de PRODUTO, não de segurança: o servidor já aceitava
// `network` por execução (routes.js lê body.network) e já publicava
// allow_network no /health, mas a extensão nunca mandava o campo e a
// descrição da ferramenta afirmava ao modelo que "NAO ha acesso a internet
// dentro do container". A capacidade existia ponta a ponta e era
// inalcançável — sem npm install / pip install, o agente não conseguia
// montar um projeto de verdade.
const path = require('node:path');
const { readSource, extractBlock, check, equal, group, ROOT } = require('./harness');

group('Sandbox: o modelo consegue PEDIR rede', () => {
  const src = readSource('popup.js');

  // O parâmetro precisa existir no schema, senão o modelo nunca o emite
  const runCommand = src.slice(src.indexOf('name: "run_command"'), src.indexOf('name: "run_code"'));
  check('run_command expõe o parâmetro network', /network:\s*\{\s*type:\s*"boolean"/.test(runCommand));
  check('a descrição não afirma mais que internet não existe',
    !/NAO ha acesso a internet/.test(runCommand));
  check('a descrição cita o caso de uso real', /npm install|pip install/.test(runCommand));

  const runCode = src.slice(src.indexOf('name: "run_code"'), src.indexOf('name: "sandbox_files"'));
  check('run_code também expõe network', /network:\s*\{\s*type:\s*"boolean"/.test(runCode));
});

group('Sandbox: o campo chega ao servidor', () => {
  const src = readSource('popup.js');
  const dispatch = src.slice(src.indexOf('} else if (name === "run_command")'), src.indexOf('} else if (name === "sandbox_files")'));

  check('run_command repassa network no spec', /network:\s*args\.network === true/.test(dispatch));
  check('run_code repassa network no spec',
    (dispatch.match(/network:\s*args\.network === true/g) || []).length === 2);

  // Coerção explícita: um "network": "sim" vindo do modelo não pode virar true
  check('só o booleano true liga a rede', !/network:\s*args\.network\s*[,}]/.test(dispatch));
});

group('Sandbox: continua sendo opt-in do operador', async () => {
  const { readSandboxConfig } = await import(path.join(ROOT, 'server', 'src', 'sandbox', 'config.js'));
  const antes = process.env.AUREX_SANDBOX_ALLOW_NETWORK;

  delete process.env.AUREX_SANDBOX_ALLOW_NETWORK;
  check('sem a variável, rede desligada', readSandboxConfig().allowNetwork === false);

  process.env.AUREX_SANDBOX_ALLOW_NETWORK = 'false';
  check('"false" mantém desligada', readSandboxConfig().allowNetwork === false);

  process.env.AUREX_SANDBOX_ALLOW_NETWORK = 'true';
  check('só "true" liga', readSandboxConfig().allowNetwork === true);

  if (antes === undefined) delete process.env.AUREX_SANDBOX_ALLOW_NETWORK;
  else process.env.AUREX_SANDBOX_ALLOW_NETWORK = antes;
});

group('Sandbox: pedir rede sem permissão do operador é recusado', async () => {
  const { assertNetworkAllowed } = await import(path.join(ROOT, 'server', 'src', 'sandbox', 'docker.js'));

  let recusou = false;
  let codigo = '';
  try {
    assertNetworkAllowed({ allowNetwork: false }, 'full');
  } catch (err) { recusou = true; codigo = err.code || ''; }
  check('recusa quando o operador não permitiu', recusou);
  equal('com código acionável', codigo, 'network_not_allowed');

  let semRede = false;
  try {
    assertNetworkAllowed({ allowNetwork: false }, 'none');
    semRede = true;
  } catch (err) { /* não deveria */ }
  check('execução sem rede passa normalmente', semRede);

  let comPermissao = false;
  try {
    assertNetworkAllowed({ allowNetwork: true }, 'full');
    comPermissao = true;
  } catch (err) { /* não deveria */ }
  check('com permissão do operador, passa', comPermissao);
});

group('Sandbox: o container só ganha rede quando pedida', () => {
  const docker = readSource('server/src/sandbox/docker.js');
  check("bridge só quando network === 'full'",
    /'--network',\s*network === 'full' \? 'bridge' : 'none'/.test(docker));
});

group('Detector de loop: repetir COM rede não é repetição', () => {
  const src = extractBlock('popup.js', 'function _getToolSignature', 'function _isLoopSensitiveToolCall');
  const scope = {};
  new Function('scope', src + '\nscope.sig = _getToolSignature;')(scope);

  function assinatura(args) {
    return scope.sig({ function: { name: 'run_command', arguments: JSON.stringify(args) } });
  }

  const semRede = assinatura({ command: 'npm install' });
  const comRede = assinatura({ command: 'npm install', network: true });
  check('a tentativa com rede tem assinatura própria', semRede !== comRede, semRede + ' vs ' + comRede);
  equal('e a mesma chamada continua igual a si mesma',
    assinatura({ command: 'npm install' }), semRede);
});
