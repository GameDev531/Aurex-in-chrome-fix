// Camada de dados do Aurex.
// Com DATABASE_URL definido usa Postgres; sem ele, cai num armazenamento em
// memória (útil para rodar localmente sem banco — os dados somem ao reiniciar).
import pg from 'pg';

const { Pool } = pg;

let pool = null;

const memory = {
  users: new Map(),          // id -> { id, name, email, google_sub }
  refreshTokens: new Map(),  // token -> { userId, expiresAt }
  authCodes: new Map(),      // code -> { userId, challenge, redirectUri, expiresAt }
  sandboxSessions: new Map(),// sessionId -> { ownerKey, lastUsedAt, expiresAt }
  sandboxRuns: []            // auditoria (limitada, mais recente ao fim)
};

const MEMORY_RUN_LIMIT = 1000;

export function usingPostgres() {
  return pool !== null;
}

// TLS do banco, COM verificação de certificado.
//
// Antes era sempre `rejectUnauthorized: false`, o que é pior do que parece:
// a flag se chama DATABASE_SSL=true, então quem a liga acredita ter deixado a
// conexão segura — e recebia criptografia sem autenticação, ou seja, aberta a
// man-in-the-middle, com um banco de credenciais de usuário atrás. Aceitar
// certificado auto-assinado passa a ser uma escolha SEPARADA e explícita.
//
// Exportada para poder ser testada sem abrir conexão de verdade.
export function resolveDbSsl(env = process.env, warn = console.warn) {
  const mode = String(env.DATABASE_SSL || '').toLowerCase();
  if (mode !== 'true' && mode !== 'require') return false;

  if (env.DATABASE_SSL_INSECURE === 'true') {
    warn('[Aurex DB] AVISO: DATABASE_SSL_INSECURE=true — o certificado do banco NÃO será verificado. Use apenas em desenvolvimento.');
    // nosemgrep: bypass-tls-verification -- escape deliberado, exigindo uma
    // variável própria e gritando no log. A verificação é o padrão acima.
    return { rejectUnauthorized: false };
  }

  return env.DATABASE_SSL_CA
    ? { rejectUnauthorized: true, ca: env.DATABASE_SSL_CA }
    : { rejectUnauthorized: true };
}

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[Aurex DB] DATABASE_URL ausente — usando armazenamento em memória.');
    return;
  }

  pool = new Pool({ connectionString: url, ssl: resolveDbSsl() });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aurex_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        google_sub TEXT UNIQUE,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS aurex_refresh_tokens (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES aurex_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aurex_auth_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES aurex_users(id) ON DELETE CASCADE,
        code_challenge TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      -- A chave é (owner_key, id), não id sozinho: o session_id vem do
      -- cliente e nomes como "default" ou "conversa1" colidem entre usuários
      -- diferentes. Com id como PK, o segundo usuário atualizava a linha do
      -- primeiro; a expiração passava a ser calculada sobre a sessão errada e
      -- o workspace de alguém ficava sem TTL (nunca varrido) ou era apagado
      -- por atividade de outra pessoa. Os diretórios sempre estiveram
      -- separados por dono, então isto nunca deu leitura cruzada de arquivos.
      CREATE TABLE IF NOT EXISTS aurex_sandbox_sessions (
        id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        last_used_at TIMESTAMPTZ DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_key, id)
      );
      CREATE INDEX IF NOT EXISTS aurex_sandbox_sessions_owner
        ON aurex_sandbox_sessions(owner_key);
      CREATE TABLE IF NOT EXISTS aurex_sandbox_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT,
        command_preview TEXT,
        network TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        timed_out BOOLEAN DEFAULT false,
        oom_killed BOOLEAN DEFAULT false,
        duration_ms INTEGER,
        stdout_bytes INTEGER,
        stderr_bytes INTEGER,
        artifact_count INTEGER,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS aurex_sandbox_runs_owner_time
        ON aurex_sandbox_runs(owner_key, started_at DESC);
    `);
    console.log('[Aurex DB] Postgres conectado e tabelas garantidas.');
  } catch (err) {
    console.error('[Aurex DB] Falha ao conectar no Postgres, caindo para memória:', err.message);
    pool = null;
  }
}

// ---------- Users ----------
export async function upsertUser({ id, name, email, googleSub }) {
  if (pool) {
    if (googleSub) {
      const existing = await pool.query('SELECT * FROM aurex_users WHERE google_sub = $1', [googleSub]);
      if (existing.rows[0]) {
        await pool.query('UPDATE aurex_users SET name = $1, email = $2 WHERE id = $3', [name, email, existing.rows[0].id]);
        return { id: existing.rows[0].id, name, email };
      }
    }
    await pool.query(
      'INSERT INTO aurex_users (id, name, email, google_sub) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET name = $2, email = $3',
      [id, name, email || null, googleSub || null]
    );
    return { id, name, email };
  }
  if (googleSub) {
    for (const user of memory.users.values()) {
      if (user.google_sub === googleSub) {
        user.name = name;
        user.email = email;
        return { id: user.id, name, email };
      }
    }
  }
  memory.users.set(id, { id, name, email, google_sub: googleSub || null });
  return { id, name, email };
}

export async function getUser(id) {
  if (pool) {
    const res = await pool.query('SELECT id, name, email FROM aurex_users WHERE id = $1', [id]);
    return res.rows[0] || null;
  }
  const user = memory.users.get(id);
  return user ? { id: user.id, name: user.name, email: user.email } : null;
}

// ---------- Auth codes (PKCE) ----------
export async function saveAuthCode({ code, userId, challenge, redirectUri, ttlMs }) {
  const expiresAt = new Date(Date.now() + ttlMs);
  if (pool) {
    await pool.query(
      'INSERT INTO aurex_auth_codes (code, user_id, code_challenge, redirect_uri, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [code, userId, challenge, redirectUri, expiresAt]
    );
    return;
  }
  memory.authCodes.set(code, { userId, challenge, redirectUri, expiresAt: expiresAt.getTime() });
}

export async function consumeAuthCode(code) {
  if (pool) {
    const res = await pool.query('DELETE FROM aurex_auth_codes WHERE code = $1 RETURNING *', [code]);
    const row = res.rows[0];
    if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
    return { userId: row.user_id, challenge: row.code_challenge, redirectUri: row.redirect_uri };
  }
  const entry = memory.authCodes.get(code);
  memory.authCodes.delete(code);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

// ---------- Refresh tokens ----------
export async function saveRefreshToken({ token, userId, ttlMs }) {
  const expiresAt = new Date(Date.now() + ttlMs);
  if (pool) {
    await pool.query(
      'INSERT INTO aurex_refresh_tokens (token, user_id, expires_at) VALUES ($1,$2,$3)',
      [token, userId, expiresAt]
    );
    return;
  }
  memory.refreshTokens.set(token, { userId, expiresAt: expiresAt.getTime() });
}

export async function consumeRefreshToken(token) {
  if (pool) {
    const res = await pool.query('DELETE FROM aurex_refresh_tokens WHERE token = $1 RETURNING *', [token]);
    const row = res.rows[0];
    if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
    return { userId: row.user_id };
  }
  const entry = memory.refreshTokens.get(token);
  memory.refreshTokens.delete(token);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return { userId: entry.userId };
}

export async function revokeRefreshToken(token) {
  if (pool) {
    await pool.query('DELETE FROM aurex_refresh_tokens WHERE token = $1', [token]);
    return;
  }
  memory.refreshTokens.delete(token);
}

// ---------- Sandbox: sessões e auditoria ----------
// As tabelas da sandbox NÃO têm foreign key para aurex_users: um chamador
// autenticado por API key não tem linha em aurex_users.

// A chave do Map segue a mesma regra da PK do Postgres: dono + sessão.
function sandboxSessionKey(ownerKey, sessionId) {
  return ownerKey + '\u0000' + sessionId;
}

export async function touchSandboxSession(sessionId, ownerKey, expiresAtMs) {
  const expiresAt = new Date(expiresAtMs);
  if (pool) {
    await pool.query(
      `INSERT INTO aurex_sandbox_sessions (id, owner_key, expires_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (owner_key, id) DO UPDATE SET last_used_at = now(), expires_at = $3`,
      [sessionId, ownerKey, expiresAt]
    );
    return;
  }
  memory.sandboxSessions.set(sandboxSessionKey(ownerKey, sessionId), {
    id: sessionId,
    ownerKey,
    lastUsedAt: Date.now(),
    expiresAt: expiresAt.getTime()
  });
}

export async function listExpiredSandboxSessions() {
  if (pool) {
    const res = await pool.query(
      'SELECT id, owner_key FROM aurex_sandbox_sessions WHERE expires_at < now()'
    );
    return res.rows.map((row) => ({ id: row.id, ownerKey: row.owner_key }));
  }
  const now = Date.now();
  const expired = [];
  for (const entry of memory.sandboxSessions.values()) {
    if (entry.expiresAt < now) expired.push({ id: entry.id, ownerKey: entry.ownerKey });
  }
  return expired;
}

// Apaga a sessão DE UM DONO. Sem o owner_key, apagar "default" derrubaria o
// registro de todo mundo que usou esse nome.
export async function deleteSandboxSession(sessionId, ownerKey) {
  if (pool) {
    await pool.query(
      'DELETE FROM aurex_sandbox_sessions WHERE id = $1 AND owner_key = $2',
      [sessionId, ownerKey]
    );
    return;
  }
  memory.sandboxSessions.delete(sandboxSessionKey(ownerKey, sessionId));
}

// Auditoria: guardamos o comando (útil num incidente), NUNCA a saída.
export async function recordSandboxRun(run) {
  if (pool) {
    await pool.query(
      `INSERT INTO aurex_sandbox_runs
        (id, session_id, owner_key, kind, language, command_preview, network, status,
         exit_code, timed_out, oom_killed, duration_ms, stdout_bytes, stderr_bytes,
         artifact_count, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [run.id, run.sessionId, run.ownerKey, run.kind, run.language, run.commandPreview,
       run.network, run.status, run.exitCode, run.timedOut, run.oomKilled, run.durationMs,
       run.stdoutBytes, run.stderrBytes, run.artifactCount, run.startedAt, run.finishedAt]
    );
    return;
  }
  memory.sandboxRuns.push(run);
  if (memory.sandboxRuns.length > MEMORY_RUN_LIMIT) memory.sandboxRuns.shift();
}

export async function listRecentSandboxRuns(ownerKey, limit = 20) {
  if (pool) {
    const res = await pool.query(
      'SELECT * FROM aurex_sandbox_runs WHERE owner_key = $1 ORDER BY started_at DESC LIMIT $2',
      [ownerKey, limit]
    );
    return res.rows;
  }
  return memory.sandboxRuns
    .filter((run) => run.ownerKey === ownerKey)
    .slice(-limit)
    .reverse();
}
