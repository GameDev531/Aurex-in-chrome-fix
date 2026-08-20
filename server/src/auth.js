// Autenticação do Aurex: fluxo OAuth com PKCE (S256) usado pela extensão,
// login via Google quando configurado (GOOGLE_CLIENT_ID/SECRET) e um login de
// desenvolvimento (nome + email) quando não há Google configurado.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { asyncRoute } from './middleware.js';
import {
  upsertUser,
  getUser,
  saveAuthCode,
  consumeAuthCode,
  saveRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken
} from './db.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;              // 1h
const REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias
const AUTH_CODE_TTL_MS = 1000 * 60 * 5;                // 5 min

// Estados pendentes do fluxo (state da extensão -> challenge/redirect)
const pendingLogins = new Map();
const MAX_PENDING_LOGINS = 5000;

function pruneExpiredLogins() {
  const cutoff = Date.now() - AUTH_CODE_TTL_MS;
  for (const [state, entry] of pendingLogins.entries()) {
    if (!entry.createdAt || entry.createdAt < cutoff) pendingLogins.delete(state);
  }
}

// Allowlist de destinos do código de autorização. A extensão usa
// chrome.identity.getRedirectURL(), que é sempre
// https://<id-da-extensao>.chromiumapp.org/callback — um valor exato e fácil
// de registrar.
export function allowedRedirects() {
  return (process.env.AUREX_ALLOWED_REDIRECT_URIS || '')
    .split(',').map((v) => v.trim()).filter(Boolean);
}

function isAllowedRedirect(value) {
  const list = allowedRedirects();
  if (list.length === 0) return false; // fail closed: sem configuração, ninguém entra
  return list.includes(value);
}

function jwtSecret() {
  return process.env.AUREX_JWT_SECRET || 'change-this-to-a-long-random-secret';
}

function googleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function base64UrlSha256(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

export function issueAccessToken(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, email: user.email || undefined },
    jwtSecret(),
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS }
  );
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, jwtSecret());
  } catch {
    return null;
  }
}

async function issueTokenPair(user) {
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  await saveRefreshToken({ token: refreshToken, userId: user.id, ttlMs: REFRESH_TOKEN_TTL_MS });
  return {
    accessToken: issueAccessToken(user),
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    user: { name: user.name, email: user.email || null }
  };
}

async function finishLogin(res, state, user) {
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!pending) return res.status(400).send('Login state expirado. Tente novamente na extensão.');

  const code = crypto.randomBytes(24).toString('base64url');
  await saveAuthCode({
    code,
    userId: user.id,
    challenge: pending.challenge,
    redirectUri: pending.redirectUri,
    ttlMs: AUTH_CODE_TTL_MS
  });

  const target = new URL(pending.redirectUri);
  target.searchParams.set('code', code);
  target.searchParams.set('state', state);
  res.redirect(target.toString());
}

