// Aurex Server — backend do Aurex in Chrome.
//
// Endpoints:
//   GET  /health                 — status do servidor
//   GET  /auth/login             — inicia OAuth PKCE (Google ou dev-login)
//   GET  /auth/google/callback   — callback do Google
//   POST /auth/token             — troca code+verifier por access/refresh token
//   POST /auth/refresh           — renova a sessão
//   POST /auth/logout            — revoga o refresh token
//   POST /v1/chat/completions    — chat (proxy para o modelo; DeepSeek por enquanto)
//
// Autenticação do /v1: Bearer com JWT emitido pelo /auth/token OU uma chave
// listada em AUREX_API_KEYS (legado/admin).
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb, usingPostgres } from './db.js';
import { registerAuthRoutes } from './auth.js';
import { authenticate, validApiKeys } from './middleware.js';
import { readSandboxConfig, assertCoreBootConfig, assertSandboxBootConfig, dockerPreflight, SandboxBootError } from './sandbox/config.js';
import { registerSandboxRoutes } from './sandbox/routes.js';
import { sweepOrphanContainers } from './sandbox/docker.js';
import { startSandboxSweeper } from './sandbox/sweeper.js';

const app = express();
// CORS restrito quando configurado. Com '*', qualquer página que o usuário
// visitasse podia ler respostas desta API no localhost dele.
const allowedOrigins = (process.env.AUREX_ALLOWED_ORIGINS || '')
  .split(',').map((v) => v.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins, credentials: false } : {}));

// O parser JSON de 25 MB era global, então o limite menor declarado no router
// da sandbox nunca valia (o body-parser marca req._body e o segundo parser
// não roda). Agora o limite grande fica só na rota que precisa dele.
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

const PORT = parseInt(process.env.PORT || '3000', 10);

// modelo temporario pois por enquanto o modelo proprio esta em desenvolvimento.
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

// authenticate e validApiKeys agora vivem em middleware.js, para a sandbox
// poder reusar exatamente a mesma autenticação.

// Estado da sandbox, preenchido no boot e lido pelas rotas
const sandboxCfg = readSandboxConfig();
const sandboxState = { ready: false, reason: 'Sandbox desativada.' };

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'aurex-server',
    database: usingPostgres() ? 'postgres' : 'memory',
    model: process.env.DEEPSEEK_API_KEY ? 'deepseek (proxy)' : 'não configurado',
    // Sem autenticação: nada de stderr do Docker, nome de imagem ou caminho
    // de build aqui — o detalhe fica no /v1/sandbox/health, que exige token.
    sandbox: {
      enabled: sandboxCfg.enabled,
      ready: sandboxState.ready,
      // A extensão precisa saber disto para dizer ao modelo se ele PODE pedir
      // rede numa execução. Sem o campo, ela assumia "nunca há internet" e a
      // capacidade ficava inalcançável mesmo com o operador tendo ligado.
      allow_network: sandboxCfg.allowNetwork,
      allow_services: sandboxCfg.allowServices
    }
  });
});

registerAuthRoutes(app);
// Registrado antes do 404 catch-all; se a sandbox estiver desligada, esta
// chamada não registra rota nenhuma.
registerSandboxRoutes(app, { cfg: sandboxCfg, state: sandboxState });

// Corpo grande só aqui (screenshots em base64), não em todas as rotas
app.post('/v1/chat/completions', express.json({ limit: '25mb' }), authenticate, async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: { message: 'Nenhum modelo configurado no servidor. Defina DEEPSEEK_API_KEY no .env.' }
    });
  }

  const body = req.body || {};
  const payload = {
    ...body,
    // A extensão envia model: "AurexAI"; mapeamos para o modelo real do proxy
    model: !body.model || body.model === 'AurexAI' ? DEEPSEEK_MODEL : body.model,
    stream: false
  };

  try {
    const upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const message = data?.error?.message || `Modelo respondeu ${upstream.status}`;
      return res.status(upstream.status).json({ error: { message } });
    }
    res.json(data);
  } catch (err) {
    console.error('[Aurex Chat] Falha no proxy do modelo:', err.message);
    res.status(502).json({ error: { message: 'Falha ao falar com o modelo: ' + err.message } });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: { message: `Rota não encontrada: ${req.method} ${req.path}` } });
});

async function start() {
  // Trava de boot: falha ruidosa em vez de subir com credencial fraca ou
  // com a sandbox exposta.
  try {
    assertCoreBootConfig();
    assertSandboxBootConfig(sandboxCfg);
  } catch (err) {
    if (err instanceof SandboxBootError) {
      console.error('\n[Aurex Server] ABORTANDO — ' + err.message + '\n');
      process.exit(1);
    }
    throw err;
  }

  await initDb();

  if (sandboxCfg.enabled) {
    const preflight = await dockerPreflight(sandboxCfg);
    sandboxState.ready = preflight.ready;
    sandboxState.reason = preflight.reason || null;
    if (preflight.ready) {
      const swept = await sweepOrphanContainers(sandboxCfg);
      if (swept) console.log(`[Aurex Sandbox] ${swept} container(s) órfão(s) removido(s).`);
      console.log(`[Aurex Sandbox] Pronta (Docker ${preflight.dockerVersion}, imagem ${sandboxCfg.image}).`);
      startSandboxSweeper(sandboxCfg);
    } else {
      // Docker indisponível não derruba o servidor: o chat continua, e a
      // sandbox se declara indisponível com um motivo acionável.
      console.warn(`[Aurex Sandbox] Indisponível: ${preflight.reason}`);
    }
  }

  const host = sandboxCfg.bindHost;
  app.listen(PORT, host, () => {
    console.log(`[Aurex Server] Rodando em http://${host}:${PORT}`);
    console.log(`[Aurex Server] Chat: POST http://${host}:${PORT}/v1/chat/completions`);
    if (sandboxCfg.enabled && sandboxState.ready) {
      console.log(`[Aurex Server] Sandbox: POST http://${host}:${PORT}/v1/sandbox/sessions/<id>/exec`);
    }
  });
}

start().catch((err) => {
  console.error('[Aurex Server] Falha ao iniciar:', err);
  process.exit(1);
});
