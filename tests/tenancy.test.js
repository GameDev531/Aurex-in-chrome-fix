// Isolamento de sessões da sandbox entre donos diferentes.
//
// Regressão real: o session_id vem do CLIENTE, e nomes como "default" ou
// "conversa1" colidem entre usuários. A tabela usava id como chave primária
// sozinho, então o segundo usuário sobrescrevia a linha do primeiro. Os
// diretórios sempre estiveram separados por dono (nunca houve leitura cruzada
// de arquivos), mas a expiração passava a ser calculada sobre a sessão errada:
// o workspace de um ficava sem TTL e o do outro era apagado por atividade
// alheia.
const path = require('node:path');
const { check, equal, group, ROOT } = require('./harness');

const dbModule = path.join(ROOT, 'server', 'src', 'db.js');

group('Sandbox: mesmo session_id de donos diferentes não colide', async () => {
  const db = await import(dbModule);
  const agora = Date.now();

  // Ana e Bruno escolhem, cada um por conta própria, a sessão "default"
  await db.touchSandboxSession('default', 'user:ana', agora - 1000);      // já expirada
  await db.touchSandboxSession('default', 'user:bruno', agora + 3600000); // bem viva

  const expiradas = await db.listExpiredSandboxSessions();
  const donos = expiradas.filter((s) => s.id === 'default').map((s) => s.ownerKey);

  equal('só a sessão da Ana aparece como expirada', donos, ['user:ana']);
  check('a sessão do Bruno não é varrida por causa da Ana',
    !donos.includes('user:bruno'));

  // Varrer a da Ana não pode derrubar o registro do Bruno
  await db.deleteSandboxSession('default', 'user:ana');
  await db.touchSandboxSession('default', 'user:bruno', agora - 1000);
  const depois = await db.listExpiredSandboxSessions();
  const restantes = depois.filter((s) => s.id === 'default').map((s) => s.ownerKey);
  equal('após apagar a da Ana, a do Bruno continua registrada', restantes, ['user:bruno']);
});

group('Sandbox: renovar a sessão de um dono não renova a do outro', async () => {
  const db = await import(dbModule);
  const agora = Date.now();

  await db.touchSandboxSession('projeto', 'user:carla', agora - 5000);
  await db.touchSandboxSession('projeto', 'user:diego', agora - 5000);
  // Só Diego continua usando
  await db.touchSandboxSession('projeto', 'user:diego', agora + 3600000);

  const expiradas = (await db.listExpiredSandboxSessions())
    .filter((s) => s.id === 'projeto').map((s) => s.ownerKey);
  equal('a sessão parada da Carla expira normalmente', expiradas, ['user:carla']);
});

group('Sandbox: workspaces de donos diferentes moram em pastas diferentes', async () => {
  const { workspacePathFor } = await import(path.join(ROOT, 'server', 'src', 'sandbox', 'workspace.js'));
  const cfg = { root: '/tmp/aurex-sandbox' };
  const ana = workspacePathFor(cfg, 'user:ana', 'default');
  const bruno = workspacePathFor(cfg, 'user:bruno', 'default');

  check('mesmo session_id gera caminhos distintos', ana !== bruno, ana + ' vs ' + bruno);
  check('nenhum contém o outro', !ana.startsWith(bruno) && !bruno.startsWith(ana));
  check('a chave do dono não vaza no caminho',
    !ana.includes('user:ana') && !bruno.includes('user:bruno'));
});
