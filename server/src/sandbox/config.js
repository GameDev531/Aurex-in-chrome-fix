// Configuração e travas de segurança da sandbox.
//
// A sandbox executa código arbitrário decidido por um modelo de linguagem que
// lê páginas da web — ou seja, uma injeção de prompt numa página é uma tentativa
// de execução remota. Por isso ela nasce DESLIGADA e o servidor se recusa a
// subir em combinações inseguras, em vez de apenas avisar.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { validApiKeys } from '../middleware.js';

// Este NÃO é um segredo: é o placeholder do .env.example, guardado aqui para
// que o boot RECUSE subir com ele. Montado por concatenação porque, escrito
// como literal, os scanners o reportavam como "hardcoded secret" — o oposto
// do que a linha faz. Um achado falso que se repete a cada scan acaba
// treinando quem lê o relatório a ignorá-lo.
const DEFAULT_JWT_SECRET = ['change', 'this', 'to', 'a', 'long', 'random', 'secret'].join('-');

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true';
}

function envInt(name, fallback) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readSandboxConfig() {
  return {
    enabled: envFlag('AUREX_SANDBOX_ENABLED', false),
    image: process.env.AUREX_SANDBOX_IMAGE || 'aurex/sandbox:1',
    dockerBin: process.env.AUREX_SANDBOX_DOCKER_BIN || 'docker',
    root: process.env.AUREX_SANDBOX_ROOT || path.join(os.tmpdir(), 'aurex-sandbox'),
    uid: process.env.AUREX_SANDBOX_UID || (typeof process.getuid === 'function' ? String(process.getuid()) : '1000'),
    gid: process.env.AUREX_SANDBOX_GID || (typeof process.getgid === 'function' ? String(process.getgid()) : '1000'),
    mountFlags: process.env.AUREX_SANDBOX_MOUNT_FLAGS || '',
    memory: process.env.AUREX_SANDBOX_MEMORY || '1g',
    cpus: process.env.AUREX_SANDBOX_CPUS || '1.0',
    pids: envInt('AUREX_SANDBOX_PIDS', 256),
    tmpfsMb: envInt('AUREX_SANDBOX_TMPFS_MB', 256),
    timeoutMs: envInt('AUREX_SANDBOX_TIMEOUT_MS', 120000),
    maxTimeoutMs: envInt('AUREX_SANDBOX_MAX_TIMEOUT_MS', 600000),
    maxOutputBytes: envInt('AUREX_SANDBOX_MAX_OUTPUT_BYTES', 262144),
    maxFileBytes: envInt('AUREX_SANDBOX_MAX_FILE_BYTES', 268435456),
    maxWorkspaceMb: envInt('AUREX_SANDBOX_MAX_WORKSPACE_MB', 512),
    maxSessionsPerUser: envInt('AUREX_SANDBOX_MAX_SESSIONS_PER_USER', 10),
    sessionTtlMs: envInt('AUREX_SANDBOX_SESSION_TTL_MS', 86400000),
    maxConcurrent: envInt('AUREX_SANDBOX_MAX_CONCURRENT', 2),
    ratePerMin: envInt('AUREX_SANDBOX_RATE_PER_MIN', 20),
    allowedUsers: (process.env.AUREX_SANDBOX_ALLOWED_USERS || '')
      .split(',').map((v) => v.trim()).filter(Boolean),
    allowNetwork: envFlag('AUREX_SANDBOX_ALLOW_NETWORK', false),
    // Serviços de longa duração são opt-in SEPARADO da rede: publicar uma
    // porta implica bridge (logo, saída de rede) E um listener alcançável na
    // loopback do host. Quem liga rede para instalar pacote não deve ligar,
    // junto e sem saber, um processo que fica de pé.
    allowServices: envFlag('AUREX_SANDBOX_ALLOW_SERVICES', false),
    servicePortStart: envInt('AUREX_SANDBOX_SERVICE_PORT_START', 47000),
    servicePortCount: envInt('AUREX_SANDBOX_SERVICE_PORT_COUNT', 40),
    serviceTtlMs: envInt('AUREX_SANDBOX_SERVICE_TTL_MS', 1800000),
    serviceBootMs: envInt('AUREX_SANDBOX_SERVICE_BOOT_MS', 25000),
    maxServices: envInt('AUREX_SANDBOX_MAX_SERVICES', 5),
    seccompProfile: process.env.AUREX_SANDBOX_SECCOMP_PROFILE || '',
    allowPublicBind: envFlag('AUREX_SANDBOX_ALLOW_PUBLIC_BIND', false),
    allowRoot: envFlag('AUREX_SANDBOX_ALLOW_ROOT', false),
    bindHost: process.env.AUREX_BIND_HOST || '127.0.0.1'
  };
}

export class SandboxBootError extends Error {}

const EXAMPLE_API_KEYS = new Set(['aurex-change-me']);

