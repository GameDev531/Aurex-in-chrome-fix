// Workspace de cada sessão: o diretório persistente que é montado em /work
// dentro do container. O container é descartável; este diretório não.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sandboxError } from './errors.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

// Diretórios de apoio que precisam existir ANTES do primeiro comando: com
// rootfs read-only, pip e npm falham se não tiverem onde escrever.
const SUPPORT_DIRS = ['.home', '.local', '.cache', '.cache/matplotlib', '.npm-global', '.aurex'];

// Não contam como artefato produzido pelo usuário
const IGNORED_PREFIXES = ['.home/', '.local/', '.cache/', '.npm-global/', '.aurex/', '.git/', 'node_modules/', '__pycache__/'];

// Sobe até achar um diretório que exista e exige que o caminho REAL dele
// esteja dentro do workspace. É o que impede criar arquivo através de um
// diretório que é symlink para fora.
async function assertNearestAncestorInside(workspaceDir, abs) {
  const realRoot = await fs.realpath(workspaceDir);
  let probe = path.dirname(abs);
  for (let depth = 0; depth < 64; depth++) {
    let realProbe;
    try {
      realProbe = await fs.realpath(probe);
    } catch {
      const up = path.dirname(probe);
      if (up === probe) break; // chegou na raiz sem encontrar nada existente
      probe = up;
      continue;
    }
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
      throw sandboxError('invalid_path', 'O caminho escapa do workspace por link simbólico.');
    }
    return;
  }
  throw sandboxError('invalid_path', 'Não foi possível validar o caminho dentro do workspace.');
}

export function assertValidSessionId(sessionId) {
  if (!SESSION_ID_PATTERN.test(String(sessionId || ''))) {
    throw sandboxError('invalid_request', 'session_id inválido (use 6 a 64 caracteres: letras, números, _ ou -).');
  }
  return sessionId;
}

function ownerDir(root, ownerKey) {
  const hash = crypto.createHash('sha256').update(ownerKey).digest('hex').slice(0, 16);
  return path.join(root, hash);
}

export function workspacePathFor(cfg, ownerKey, sessionId) {
  assertValidSessionId(sessionId);
  return path.join(ownerDir(cfg.root, ownerKey), sessionId);
}

export async function ensureWorkspace(cfg, ownerKey, sessionId) {
  const dir = workspacePathFor(cfg, ownerKey, sessionId);
  let created = false;
  try {
    await fs.access(dir);
  } catch {
    created = true;
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o770 });
  for (const sub of SUPPORT_DIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: true, mode: 0o770 });
  }
  return { dir, created };
}

// Resolve um caminho relativo garantindo que ele fica DENTRO do workspace.
//
// A armadilha aqui: código rodando no sandbox pode criar um symlink
// (/work/relatorio.docx -> /etc/shadow). O container não consegue segui-lo,
// mas o SERVIDOR conseguiria ao servir o download. Por isso usamos lstat
// (nunca stat) e recusamos symlinks explicitamente.
export async function resolveInWorkspace(workspaceDir, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) {
    throw sandboxError('invalid_path', 'Caminho inválido.');
  }
  if (path.isAbsolute(relPath)) {
    throw sandboxError('invalid_path', 'Use caminho relativo ao workspace, não absoluto.');
  }

  const abs = path.resolve(workspaceDir, relPath);
  const rel = path.relative(workspaceDir, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw sandboxError('invalid_path', 'O caminho aponta para fora do workspace.');
  }

  let stat = null;
  try {
    stat = await fs.lstat(abs);
  } catch {
    // O alvo ainda não existe — caso de CRIAÇÃO. Sair daqui sem verificar
    // containment era um escape real: bastava o container criar
    // /work/evil -> /home/user/.ssh e pedir a escrita de "evil/authorized_keys"
    // para o SERVIDOR gravar fora do workspace. Verificamos o ancestral
    // existente mais próximo antes de liberar.
    await assertNearestAncestorInside(workspaceDir, abs);
    return { abs, rel, stat: null };
  }

  if (stat.isSymbolicLink()) {
    throw sandboxError('invalid_path', 'Symlinks não são servidos pela sandbox.');
  }

  // Defesa adicional: um diretório intermediário pode ser symlink
  const realRoot = await fs.realpath(workspaceDir);
  const realAbs = await fs.realpath(abs);
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    throw sandboxError('invalid_path', 'O caminho escapa do workspace por link simbólico.');
  }

  return { abs, rel, stat };
}

function isIgnored(relPath) {
  return IGNORED_PREFIXES.some((prefix) => relPath === prefix.slice(0, -1) || relPath.startsWith(prefix));
}

