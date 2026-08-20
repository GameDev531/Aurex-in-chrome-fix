// Teste da medição de cota do workspace da sandbox.
//
// Regressão real: a mesma varredura servia para LISTAR arquivos (onde esconder
// .cache/.local/node_modules é ruído a menos) e para MEDIR a cota. Como o
// workspace é montado com PYTHONUSERBASE=/work/.local e
// NPM_CONFIG_PREFIX=/work/.npm-global, a medição ignorava exatamente onde o
// disco enche: dava para encher o disco do host com pip install sem nunca
// passar do limite medido.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { check, group, ROOT } = require('./harness');

const workspaceModule = path.join(ROOT, 'server', 'src', 'sandbox', 'workspace.js');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurex-quota-'));
  // Diretórios que a listagem esconde, mas que ocupam disco de verdade
  fs.mkdirSync(path.join(dir, '.local/lib/python3.12/site-packages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules/pacote'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.local/lib/python3.12/site-packages/big.whl'), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(dir, 'node_modules/pacote/bundle.js'), Buffer.alloc(2 * 1024 * 1024));
  fs.writeFileSync(path.join(dir, '.cache/blob.bin'), Buffer.alloc(1024 * 1024));
  fs.writeFileSync(path.join(dir, 'docs/nota.txt'), 'relatorio');
  return dir;
}

group('Cota da sandbox: dependências instaladas contam no limite', async () => {
  const { workspaceUsageBytes, listFiles } = await import(workspaceModule);
  const dir = makeWorkspace();
  try {
    const usage = await workspaceUsageBytes(dir);
    const mb = usage.bytes / 1024 / 1024;

    check('mede os 6 MB instalados em .local, node_modules e .cache',
      mb > 5.9 && mb < 6.1, mb.toFixed(2) + ' MB');
    check('conta os 4 arquivos', usage.files === 4, String(usage.files));
    check('medição completa não vem truncada', usage.truncated === false);

    // O outro lado do contrato: a listagem continua limpa para o usuário
    const listed = await listFiles(dir, {});
    const paths = listed.entries.map((e) => e.path);
    check('listagem mostra o trabalho do usuário', paths.includes('docs/nota.txt'));
    check('listagem esconde node_modules', !paths.some((p) => p.startsWith('node_modules')));
    check('listagem esconde .local', !paths.some((p) => p.startsWith('.local')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

group('Cota da sandbox: symlink não é seguido nem contado', async () => {
  const { workspaceUsageBytes } = await import(workspaceModule);
  const dir = makeWorkspace();
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'aurex-fora-'));
  try {
    fs.writeFileSync(path.join(fora, 'grande.bin'), Buffer.alloc(4 * 1024 * 1024));
    fs.symlinkSync(fora, path.join(dir, 'escape'));

    const usage = await workspaceUsageBytes(dir);
    const mb = usage.bytes / 1024 / 1024;
    check('o conteúdo apontado pelo symlink não entra na conta',
      mb > 5.9 && mb < 6.1, mb.toFixed(2) + ' MB');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fora, { recursive: true, force: true });
  }
});
