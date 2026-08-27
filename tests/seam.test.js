// Fronteira cliente/servidor (docket ray-seam).
//
// CORS-01: o padrão era `cors()` sem opções, isto é, Allow-Origin: *. E o
// efeito não é só "a página lê a resposta" — reproduzido, o preflight passava,
// o POST EXECUTAVA no servidor e o corpo voltava legível. Qualquer site que o
// usuário visitasse podia dirigir o servidor local dele e gastar o saldo do
// modelo; com AUREX_API_KEYS vazio, sem credencial nenhuma.
const path = require('node:path');
const { check, equal, group, ROOT } = require('./harness');

const mw = path.join(ROOT, 'server', 'src', 'middleware.js');

function decide(checker, origin) {
  let allowed = null;
  checker(origin, (err, ok) => { allowed = ok; });
  return allowed;
}

group('CORS: origem web é negada por padrão', async () => {
  const { corsOriginChecker } = await import(mw);
  const checker = corsOriginChecker([]);

  [
    'https://site-malicioso.example',
    'http://site-malicioso.example',
    'https://localhost',
    'http://localhost:8080',
    'null',                       // iframe em sandbox e páginas file://
    'https://aurexai.com'         // nem o próprio domínio, sem configurar
  ].forEach((origin) => {
    equal('nega ' + origin, decide(checker, origin), false);
  });
});

group('CORS: a extensão continua passando', async () => {
  const { corsOriginChecker } = await import(mw);
  const checker = corsOriginChecker([]);

  // O id muda a cada instalação, então o que validamos é a FORMA
  equal('extensão Chrome', decide(checker, 'chrome-extension://' + 'a'.repeat(32)), true);
  equal('extensão Firefox',
    decide(checker, 'moz-extension://12345678-1234-1234-1234-123456789abc'), true);
  equal('sem Origin (curl, cliente nativo)', decide(checker, undefined), true);

  // Não pode virar um curinga disfarçado
  equal('esquema de extensão com id malformado', decide(checker, 'chrome-extension://abc'), false);
  equal('texto que só parece extensão',
    decide(checker, 'https://chrome-extension.evil.com'), false);
});

group('CORS: a lista explícita continua valendo', async () => {
  const { corsOriginChecker } = await import(mw);
  const checker = corsOriginChecker(['https://app.exemplo.com']);

  equal('origem configurada passa', decide(checker, 'https://app.exemplo.com'), true);
  equal('outra origem continua negada', decide(checker, 'https://outro.exemplo.com'), false);
  // Correspondência exata: sufixo/prefixo enganoso é o erro clássico da regra
  equal('sufixo enganoso', decide(checker, 'https://app.exemplo.com.evil.net'), false);
  equal('prefixo enganoso', decide(checker, 'https://evil-app.exemplo.com'), false);
});

group('CORS: leitura da configuração', async () => {
  const { corsOptions } = await import(mw);

  const padrao = corsOptions({});
  equal('sem credenciais', padrao.credentials, false);
  equal('origem vira função, não valor fixo', typeof padrao.origin, 'function');

  const comLista = corsOptions({ AUREX_ALLOWED_ORIGINS: 'https://a.com, https://b.com' });
  equal('lista separada por vírgula é lida', decide(comLista.origin, 'https://b.com'), true);
  equal('e o espaço em branco é aparado', decide(comLista.origin, 'https://a.com'), true);
});

// ---------- Comparação de credencial ----------
group('Chave de API: comparação em tempo constante', async () => {
  const { matchesApiKey } = await import(mw);
  const chave = 'chave-secreta-longa-de-producao-123456';

  check('a chave certa é aceita', matchesApiKey(chave, [chave]));
  check('a chave errada é recusada', matchesApiKey('outra-coisa', [chave]) === false);
  check('funciona com várias chaves', matchesApiKey(chave, ['outra', chave, 'mais-uma']));
  check('lista vazia recusa tudo', matchesApiKey(chave, []) === false);

  // O bug antigo: `lista.includes(token)` para no primeiro byte diferente, e o
  // tempo de resposta conta quantos caracteres o atacante já acertou. Os
  // digests têm tamanho fixo, então nem o comprimento vaza.
  check('prefixo correto não é aceito', matchesApiKey(chave.slice(0, 20), [chave]) === false);
  check('chave mais longa não é aceita', matchesApiKey(chave + 'x', [chave]) === false);
  check('string vazia não é aceita', matchesApiKey('', [chave]) === false);
});