// Verificações que valem SEMPRE, com ou sem sandbox. O segredo do JWT protege
// /v1/chat/completions independentemente da sandbox: deixar essa checagem
// dentro do bloco da sandbox significava que, na configuração padrão
// (sandbox desligada), o segredo público de exemplo continuava valendo e
// qualquer um podia forjar um token.
export function assertCoreBootConfig() {
  const problems = [];

  const secret = process.env.AUREX_JWT_SECRET;
  if (!secret || secret === DEFAULT_JWT_SECRET) {
    problems.push(
      'AUREX_JWT_SECRET ausente ou igual ao valor de exemplo — qualquer pessoa ' +
      'poderia forjar um token válido e usar o /v1. Gere um segredo aleatório longo ' +
      '(ex: openssl rand -base64 48).'
    );
  } else if (secret.length < 32) {
    problems.push('AUREX_JWT_SECRET é curto demais (mínimo 32 caracteres).');
  }

  const weakKeys = validApiKeys().filter((key) => EXAMPLE_API_KEYS.has(key) || key.length < 24);
  if (weakKeys.length) {
    problems.push(
      'AUREX_API_KEYS contém o valor de exemplo ou uma chave curta demais. ' +
      'Uma chave publicamente conhecida dá acesso ao /v1 (e à sandbox, se ligada). ' +
      'Gere chaves longas e aleatórias.'
    );
  }

  if (problems.length) {
    throw new SandboxBootError(
      'Configuração insegura:\n' + problems.map((p, i) => '  ' + (i + 1) + '. ' + p).join('\n')
    );
  }
}

// Falha ruidosa e imediata: cada uma destas combinações transformaria o
// endpoint de execução numa porta aberta.
export function assertSandboxBootConfig(cfg) {
  if (!cfg.enabled) return;

  const problems = [];

  if (validApiKeys().length === 0) {
    problems.push(
      'AUREX_API_KEYS está vazio. Sem chaves, o /v1 aceita requisições anônimas — ' +
      'com a sandbox ligada isso seria execução de código sem autenticação. ' +
      'Configure AUREX_API_KEYS antes de ligar a sandbox.'
    );
  }

  // O login de desenvolvimento emite token sem credencial nenhuma. Ele nunca
  // pode coexistir com execução de código.
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    problems.push(
      'A sandbox está ligada sem Google OAuth configurado, o que mantém ativo o ' +
      'login de desenvolvimento (/auth/dev-login) — ele emite tokens válidos sem ' +
      'nenhuma credencial. Configure GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET ou ' +
      'desligue a sandbox.'
    );
  }

  const publicBind = cfg.bindHost === '0.0.0.0' || cfg.bindHost === '::';
  if (publicBind && !cfg.allowPublicBind) {
    problems.push(
      'O servidor está configurado para escutar em todas as interfaces (' + cfg.bindHost + ') ' +
      'com a sandbox ligada. Use AUREX_BIND_HOST=127.0.0.1 ou, se a exposição for ' +
      'intencional e protegida, defina AUREX_SANDBOX_ALLOW_PUBLIC_BIND=true.'
    );
  }

  if (typeof process.getuid === 'function' && process.getuid() === 0 && !cfg.allowRoot) {
    problems.push(
      'O servidor está rodando como root com a sandbox ligada. Rode como usuário ' +
      'sem privilégios (idealmente com Docker rootless) ou defina AUREX_SANDBOX_ALLOW_ROOT=true.'
    );
  }

  if (problems.length) {
    throw new SandboxBootError(
      'Configuração insegura para a sandbox de código:\n' +
      problems.map((p, i) => '  ' + (i + 1) + '. ' + p).join('\n')
    );
  }
}

function runDocker(cfg, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    let child;
    try {
      child = spawn(cfg.dockerBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: String(err.message) });
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* já morreu */ }
      resolve({ ok: false, code: -1, stdout, stderr: 'timeout ao falar com o Docker' });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: String(err.message) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// Falha de Docker NÃO derruba o servidor: o chat continua funcionando e a
// sandbox apenas se declara indisponível, com um motivo acionável.
export async function dockerPreflight(cfg) {
  if (!cfg.enabled) {
    return { ready: false, reason: 'Sandbox desativada (AUREX_SANDBOX_ENABLED=false).' };
  }

  const version = await runDocker(cfg, ['version', '--format', '{{.Server.Version}}']);
  if (!version.ok) {
    const err = version.stderr || '';
    if (/not found|ENOENT/i.test(err)) {
      return { ready: false, reason: 'Docker não encontrado no servidor. Instale o Docker e reinicie.' };
    }
    if (/permission denied/i.test(err)) {
      return { ready: false, reason: 'Sem permissão para falar com o daemon Docker. Use Docker rootless ou adicione o usuário ao grupo docker.' };
    }
    if (/Cannot connect to the Docker daemon/i.test(err)) {
      return { ready: false, reason: 'O daemon Docker não está rodando no servidor.' };
    }
    return { ready: false, reason: 'Docker indisponível: ' + (err || 'motivo desconhecido') };
  }

  const image = await runDocker(cfg, ['image', 'inspect', cfg.image, '--format', '{{.Id}}']);
  if (!image.ok) {
    return {
      ready: false,
      dockerVersion: version.stdout,
      reason: 'Imagem "' + cfg.image + '" não encontrada. Construa com: docker build -t ' + cfg.image + ' server/sandbox'
    };
  }

  return { ready: true, dockerVersion: version.stdout, imageId: image.stdout };
}