export function registerAuthRoutes(app) {
  // Passo 1 — a extensão abre esta URL com state + code_challenge + redirect_uri
  app.get('/auth/login', (req, res) => {
    const { state, code_challenge: challenge, redirect_uri: redirectUri } = req.query;
    if (!state || !challenge || !redirectUri) {
      return res.status(400).send('Parâmetros obrigatórios: state, code_challenge, redirect_uri.');
    }

    // Sem allowlist, um atacante registrava o próprio redirect_uri e o próprio
    // desafio PKCE, mandava o link do Google para a vítima e recebia o código
    // de autorização DELA — tomada de conta com um clique. O PKCE não protege
    // aqui justamente porque quem registrou o desafio foi o atacante.
    if (!isAllowedRedirect(String(redirectUri))) {
      return res.status(400).send('redirect_uri não registrado. Configure AUREX_ALLOWED_REDIRECT_URIS no servidor.');
    }

    // Mapa controlado pelo cliente: sem teto, um laço de requisições anônimas
    // consumiria a heap até derrubar o processo.
    pruneExpiredLogins();
    if (pendingLogins.size >= MAX_PENDING_LOGINS) {
      return res.status(429).send('Muitos logins pendentes. Tente novamente em instantes.');
    }

    pendingLogins.set(String(state), {
      challenge: String(challenge),
      redirectUri: String(redirectUri),
      createdAt: Date.now()
    });

    if (googleConfigured()) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
      url.searchParams.set('redirect_uri', process.env.GOOGLE_REDIRECT_URI ||
        `${process.env.AUREX_PUBLIC_BASE_URL || ''}/auth/google/callback`);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', String(state));
      return res.redirect(url.toString());
    }

    // Sem Google configurado: login de desenvolvimento (nome + email)
    res.type('html').send(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Aurex — Login</title>
<style>
  body{font-family:system-ui,sans-serif;background:#14171f;color:#f2f3f7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  form{background:#1f232d;border:1px solid #333949;border-radius:16px;padding:32px;width:340px;display:flex;flex-direction:column;gap:12px}
  h1{font-size:18px;margin:0 0 6px}
  input{padding:11px 13px;border-radius:10px;border:1px solid #333949;background:#21252f;color:#f2f3f7;font-size:14px}
  button{padding:12px;border-radius:10px;border:0;background:linear-gradient(135deg,#e0b486,#c4894f);color:#0e1015;font-weight:600;font-size:14px;cursor:pointer}
  p{font-size:12px;color:#a3a9ba;margin:0}
</style></head><body>
<form method="POST" action="/auth/dev-login">
  <h1>Entrar no Aurex</h1>
  <p>Login de desenvolvimento (Google OAuth não configurado no servidor).</p>
  <input type="hidden" name="state" value="${String(state).replace(/"/g, '&quot;')}">
  <input name="name" placeholder="Seu nome" required maxlength="40">
  <input name="email" type="email" placeholder="Seu email (opcional)">
  <button type="submit">Continuar</button>
</form></body></html>`);
  });

  // Login de desenvolvimento.
  //
  // CRÍTICO: esta rota emite um token válido sem NENHUMA credencial. Antes ela
  // era registrada sempre — só o formulário GET era condicionado ao Google.
  // Bastavam três requisições sem autenticação para obter um JWT legítimo e,
  // com ele, execução de código na sandbox. Agora ela só existe quando o
  // Google não está configurado, e o boot recusa combiná-la com a sandbox.
  if (!googleConfigured()) {
    app.post('/auth/dev-login', asyncRoute(async (req, res) => {
      const { state, name, email } = req.body || {};
      if (!state || !name) return res.status(400).send('Nome e state são obrigatórios.');
      const user = await upsertUser({
        id: 'dev_' + base64UrlSha256(String(email || name)).slice(0, 20),
        name: String(name).slice(0, 40),
        email: email ? String(email) : null
      });
      await finishLogin(res, String(state), user);
    }));
  }

  // Callback do Google
  app.get('/auth/google/callback', asyncRoute(async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Callback inválido do Google.');
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(code),
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: process.env.GOOGLE_REDIRECT_URI ||
            `${process.env.AUREX_PUBLIC_BASE_URL || ''}/auth/google/callback`,
          grant_type: 'authorization_code'
        })
      });
      if (!tokenRes.ok) throw new Error('Google token exchange falhou: ' + tokenRes.status);
      const tokens = await tokenRes.json();

      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      if (!infoRes.ok) throw new Error('Google userinfo falhou: ' + infoRes.status);
      const profile = await infoRes.json();

      const user = await upsertUser({
        id: 'g_' + profile.sub,
        name: profile.name || profile.given_name || 'Usuário',
        email: profile.email || null,
        googleSub: profile.sub
      });
      await finishLogin(res, String(state), user);
    } catch (err) {
      console.error('[Aurex Auth] Google callback:', err.message);
      res.status(502).send('Falha ao autenticar com o Google. Tente novamente.');
    }
  }));

  // Passo 2 — troca do code (com verificação PKCE) por tokens
  app.post('/auth/token', asyncRoute(async (req, res) => {
    const { code, code_verifier: verifier, redirect_uri: redirectUri } = req.body || {};
    if (!code || !verifier || !redirectUri) {
      return res.status(400).json({ error: 'code, code_verifier e redirect_uri são obrigatórios.' });
    }
    const entry = await consumeAuthCode(String(code));
    if (!entry) return res.status(400).json({ error: 'Código inválido ou expirado.' });
    if (entry.redirectUri !== redirectUri) return res.status(400).json({ error: 'redirect_uri divergente.' });
    if (base64UrlSha256(String(verifier)) !== entry.challenge) {
      return res.status(400).json({ error: 'Verificação PKCE falhou.' });
    }
    const user = await getUser(entry.userId);
    if (!user) return res.status(400).json({ error: 'Usuário não encontrado.' });
    res.json(await issueTokenPair(user));
  }));

  // Renovação de sessão
  app.post('/auth/refresh', asyncRoute(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken é obrigatório.' });
    const entry = await consumeRefreshToken(String(refreshToken));
    if (!entry) return res.status(401).json({ error: 'Refresh token inválido ou expirado.' });
    const user = await getUser(entry.userId);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado.' });
    res.json(await issueTokenPair(user));
  }));

  // Logout — revoga o refresh token
  app.post('/auth/logout', asyncRoute(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (refreshToken) await revokeRefreshToken(String(refreshToken));
    res.json({ ok: true });
  }));
}
