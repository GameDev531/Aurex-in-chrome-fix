// Testes das guardas de rede do web_fetch.
//
// Contexto que dá peso a estes testes: o manifest declara host_permissions
// para http/https em QUALQUER host, então o fetch da extensão não passa por
// CORS. Ele alcança endereços que a página aberta não alcançaria — a rede
// interna do usuário, inclusive. Uma injeção numa página qualquer podia
// mandar o agente ler o roteador ou um serviço interno e devolver o conteúdo.
const { extractBlock, check, equal, group } = require('./harness');

const src = extractBlock('popup.js', 'var AUREX_PRIVATE_HOST_SUFFIXES', 'function authorizeFetchOrigin');
const scope = {};
new Function('scope', src +
  '\nscope.isPrivateNetworkHost = isPrivateNetworkHost;' +
  '\nscope.webFetchEgressBytes = webFetchEgressBytes;' +
  '\nscope.budget = AUREX_WEB_FETCH_EGRESS_BUDGET;')(scope);

const isPrivate = scope.isPrivateNetworkHost;

group('web_fetch: endereços de rede interna são recusados', () => {
  const bloqueados = [
    'localhost', 'LOCALHOST', 'localhost.',
    '127.0.0.1', '127.1', '127.0.0.1.',
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.254',
    '192.168.0.1', '192.168.1.254',
    '169.254.169.254',          // metadata de instância em nuvem
    '100.64.0.1',               // CGNAT
    '0.0.0.0',
    '198.18.0.1',
    '224.0.0.1',
    'impressora.local', 'wiki.internal', 'nas.lan', 'roteador.home.arpa',
    'app.localhost',
    '[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]',
    '[::ffff:127.0.0.1]'
  ];
  bloqueados.forEach((host) => check('recusa ' + host, isPrivate(host) === true));
});

group('web_fetch: formas numéricas disfarçadas de IP privado', () => {
  // O parser de URL aceita decimal, hexadecimal e octal. Um filtro que só
  // compara strings com "127.0.0.1" deixa todas estas passarem.
  check('decimal 2130706433 = 127.0.0.1', isPrivate('2130706433') === true);
  check('hex 0x7f000001', isPrivate('0x7f000001') === true);
  check('octal 0177.0.0.1', isPrivate('0177.0.0.1') === true);
  check('forma curta 127.1', isPrivate('127.1') === true);
  check('decimal 3232235777 = 192.168.1.1', isPrivate('3232235777') === true);
  check('hex misto 0xa.0.0.1 (rede 10)', isPrivate('0xa.0.0.1') === true);
});

group('web_fetch: internet pública continua acessível', () => {
  const liberados = [
    'example.com', 'en.wikipedia.org', 'api.github.com',
    'places.googleapis.com', 'meu-site.com.br',
    '8.8.8.8', '1.1.1.1', '93.184.216.34',
    'localhost.attacker.com',   // sufixo enganoso: NÃO é localhost
    'notlocal.com',
    '[2606:4700::1111]'
  ];
  liberados.forEach((host) => check('permite ' + host, isPrivate(host) === false));
});

group('web_fetch: host vazio ou inválido falha fechado', () => {
  check('host vazio é recusado', isPrivate('') === true);
  check('host indefinido é recusado', isPrivate(undefined) === true);
});

// ---------- Orçamento de saída ----------
group('web_fetch: URL de leitura não conta como envio', () => {
  const bytes = (u) => scope.webFetchEgressBytes(new URL(u));
  check('página simples', bytes('https://en.wikipedia.org/wiki/Brazil') <= scope.budget);
  check('busca normal', bytes('https://example.com/s?q=preco+do+dolar+hoje') <= scope.budget);
  check('API com id curto', bytes('https://api.exemplo.com/v1/items/12345?fields=name,price') <= scope.budget);
});

group('web_fetch: URL que carrega dados é tratada como envio', () => {
  const bytes = (u) => scope.webFetchEgressBytes(new URL(u));
  const vazado = 'Dados do usuario: '.repeat(40); // ~720 chars

  check('conteúdo na query passa do orçamento',
    bytes('https://attacker.example/?d=' + encodeURIComponent(vazado)) > scope.budget);
  check('percent-encoding não esconde o tamanho',
    bytes('https://attacker.example/?d=' + encodeURIComponent(vazado)) > vazado.length - 1);
  check('conteúdo no fragmento também conta',
    bytes('https://attacker.example/#' + encodeURIComponent(vazado)) > scope.budget);
  check('blob base64 no caminho também conta',
    bytes('https://attacker.example/' + 'QUJDREVGR0g'.repeat(30)) > scope.budget);
});
