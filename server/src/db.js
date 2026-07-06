// Camada de dados do Aurex.
// Com DATABASE_URL definido usa Postgres; sem ele, cai num armazenamento em
// memória (útil para rodar localmente sem banco — os dados somem ao reiniciar).
import pg from 'pg';

const { Pool } = pg;

let pool = null;

const memory = {
  users: new Map(),          // id -> { id, name, email, google_sub }
  refreshTokens: new Map(),  // token -> { userId, expiresAt }
  authCodes: new Map()       // code -> { userId, challenge, redirectUri, expiresAt }
};

export function usingPostgres() {
  return pool !== null;
}

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[Aurex DB] DATABASE_URL ausente — usando armazenamento em memória.');
    return;
  }
  pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
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
