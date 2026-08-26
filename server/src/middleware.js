// Middlewares compartilhados do Aurex.
// Extraído de index.js para que a sandbox possa reusar exatamente a mesma
// autenticação — e para poder exigir um usuário identificado onde o chat
// aceita anônimo.
import crypto from 'node:crypto';
import { verifyAccessToken } from './auth.js';

// CORS com PADRÃO FECHADO para origens web.
//
// O padrão anterior era `cors()` sem opções, ou seja, Allow-Origin: *. E o
// efeito não é só "a página consegue ler a resposta": reproduzido, o preflight
// passava (204), o POST executava no servidor e o corpo voltava legível. Ou
// seja, qualquer site que o usuário visitasse podia dirigir o servidor local
// dele, gastar o saldo do modelo e ler o resultado — e com AUREX_API_KEYS
// vazio (o modo dev), sem credencial nenhuma.
//
// O chamador legítimo é a extensão, cuja origem é chrome-extension://<id>, e o
// id muda a cada instalação — não dá para fixar um valor. Liberamos o esquema
// de extensão e requisições SEM Origin (curl, cliente nativo), e negamos
// http/https a não ser que estejam na lista explícita.
export function corsOriginChecker(allowedOrigins) {
  const allowed = allowedOrigins || [];
  return function (origin, callback) {
    if (!origin) return callback(null, true);                    // não veio de navegador
    if (allowed.includes(origin)) return callback(null, true);   // liberado explicitamente
    if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return callback(null, true);
    if (/^moz-extension:\/\/[0-9a-f-]{36}$/.test(origin)) return callback(null, true);
    return callback(null, false);   // nega o CORS sem derrubar a requisição
  };
}

export function corsOptions(env = process.env) {
  const allowedOrigins = (env.AUREX_ALLOWED_ORIGINS || '')
    .split(',').map((v) => v.trim()).filter(Boolean);
  return { origin: corsOriginChecker(allowedOrigins), credentials: false };
}

export function validApiKeys() {
  return (process.env.AUREX_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

// Comparação de credencial em tempo constante.
//
// `lista.includes(token)` usa === , que para em cima do primeiro byte
// diferente — o tempo de resposta conta quantos caracteres o atacante já
// acertou. Aqui o servidor escuta na loopback do usuário, então quem mede é
// qualquer processo local, sem o ruído de rede que costuma tornar esse ataque
// impraticável. Comparamos digests de tamanho fixo para que nem o comprimento
// da chave vaze.
export function matchesApiKey(token, keys) {
  const candidate = crypto.createHash('sha256').update(String(token)).digest();
  let matched = false;
  for (const key of keys) {
    const expected = crypto.createHash('sha256').update(key).digest();
    // Sem short-circuit: percorremos a lista inteira mesmo depois de acertar.
    if (crypto.timingSafeEqual(candidate, expected)) matched = true;
  }
  return matched;
}

// Bearer: JWT do fluxo OAuth ou chave legada da lista AUREX_API_KEYS.
// Sem header Authorization: só é aceito se não houver nenhuma chave configurada
// (modo totalmente aberto para desenvolvimento local).
export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (token) {
    if (matchesApiKey(token, validApiKeys())) {
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