// `countAll` separa duas necessidades que estavam misturadas: LISTAR para o
// usuário (esconder .cache, node_modules e afins é ruído a menos) e MEDIR a
// cota (que precisa contar tudo). Usar a mesma varredura para as duas coisas
// deixava a cota cega justamente onde o disco enche: PYTHONUSERBASE aponta
// para /work/.local e NPM_CONFIG_PREFIX para /work/.npm-global, os dois na
// lista de ignorados — dava para encher o disco do host com pip install sem
// nunca passar do limite medido.
async function walk(dir, baseDir, depth, limit, out, countAll = false) {
  if (out.entries.length >= limit || depth < 0) {
    if (depth < 0) out.truncated = true;
    return;
  }
  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Diretório ilegível conta como medida incompleta, não como vazio
    out.truncated = true;
    return;
  }
  for (const item of items) {
    if (out.entries.length >= limit) { out.truncated = true; return; }
    if (item.isSymbolicLink()) continue; // nunca descemos em symlink
    const abs = path.join(dir, item.name);
    const rel = path.relative(baseDir, abs);
    if (!countAll && isIgnored(rel)) continue;

    if (item.isDirectory()) {
      out.entries.push({ path: rel, type: 'dir' });
      await walk(abs, baseDir, depth - 1, limit, out, countAll);
    } else if (item.isFile()) {
      try {
        const st = await fs.lstat(abs);
        out.entries.push({ path: rel, type: 'file', size: st.size, modified_at: st.mtime.toISOString() });
        out.bytes += st.size;
      } catch { /* sumiu no meio da leitura */ }
    }
  }
}

export async function listFiles(workspaceDir, options = {}) {
  const out = { entries: [], truncated: false, bytes: 0 };
  const start = options.subPath
    ? (await resolveInWorkspace(workspaceDir, options.subPath)).abs
    : workspaceDir;
  await walk(start, workspaceDir, options.depth === undefined ? 3 : options.depth, options.limit || 500, out);
  return out;
}

// Medição de cota: conta TUDO, inclusive o que a listagem esconde. Os limites
// são altos de propósito — se ainda assim a varredura não terminar, devolvemos
// `truncated`, e quem checa a cota trata isso como estouro em vez de "cabe".
const USAGE_MAX_DEPTH = 24;
const USAGE_MAX_ENTRIES = 200000;

export async function workspaceUsageBytes(workspaceDir) {
  const out = { entries: [], truncated: false, bytes: 0 };
  await walk(workspaceDir, workspaceDir, USAGE_MAX_DEPTH, USAGE_MAX_ENTRIES, out, true);
  return {
    bytes: out.bytes,
    files: out.entries.filter((e) => e.type === 'file').length,
    truncated: out.truncated
  };
}

export async function readFileForApi(workspaceDir, relPath, maxBytes = 65536) {
  const { abs, stat } = await resolveInWorkspace(workspaceDir, relPath);
  if (!stat || !stat.isFile()) {
    throw sandboxError('invalid_path', 'Arquivo não encontrado: ' + relPath);
  }
  const handle = await fs.open(abs, 'r');
  try {
    const size = stat.size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);

    // Texto se decodificar limpo; senão base64
    const text = buffer.toString('utf8');
    const isText = !text.includes('\uFFFD') && Buffer.byteLength(text, 'utf8') === buffer.length;
    return {
      path: relPath,
      size,
      encoding: isText ? 'utf8' : 'base64',
      content: isText ? text : buffer.toString('base64'),
      truncated: size > length
    };
  } finally {
    await handle.close();
  }
}

export async function writeFileToWorkspace(workspaceDir, relPath, buffer, mode = 'overwrite') {
  const { abs, stat } = await resolveInWorkspace(workspaceDir, relPath);
  if (stat && mode === 'create') {
    throw sandboxError('invalid_path', 'O arquivo já existe: ' + relPath);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o770 });
  await fs.writeFile(abs, buffer);
  return { path: relPath, size: buffer.length, created: !stat };
}

export async function deleteFromWorkspace(workspaceDir, relPath) {
  const { abs, stat } = await resolveInWorkspace(workspaceDir, relPath);
  if (!stat) throw sandboxError('invalid_path', 'Arquivo não encontrado: ' + relPath);
  await fs.rm(abs, { recursive: true, force: true });
  return { path: relPath, deleted: true };
}

// Snapshot antes/depois: é assim que sabemos o que a execução PRODUZIU.
// Sem isso o modelo precisa adivinhar quais arquivos gerou.
export async function snapshotWorkspace(workspaceDir) {
  const listing = await listFiles(workspaceDir, { depth: 8, limit: 5000 });
  const map = new Map();
  listing.entries.forEach((entry) => {
    if (entry.type === 'file') map.set(entry.path, { size: entry.size, modified_at: entry.modified_at });
  });
  return map;
}

export function diffArtifacts(before, after, limit = 25) {
  const artifacts = [];
  for (const [relPath, info] of after.entries()) {
    const previous = before.get(relPath);
    if (!previous) {
      artifacts.push({ path: relPath, size: info.size, created: true });
    } else if (previous.size !== info.size || previous.modified_at !== info.modified_at) {
      artifacts.push({ path: relPath, size: info.size, created: false });
    }
    if (artifacts.length >= limit) break;
  }
  return artifacts;
}

export async function destroyWorkspace(workspaceDir) {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
