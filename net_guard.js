// Guardas de rede do web_fetch.
// Fronteira de segurança: a extensão tem host_permissions amplo e o fetch
// dela não passa por CORS, então sem isto uma injeção transforma o navegador
// do usuário em proxy para a rede interna dele. Mantido em arquivo próprio
// para que a regra fique óbvia e revisável.

// ========== GUARDAS DE REDE DO web_fetch ==========
//
// A extensão declara host_permissions para http/https em qualquer host, então
// o fetch dela não passa por CORS: alcança endereços que a própria página não
// alcançaria. Sem filtro, uma injeção numa página qualquer transforma o
// navegador do usuário em proxy para a rede interna dele.
var AUREX_PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa', '.localhost'];

// Converte as formas numéricas que o parser de URL aceita (decimal, hex,
// octal) para quadra pontilhada — senão 2130706433 e 0x7f.1 passariam batido.
function ipv4FromHostname(hostname) {
  var parts = hostname.split('.');
  if (parts.length > 4) return null;
  var numbers = [];
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (part === '') return null;
    var value;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part, 8);
    else if (/^[0-9]+$/.test(part)) value = parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    numbers.push(value);
  }
  // Forma curta: o último número preenche os octetos restantes
  var last = numbers.pop();
  var maxLast = Math.pow(256, 4 - numbers.length);
  if (last >= maxLast) return null;
  for (var j = 0; j < numbers.length; j++) if (numbers[j] > 255) return null;
  var octets = numbers.slice();
  for (var k = 4 - numbers.length - 1; k >= 0; k--) {
    octets.push(Math.floor(last / Math.pow(256, k)) % 256);
  }
  return octets;
}

function isPrivateNetworkHost(rawHost) {
  var host = String(rawHost || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;

  if (host === 'localhost') return true;
  for (var i = 0; i < AUREX_PRIVATE_HOST_SUFFIXES.length; i++) {
    if (host.endsWith(AUREX_PRIVATE_HOST_SUFFIXES[i])) return true;
  }

  // IPv6 entre colchetes (o hostname do URL preserva os colchetes)
  if (host.charAt(0) === '[') {
    var v6 = host.slice(1, -1);
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;              // unique local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;              // link-local fe80::/10
    var mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);      // IPv4 mapeado
    if (mapped) return isPrivateNetworkHost(mapped[1]);
    return false;
  }

  var octets = ipv4FromHostname(host);
  if (!octets) return false; // nome comum, não literal IP
  var a = octets[0], b = octets[1];
  if (a === 0) return true;                       // 0.0.0.0/8
  if (a === 127) return true;                     // loopback
  if (a === 10) return true;                      // privado
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;        // link-local e metadata da nuvem
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;          // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true;                      // multicast e reservado
  return false;
}

// Quanto de DADO o modelo colocou na URL. Buscar uma página é leitura; embutir
// 3 KB de conteúdo da página numa query string é envio. Não dá para impedir
// exfiltração por completo num agente que busca na web — dá para tirar dela o
// silêncio, exigindo aprovação quando a URL deixa de ser um endereço e vira
// um payload.
var AUREX_WEB_FETCH_EGRESS_BUDGET = 256;

function webFetchEgressBytes(parsedUrl) {
  var query = (parsedUrl.search || '').replace(/^\?/, '');
  var hash = (parsedUrl.hash || '').replace(/^#/, '');
  var payload = decodeURIComponent(query) + decodeURIComponent(hash);
  // Segmentos de caminho muito longos também carregam dado (base64 no path)
  var segments = (parsedUrl.pathname || '').split('/');
  for (var i = 0; i < segments.length; i++) {
    if (segments[i].length > 80) payload += segments[i];
  }
  return payload.length;
}
