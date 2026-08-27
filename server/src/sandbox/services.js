// Processos de longa duração na sandbox — servidor de preview, watcher, API
// local que o agente sobe para conferir o que construiu.
//
// Por que isso não cabe no /exec: aquele caminho roda até terminar e devolve a
// saída. Um `npm run preview` nunca termina — ele só bateria no timeout. Aqui o
// container sobe DESTACADO, publica uma porta e continua de pé até alguém
// derrubá-lo ou o TTL expirar.
//
// O que muda no modelo de risco, dito sem rodeio:
//  - publicar porta exige rede bridge; `--network none` não publica nada. Então
//    um serviço TAMBÉM ganha saída de rede, não só entrada.
//  - a porta fica exposta na loopback do HOST do servidor. Qualquer processo
//    naquela máquina alcança o que o container está servindo.
// Por isso é um opt-in separado do `allowNetwork`: quem liga rede para instalar
// pacote não liga, junto e sem saber, um listener de longa duração.
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { sandboxError } from './errors.js';

// Estado em memória. Sobreviver a restart não é requisito: os containers levam
// label aurex.sandbox=1 e o sweeper de boot remove os órfãos.
const services = new Map();

function serviceKey(ownerKey, sessionId) {
  return ownerKey + '\u0000' + sessionId;
}

function runDocker(cfg, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cfg.dockerBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, stdout: '', stderr: String(err.message) });
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* já morreu */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: String(err.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

// Porta livre dentro da faixa configurada. Testamos ligando de verdade em vez
// de confiar num contador: outro processo da máquina pode ter pegado a porta.
function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function allocatePort(cfg) {
  const taken = new Set(Array.from(services.values()).map((s) => s.hostPort));
  for (let i = 0; i < cfg.servicePortCount; i++) {
    const port = cfg.servicePortStart + i;
    if (taken.has(port)) continue;
    if (await probePort(port)) return port;
  }
  throw sandboxError('no_port_available',
    'Nenhuma porta livre na faixa reservada para serviços (' + cfg.servicePortStart +
    '-' + (cfg.servicePortStart + cfg.servicePortCount - 1) + '). Pare um serviço antes de subir outro.');
}

export function assertServicesAllowed(cfg) {
  if (!cfg.allowServices) {
    throw sandboxError('services_not_allowed',
      'Processos de longa duração estão desligados neste servidor. O operador precisa definir ' +
      'AUREX_SANDBOX_ALLOW_SERVICES=true — isso publica uma porta na loopback do host e dá rede ao container.');
  }
}

// Espera a porta começar a responder. É a diferença entre "mandei subir" e
// "está de pé": sem isto o agente navegaria para uma página que ainda não existe.
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.setTimeout(1500);
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));
    });
    if (alive) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function baseEnvFor(port) {
  return {
    HOME: '/work/.home',
    TMPDIR: '/tmp',
    XDG_CACHE_HOME: '/work/.cache',
    PYTHONUSERBASE: '/work/.local',
    PIP_USER: '1',
    PYTHONUNBUFFERED: '1',
    NPM_CONFIG_PREFIX: '/work/.npm-global',
    NODE_PATH: '/work/.npm-global/lib/node_modules:/usr/lib/node_modules',
    PATH: '/work/.local/bin:/work/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    // Convenções que a maioria dos dev servers respeita, para o processo
    // escutar na porta certa e em 0.0.0.0 DENTRO do container (senão ele fica
    // preso no loopback do container e a publicação não alcança nada).
    PORT: String(port),
    HOST: '0.0.0.0'
  };
}

