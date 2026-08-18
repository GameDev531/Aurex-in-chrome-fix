// Middlewares compartilhados do Aurex.
// Extraído de index.js para que a sandbox possa reusar exatamente a mesma
// autenticação — e para poder exigir um usuário identificado onde o chat
// aceita anônimo.
import crypto from 'node:crypto';
import { verifyAccessToken } from './auth.js';

export function validApiKeys() {
  return (process.env.AUREX_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

// Bearer: JWT do fluxo OAuth ou chave legada da lista AUREX_API_KEYS.
// Sem header Authorization: só é aceito se não houver nenhuma chave configurada
// (modo totalmente aberto para desenvolvimento local).
export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (token) {
    if (validApiKeys().includes(token)) {
      // keyId permite atribuir cota, limite e auditoria por chave sem
      // guardar a chave em lugar nenhum.
      req.aurexUser = {
        name: 'API Key',
        apiKey: true,
        keyId: crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)
      };
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

// Identidade estável do chamador, usada para isolar workspaces, cotas e
// auditoria. Retorna null para anônimo — que é justamente quem não pode
// executar código.
export function ownerKeyFor(user) {
  if (!user || user.anonymous) return null;
  if (user.apiKey) return 'apikey:' + (user.keyId || 'desconhecida');
  if (user.id) return 'user:' + user.id;
  return null;
}

// Execução de código NUNCA aceita chamador anônimo, mesmo que o /chat aceite.
export function requireIdentifiedUser(req, res, next) {
  const ownerKey = ownerKeyFor(req.aurexUser);
  if (!ownerKey) {
    return res.status(403).json({
      error: {
        code: 'forbidden_anonymous',
        message: 'Execução de código exige autenticação. Configure AUREX_API_KEYS no servidor e informe a chave na extensão (Configurações ▸ Geral ▸ Servidor).'
      }
    });
  }
  req.aurexOwnerKey = ownerKey;
  return next();
}

// Express 4 não encaminha rejeições de handlers async para o middleware de
// erro — sem isto, uma promise rejeitada deixa a requisição pendurada.
export function asyncRoute(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
