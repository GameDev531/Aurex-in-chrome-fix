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
import { registerAuthRoutes, verifyAccessToken } from './auth.js';

const app = express();
app.use(cors()); // extensão roda em chrome-extension:// — liberamos CORS
app.use(express.json({ limit: '25mb' })); // screenshots em base64 são grandes
app.use(express.urlencoded({ extended: false }));

const PORT = parseInt(process.env.PORT || '3000', 10);

// modelo temporario pois por enquanto o modelo proprio esta em desenvolvimento.
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

function validApiKeys() {
  return (process.env.AUREX_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

// Bearer: JWT do fluxo OAuth ou chave legada da lista AUREX_API_KEYS.
// Sem header Authorization: só é aceito se não houver nenhuma chave configurada
// (modo totalmente aberto para desenvolvimento local).
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (token) {
    if (validApiKeys().includes(token)) {
      req.aurexUser = { name: 'API Key', apiKey: true };
      return next();
    }
    const payload = verifyAccessToken(token);
    if (payload) {
      req.aurexUser = { id: payload.sub, name: payload.name, email: payload.email };
      return next();
    }
    return res.status(401).json({ error: { message: 'Token inválido ou expirado. Faça login novamente.' } });
  }

  if (validApiKeys().length === 0) {
    req.aurexUser = { name: 'Anônimo (dev)', anonymous: true };
    return next();
  }
  return res.status(401).json({ error: { message: 'Autenticação obrigatória: envie Bearer token ou chave da API.' } });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'aurex-server',
    database: usingPostgres() ? 'postgres' : 'memory',
    model: process.env.DEEPSEEK_API_KEY ? 'deepseek (proxy)' : 'não configurado'
  });
});

registerAuthRoutes(app);

app.post('/v1/chat/completions', authenticate, async (req, res) => {
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

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`[Aurex Server] Rodando em http://127.0.0.1:${PORT}`);
    console.log(`[Aurex Server] Chat: POST http://127.0.0.1:${PORT}/v1/chat/completions`);
  });
});