export async function startService(options) {
  const { cfg, ownerKey, sessionId, workspaceDir, command, port } = options;
  assertServicesAllowed(cfg);

  if (services.size >= cfg.maxServices && !services.has(serviceKey(ownerKey, sessionId))) {
    throw sandboxError('too_many_services',
      'O servidor já está com ' + services.size + ' serviço(s) de pé (limite ' + cfg.maxServices + ').');
  }

  // Um serviço por conversa: subir outro derruba o anterior, senão a cada
  // tentativa do agente sobraria um container pendurado.
  await stopService({ cfg, ownerKey, sessionId });

  const containerPort = parseInt(port, 10) || 4173;
  if (!(containerPort > 0 && containerPort < 65536)) {
    throw sandboxError('invalid_request', 'Porta inválida: ' + port);
  }

  const hostPort = await allocatePort(cfg);
  const containerName = 'aurex-svc-' + crypto.randomBytes(8).toString('hex');
  const env = baseEnvFor(containerPort);

  const args = [
    'run', '--detach',
    '--name', containerName,
    '--label', 'aurex.sandbox=1',
    '--label', 'aurex.service=1',
    '--label', 'aurex.session=' + sessionId,
    // Publicar exige bridge; `none` não publica. Fica SEMPRE preso à loopback
    // do host — nunca 0.0.0.0, que exporia o serviço para a rede da máquina.
    '--network', 'bridge',
    '--publish', '127.0.0.1:' + hostPort + ':' + containerPort,
    '--user', cfg.uid + ':' + cfg.gid,
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=' + cfg.tmpfsMb + 'm',
    '--tmpfs', '/run:rw,noexec,nosuid,nodev,size=8m',
    '--mount', 'type=bind,source=' + workspaceDir + ',target=/work' + (cfg.mountFlags || ''),
    '--workdir', '/work',
    '--memory', cfg.memory,
    '--memory-swap', cfg.memory,
    '--cpus', String(cfg.cpus),
    '--pids-limit', String(cfg.pids),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--ulimit', 'nofile=1024:2048',
    '--ulimit', 'core=0',
    '--cgroupns', 'private',
    '--ipc', 'private'
  ];

  if (cfg.seccompProfile) args.push('--security-opt', 'seccomp=' + cfg.seccompProfile);
  Object.keys(env).forEach((key) => args.push('--env', key + '=' + env[key]));

  args.push(cfg.image);
  // Teto de vida DENTRO do container: se o host perder o registro do serviço,
  // ele ainda se mata sozinho em vez de virar container eterno.
  args.push('timeout', '--signal=KILL', String(Math.ceil(cfg.serviceTtlMs / 1000)));
  args.push('bash', '-lc', String(command));

  const started = await runDocker(cfg, args, 20000);
  if (!started.ok) {
    return {
      running: false,
      error: 'Nao consegui subir o servico: ' + (started.stderr || 'motivo desconhecido')
    };
  }

  const entry = {
    containerName,
    hostPort,
    containerPort,
    command: String(command),
    sessionId,
    ownerKey,
    startedAt: Date.now(),
    expiresAt: Date.now() + cfg.serviceTtlMs
  };
  services.set(serviceKey(ownerKey, sessionId), entry);

  const responded = await waitForPort(hostPort, Math.min(cfg.serviceBootMs, 60000));
  const logs = await serviceLogs({ cfg, ownerKey, sessionId, tail: 40 });

  if (!responded) {
    // Não derrubamos: um build lento ainda pode subir, e os logs dizem se
    // travou de vez. Mas relatamos a verdade em vez de fingir sucesso.
    return {
      running: true,
      responding: false,
      url: 'http://127.0.0.1:' + hostPort,
      host_port: hostPort,
      container_port: containerPort,
      logs: logs.logs,
      hint: 'O container subiu mas a porta ' + containerPort + ' ainda nao respondeu. ' +
        'Confira nos logs se o processo escutou em 0.0.0.0:' + containerPort +
        ' (localhost dentro do container nao alcanca a publicacao) e consulte de novo em alguns segundos.'
    };
  }

  return {
    running: true,
    responding: true,
    url: 'http://127.0.0.1:' + hostPort,
    host_port: hostPort,
    container_port: containerPort,
    expires_in_ms: cfg.serviceTtlMs,
    logs: logs.logs
  };
}

export async function serviceLogs({ cfg, ownerKey, sessionId, tail }) {
  const entry = services.get(serviceKey(ownerKey, sessionId));
  if (!entry) return { running: false, logs: '' };

  const lines = Math.min(parseInt(tail, 10) || 60, 400);
  const res = await runDocker(cfg, ['logs', '--tail', String(lines), entry.containerName], 8000);
  // docker logs manda stdout e stderr em fluxos separados; o dev server
  // costuma escrever a URL no stderr, então juntamos os dois.
  const text = [res.stdout, res.stderr].filter(Boolean).join('\n').slice(-16000);
  return { running: true, logs: text };
}

export async function serviceStatus({ cfg, ownerKey, sessionId }) {
  const entry = services.get(serviceKey(ownerKey, sessionId));
  if (!entry) return { running: false };

  const inspect = await runDocker(cfg, ['inspect', '--format', '{{.State.Running}}', entry.containerName], 8000);
  const alive = inspect.ok && inspect.stdout.trim() === 'true';
  if (!alive) {
    // Morreu por conta própria (crash, OOM, fim do timeout). Os logs são a
    // informação útil aqui, então buscamos ANTES de esquecer o container.
    const logs = await runDocker(cfg, ['logs', '--tail', '80', entry.containerName], 8000);
    await runDocker(cfg, ['rm', '-f', entry.containerName], 8000);
    services.delete(serviceKey(ownerKey, sessionId));
    return {
      running: false,
      exited: true,
      logs: [logs.stdout, logs.stderr].filter(Boolean).join('\n').slice(-16000),
      hint: 'O processo terminou sozinho. Leia os logs acima: normalmente e erro de build ou porta ja em uso.'
    };
  }

  const logs = await serviceLogs({ cfg, ownerKey, sessionId, tail: 40 });
  return {
    running: true,
    responding: await waitForPort(entry.hostPort, 2000),
    url: 'http://127.0.0.1:' + entry.hostPort,
    host_port: entry.hostPort,
    container_port: entry.containerPort,
    command: entry.command,
    uptime_ms: Date.now() - entry.startedAt,
    expires_in_ms: Math.max(0, entry.expiresAt - Date.now()),
    logs: logs.logs
  };
}

export async function stopService({ cfg, ownerKey, sessionId }) {
  const key = serviceKey(ownerKey, sessionId);
  const entry = services.get(key);
  if (!entry) return { stopped: false };
  await runDocker(cfg, ['rm', '-f', entry.containerName], 10000);
  services.delete(key);
  return { stopped: true, host_port: entry.hostPort };
}

// Chamado pelo sweeper: derruba o que passou do TTL mesmo que ninguém peça.
export async function sweepExpiredServices(cfg) {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of Array.from(services.entries())) {
    if (entry.expiresAt > now) continue;
    await runDocker(cfg, ['rm', '-f', entry.containerName], 10000);
    services.delete(key);
    removed++;
  }
  return removed;
}

// Derruba todos os serviços de um dono/sessão — usado quando o workspace é
// destruído, senão sobraria um container montando um diretório que sumiu.
export async function stopServicesForSession(cfg, ownerKey, sessionId) {
  return stopService({ cfg, ownerKey, sessionId });
}

export function serviceCount() {
  return services.size;
}
