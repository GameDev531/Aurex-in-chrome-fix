// Execução isolada em container.
//
// Regra inegociável: o comando do usuário viaja como UM elemento de argv,
// nunca interpolado numa string de shell do host. Assim, injeção de shell
// no host é estruturalmente impossível — o pior que o texto pode fazer é
// ser um comando ruim DENTRO do container descartável.
import { spawn } from 'node:child_process';
import { sandboxError } from './errors.js';

// Guarda cabeça e cauda da saída: em log de build a cauda é o que importa
// (o erro final), em `ls` a cabeça. Manter os dois cobre os dois casos.
class OutputCollector {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.head = [];
    this.headBytes = 0;
    this.tail = [];
    this.tailBytes = 0;
    this.totalBytes = 0;
    this.truncated = false;
  }

  push(chunk) {
    const text = chunk.toString('utf8');
    this.totalBytes += Buffer.byteLength(text, 'utf8');
    const half = Math.floor(this.maxBytes / 2);

    if (this.headBytes < half) {
      this.head.push(text);
      this.headBytes += Buffer.byteLength(text, 'utf8');
      return;
    }
    this.tail.push(text);
    this.tailBytes += Buffer.byteLength(text, 'utf8');
    while (this.tailBytes > half && this.tail.length > 1) {
      const removed = this.tail.shift();
      this.tailBytes -= Buffer.byteLength(removed, 'utf8');
      this.truncated = true;
    }
  }

  value() {
    if (!this.truncated) return this.head.join('') + this.tail.join('');
    const omitted = this.totalBytes - this.headBytes - this.tailBytes;
    return this.head.join('') +
      '\n... [' + omitted + ' bytes omitidos no meio da saida] ...\n' +
      this.tail.join('');
  }
}

function runDockerCommand(cfg, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cfg.dockerBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, stdout: '', stderr: String(err.message) });
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ok */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: String(err.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

export async function killContainer(cfg, containerName) {
  await runDockerCommand(cfg, ['kill', '--signal=SIGKILL', containerName], 8000);
}

export async function removeContainer(cfg, containerName) {
  await runDockerCommand(cfg, ['rm', '-f', containerName], 8000);
}

// Containers órfãos de um crash anterior. Roda no boot.
export async function sweepOrphanContainers(cfg) {
  const listed = await runDockerCommand(cfg, ['ps', '-aq', '--filter', 'label=aurex.sandbox=1']);
  if (!listed.ok || !listed.stdout) return 0;
  const ids = listed.stdout.split('\n').map((v) => v.trim()).filter(Boolean);
  for (const id of ids) {
    await runDockerCommand(cfg, ['rm', '-f', id]);
  }
  return ids.length;
}

function buildDockerArgs({ cfg, containerName, sessionId, workspaceDir, argv, timeoutMs, network, env }) {
  const args = [
    'run',
    '--name', containerName,
    '--label', 'aurex.sandbox=1',
    '--label', 'aurex.session=' + sessionId,
    '--interactive',
    // Sem rede por padrão: o container lê conteúdo que veio de páginas web,
    // então dar saída de rede a ele é dar um canal de exfiltração.
    '--network', network === 'full' ? 'bridge' : 'none',
    '--user', cfg.uid + ':' + cfg.gid,
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=' + cfg.tmpfsMb + 'm',
    '--tmpfs', '/run:rw,noexec,nosuid,nodev,size=8m',
    '--mount', 'type=bind,source=' + workspaceDir + ',target=/work' + (cfg.mountFlags || ''),
    '--workdir', '/work',
    '--memory', cfg.memory,
    '--memory-swap', cfg.memory, // igual => sem swap, evita escapar do limite
    '--cpus', String(cfg.cpus),
    '--pids-limit', String(cfg.pids), // mata fork bomb
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--ulimit', 'nofile=1024:2048',
    '--ulimit', 'core=0',
    '--ulimit', 'fsize=' + cfg.maxFileBytes,
    '--cgroupns', 'private',
    '--ipc', 'private'
  ];

  if (cfg.seccompProfile) {
    args.push('--security-opt', 'seccomp=' + cfg.seccompProfile);
  }

  // Ambiente que faz pip/npm instalarem DENTRO do workspace montado —
  // sem isso, "pip install X" e depois "python usa X" não funciona, porque
  // o container é descartado entre as duas execuções.
  const baseEnv = {
    HOME: '/work/.home',
    TMPDIR: '/tmp',
    XDG_CACHE_HOME: '/work/.cache',
    PYTHONUSERBASE: '/work/.local',
    PIP_USER: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    NPM_CONFIG_PREFIX: '/work/.npm-global',
    NODE_PATH: '/work/.npm-global/lib/node_modules:/usr/lib/node_modules',
    PATH: '/work/.local/bin:/work/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
    MPLBACKEND: 'Agg',
    MPLCONFIGDIR: '/work/.cache/matplotlib',
    LANG: 'C.UTF-8'
  };
  Object.assign(baseEnv, env || {});
  Object.keys(baseEnv).forEach((key) => {
    args.push('--env', key + '=' + baseEnv[key]);
  });

  args.push(cfg.image);
  // Timeout também DENTRO do container: se o host perder o processo, o
  // container ainda se mata sozinho.
  args.push('timeout', '--signal=KILL', String(Math.ceil(timeoutMs / 1000)));
  argv.forEach((part) => args.push(part));

  return args;
}

export async function runInContainer(options) {
  const { cfg, containerName, timeoutMs } = options;
  const args = buildDockerArgs(options);

  const stdout = new OutputCollector(cfg.maxOutputBytes);
  const stderr = new OutputCollector(cfg.maxOutputBytes);
  const startedAt = Date.now();

  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(cfg.dockerBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ exitCode: -1, dockerFailure: String(err.message) });
    }

    let hostTimer = setTimeout(async () => {
      // O timeout interno já deveria ter agido; isto é a rede de segurança
      await killContainer(cfg, containerName);
      try { child.kill('SIGKILL'); } catch { /* já morreu */ }
    }, timeoutMs + 5000);

    if (options.stdin) {
      try { child.stdin.write(options.stdin); } catch { /* pipe fechado */ }
    }
    try { child.stdin.end(); } catch { /* ok */ }

    // Continuar drenando os pipes é obrigatório: se pararmos de ler, o
    // container bloqueia num pipe cheio e só morre no timeout.
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    child.on('error', (err) => {
      clearTimeout(hostTimer);
      resolve({ exitCode: -1, dockerFailure: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(hostTimer);
      resolve({ exitCode: code === null ? -1 : code });
    });
  });

  // Distinguir OOM de timeout exige inspecionar ANTES de remover — os dois
  // saem como 137. É por isso que não usamos --rm.
  let oomKilled = false;
  let inspectedExit = null;
  const inspect = await runDockerCommand(cfg, [
    'inspect', containerName, '--format', '{{.State.OOMKilled}} {{.State.ExitCode}}'
  ]);
  if (inspect.ok && inspect.stdout) {
    const parts = inspect.stdout.split(/\s+/);
    oomKilled = parts[0] === 'true';
    const parsed = parseInt(parts[1], 10);
    if (Number.isFinite(parsed)) inspectedExit = parsed;
  }
  await removeContainer(cfg, containerName);

  const exitCode = result.dockerFailure ? -1 : (inspectedExit !== null ? inspectedExit : result.exitCode);
  const durationMs = Date.now() - startedAt;
  const timedOut = !oomKilled && (exitCode === 137 || durationMs >= timeoutMs);

  return {
    exitCode,
    timedOut,
    oomKilled,
    dockerFailure: result.dockerFailure || null,
    stdout: stdout.value(),
    stderr: stderr.value(),
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    durationMs
  };
}

