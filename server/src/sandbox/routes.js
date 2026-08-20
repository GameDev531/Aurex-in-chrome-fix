// Rotas da sandbox.
//
// Quando a sandbox está desligada, NADA aqui é registrado — o servidor
// responde 404 normal, sem revelar que o recurso existe.
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { authenticate, requireIdentifiedUser, asyncRoute } from '../middleware.js';
import { sandboxError, toHttpError } from './errors.js';
import { acquireSlot, checkRateLimit } from './limits.js';
import { runInContainer, buildHint, assertNetworkAllowed } from './docker.js';
import {
  ensureWorkspace, assertValidSessionId, resolveInWorkspace, listFiles,
  readFileForApi, writeFileToWorkspace, deleteFromWorkspace,
  workspaceUsageBytes, snapshotWorkspace, diffArtifacts, destroyWorkspace,
  workspacePathFor
} from './workspace.js';
import { recordSandboxRun, touchSandboxSession } from '../db.js';

const LANGUAGES = {
  python: { ext: 'py', argv: (file, args) => ['python3', file, ...args] },
  node: { ext: 'mjs', argv: (file, args) => ['node', file, ...args] },
  bash: { ext: 'sh', argv: (file, args) => ['bash', file, ...args] }
};

function sanitizeEnv(env) {
  const clean = {};
  if (!env || typeof env !== 'object') return clean;
  Object.keys(env).slice(0, 32).forEach((key) => {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) return;
    clean[key] = String(env[key]).slice(0, 2048);
  });
  return clean;
}