// Traduz falhas em orientação acionável. Sem isto, "exit 127" parece bug do
// programa quando na verdade é um binário que não existe na imagem.
export function buildHint(run, context) {
  const stderr = run.stderr || '';

  if (run.dockerFailure) {
    return 'Falha ao iniciar o container: ' + run.dockerFailure + '. O Docker pode estar indisponível no servidor.';
  }
  if (run.oomKilled) {
    return 'O processo estourou o limite de memoria (' + context.memory + '). Processe o arquivo em partes ou use menos dados na memoria.';
  }
  if (run.timedOut) {
    return 'A execucao passou do tempo limite. Aumente timeout_ms (respeitando o maximo do servidor) ou divida a tarefa em etapas menores.';
  }
  if (context.network !== 'full' &&
      /Temporary failure in name resolution|Network is unreachable|Failed to establish a new connection|getaddrinfo|ENOTFOUND|ETIMEDOUT|Could not resolve host/i.test(stderr)) {
    return context.allowNetwork
      ? 'A sandbox esta sem rede nesta execucao. Se realmente precisar baixar pacotes, execute de novo com network=true.'
      : 'A sandbox nao tem acesso a internet (por seguranca). Use as bibliotecas ja instaladas: python-docx, openpyxl, python-pptx, reportlab, pypdf, pandas, matplotlib, Pillow.';
  }
  if (run.exitCode === 127) {
    return 'Comando nao encontrado na imagem. Use os interpretadores disponiveis (python3, node, bash) ou uma biblioteca ja instalada.';
  }
  if (run.exitCode === 126) {
    return 'O arquivo existe mas nao e executavel. Rode via interpretador, por exemplo: python3 script.py.';
  }
  if (run.exitCode === 125) {
    return 'O proprio Docker falhou ao criar o container. Verifique a configuracao da sandbox no servidor.';
  }
  if (context.artifactCount > 0) {
    return 'Arquivo(s) gerado(s) no workspace. Use sandbox_files com command="deliver" para entregar ao usuario.';
  }
  return null;
}

export function assertNetworkAllowed(cfg, network) {
  if (network === 'full' && !cfg.allowNetwork) {
    throw sandboxError('network_not_allowed',
      'Acesso a rede está desativado nesta sandbox (AUREX_SANDBOX_ALLOW_NETWORK=false). Use as bibliotecas já instaladas na imagem.');
  }
}