export function registerSandboxRoutes(app, deps) {
  const { cfg, state } = deps;
  if (!cfg.enabled) return;

  const router = express.Router();
  // Limite próprio, bem menor que os 25 MB globais do chat
  router.use(express.json({ limit: '16mb' }));
  router.use(authenticate);

  // Health é o que a extensão sonda para saber se pode oferecer as
  // ferramentas ao modelo. Não exige usuário identificado.
  router.get('/health', (req, res) => {
    res.json({
      enabled: true,
      ready: state.ready,
      reason: state.reason || null,
      image: cfg.image,
      allow_network: cfg.allowNetwork,
      limits: {
        timeout_ms: cfg.timeoutMs,
        max_timeout_ms: cfg.maxTimeoutMs,
        memory: cfg.memory,
        workspace_mb: cfg.maxWorkspaceMb
      }
    });
  });

  // A partir daqui, execução: exige usuário identificado (nunca anônimo)
  router.use(requireIdentifiedUser);

  function requireReady() {
    if (!state.ready) {
      throw sandboxError('sandbox_unavailable', state.reason || 'Sandbox indisponível no servidor.');
    }
  }

  async function openWorkspace(req) {
    requireReady();
    const sessionId = assertValidSessionId(req.params.sid || req.body.session_id || req.query.session_id);
    const { dir } = await ensureWorkspace(cfg, req.aurexOwnerKey, sessionId);
    await touchSandboxSession(sessionId, req.aurexOwnerKey, Date.now() + cfg.sessionTtlMs);
    return { sessionId, dir };
  }

  // --- Execução ---
  router.post('/sessions/:sid/exec', asyncRoute(async (req, res) => {
    const { sessionId, dir } = await openWorkspace(req);
    const body = req.body || {};

    const network = body.network === true || body.network === 'full' ? 'full' : 'none';
    assertNetworkAllowed(cfg, network);

    const timeoutMs = Math.min(
      parseInt(body.timeout_ms, 10) || cfg.timeoutMs,
      cfg.maxTimeoutMs
    );

    // Cota ANTES de gastar recursos. Medida incompleta conta como estouro:
    // "não consegui medir" não é o mesmo que "cabe".
    const usageBefore = await workspaceUsageBytes(dir);
    if (usageBefore.bytes > cfg.maxWorkspaceMb * 1024 * 1024 || usageBefore.truncated) {
      throw sandboxError('quota_exceeded',
        usageBefore.truncated
          ? 'O workspace desta conversa tem arquivos demais para ser medido com segurança. Apague o que não precisa com sandbox_files antes de executar de novo.'
          : 'O workspace desta conversa passou de ' + cfg.maxWorkspaceMb + ' MB. Apague arquivos com sandbox_files antes de executar de novo.');
    }

    checkRateLimit(req.aurexOwnerKey, cfg.ratePerMin);
    const release = acquireSlot(req.aurexOwnerKey, cfg.maxConcurrent);

    const startedAt = new Date();
    try {
      let argv;
      let kind;
      let language = null;
      let scriptFile = null;

      if (body.code) {
        language = String(body.language || 'python').toLowerCase();
        const spec = LANGUAGES[language];
        if (!spec) {
          throw sandboxError('invalid_request', 'Linguagem não suportada: ' + language + '. Use python, node ou bash.');
        }
        scriptFile = String(body.filename || ('aurex_run.' + spec.ext));
        // Grava o script no workspace: fica inspecionável e reexecutável
        await writeFileToWorkspace(dir, scriptFile, Buffer.from(String(body.code), 'utf8'));
        argv = spec.argv(scriptFile, Array.isArray(body.args) ? body.args.map(String) : []);
        kind = 'code';
      } else if (body.command) {
        argv = ['bash', '-lc', String(body.command)];
        kind = 'command';
      } else {
        throw sandboxError('invalid_request', 'Informe "command" (shell) ou "code" + "language".');
      }

      const before = await snapshotWorkspace(dir);
      const containerName = 'aurex-sbx-' + crypto.randomBytes(8).toString('hex');

      const run = await runInContainer({
        cfg,
        containerName,
        sessionId,
        workspaceDir: dir,
        argv,
        stdin: typeof body.stdin === 'string' ? body.stdin.slice(0, 65536) : '',
        timeoutMs,
        network,
        env: sanitizeEnv(body.env)
      });

      const after = await snapshotWorkspace(dir);
      const artifacts = diffArtifacts(before, after);
      const usageAfter = await workspaceUsageBytes(dir);

      const hint = buildHint(run, {
        memory: cfg.memory,
        network,
        allowNetwork: cfg.allowNetwork,
        artifactCount: artifacts.length
      });

      await recordSandboxRun({
        id: 'sbxrun_' + crypto.randomBytes(10).toString('hex'),
        sessionId,
        ownerKey: req.aurexOwnerKey,
        kind,
        language,
        commandPreview: String(body.command || body.code || '').slice(0, 500),
        network,
        status: run.timedOut ? 'timeout' : (run.oomKilled ? 'oom' : (run.dockerFailure ? 'error' : 'completed')),
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        oomKilled: run.oomKilled,
        durationMs: run.durationMs,
        stdoutBytes: run.stdoutBytes,
        stderrBytes: run.stderrBytes,
        artifactCount: artifacts.length,
        startedAt,
        finishedAt: new Date()
      });

      res.json({
        session_id: sessionId,
        status: 'completed',
        exit_code: run.exitCode,
        timed_out: run.timedOut,
        oom_killed: run.oomKilled,
        duration_ms: run.durationMs,
        stdout: run.stdout,
        stderr: run.stderr,
        stdout_bytes: run.stdoutBytes,
        stderr_bytes: run.stderrBytes,
        stdout_truncated: run.stdoutTruncated,
        stderr_truncated: run.stderrTruncated,
        network,
        script_file: scriptFile,
        artifacts,
        workspace: {
          used_bytes: usageAfter.bytes,
          quota_bytes: cfg.maxWorkspaceMb * 1024 * 1024,
          file_count: usageAfter.files
        },
        hint
      });
    } finally {
      release();
    }
  }));

  // --- Arquivos ---
  router.get('/sessions/:sid/files', asyncRoute(async (req, res) => {
    const { dir } = await openWorkspace(req);
    const listing = await listFiles(dir, {
      subPath: req.query.path,
      depth: req.query.depth ? parseInt(req.query.depth, 10) : 3
    });
    const usage = await workspaceUsageBytes(dir);
    res.json({
      entries: listing.entries,
      truncated: listing.truncated,
      used_bytes: usage.bytes,
      quota_bytes: cfg.maxWorkspaceMb * 1024 * 1024
    });
  }));

  router.get('/sessions/:sid/files/content', asyncRoute(async (req, res) => {
    const { dir } = await openWorkspace(req);
    const maxBytes = Math.min(parseInt(req.query.max_bytes, 10) || 65536, 1048576);
    res.json(await readFileForApi(dir, String(req.query.path || ''), maxBytes));
  }));

  router.post('/sessions/:sid/files', asyncRoute(async (req, res) => {
    const { dir } = await openWorkspace(req);
    const body = req.body || {};
    const buffer = body.encoding === 'base64'
      ? Buffer.from(String(body.content || ''), 'base64')
      : Buffer.from(String(body.content || ''), 'utf8');
    res.json(await writeFileToWorkspace(dir, String(body.path || ''), buffer, body.mode || 'overwrite'));
  }));

  router.delete('/sessions/:sid/files', asyncRoute(async (req, res) => {
    const { dir } = await openWorkspace(req);
    res.json(await deleteFromWorkspace(dir, String(req.query.path || '')));
  }));

  // Download binário do artefato. Sempre octet-stream: servir text/html a
  // partir da origem da API seria XSS armazenado.
  router.get('/sessions/:sid/files/raw', asyncRoute(async (req, res) => {
    const { dir } = await openWorkspace(req);
    const relPath = String(req.query.path || '');
    const { abs, stat } = await resolveInWorkspace(dir, relPath);
    if (!stat || !stat.isFile()) {
      throw sandboxError('invalid_path', 'Arquivo não encontrado: ' + relPath);
    }
    const data = await fs.readFile(abs);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition',
      'attachment; filename="' + path.basename(relPath).replace(/["\\]/g, '_') + '"');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(data);
  }));

  router.delete('/sessions/:sid', asyncRoute(async (req, res) => {
    const sessionId = assertValidSessionId(req.params.sid);
    await destroyWorkspace(workspacePathFor(cfg, req.aurexOwnerKey, sessionId));
    res.json({ session_id: sessionId, destroyed: true });
  }));

  // Middleware de erro DA SANDBOX — precisa vir antes do 404 global
  router.use((err, req, res, next) => {
    const mapped = toHttpError(err);
    if (mapped.status >= 500) console.error('[Aurex Sandbox]', err);
    res.status(mapped.status).json(mapped.body);
  });

  app.use('/v1/sandbox', router);
}
