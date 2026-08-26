// Payload enviado ao modelo e limite de abuso do proxy.
//
// ASSIGN-01 (docket ray-seam): a rota fazia `{ ...body, ... }`, repassando o
// corpo INTEIRO do chamador para a API de destino. Quem chama definia qualquer
// parâmetro do upstream — e esta é a rota que gasta dinheiro de verdade.
const path = require('node:path');
const { check, equal, group, ROOT } = require('./harness');

const chatModule = path.join(ROOT, 'server', 'src', 'chat.js');
const limitsModule = path.join(ROOT, 'server', 'src', 'sandbox', 'limits.js');

group('Chat: só os campos previstos chegam ao modelo', async () => {
  const { buildChatPayload } = await import(chatModule);

  const payload = buildChatPayload({
    model: 'AurexAI',
    messages: [{ role: 'user', content: 'oi' }],
    temperature: 0.2,
    // Tudo abaixo é injeção de parâmetro: nada disso pode passar
    n: 50,                       // multiplicaria o custo por 50
    logprobs: true,
    user: 'outro-usuario',
    frequency_penalty: 2,
    __proto__: { poluido: true }
  });

  equal('campos repassados', Object.keys(payload).sort(),
    ['messages', 'model', 'stream', 'temperature']);
  check('n não passa', payload.n === undefined);
  check('logprobs não passa', payload.logprobs === undefined);
  check('user não passa', payload.user === undefined);
  check('não herda propriedade poluída', payload.poluido === undefined);
});

group('Chat: campos que o servidor controla não são negociáveis', async () => {
  const { buildChatPayload } = await import(chatModule);

  const forcado = buildChatPayload({ messages: [], stream: true }, { defaultModel: 'modelo-real' });
  equal('streaming continua desligado', forcado.stream, false);
  equal('modelo padrão é aplicado', forcado.model, 'modelo-real');

  const alias = buildChatPayload({ model: 'AurexAI', messages: [] }, { defaultModel: 'modelo-real' });
  equal('o alias AurexAI é traduzido', alias.model, 'modelo-real');

  const semNada = buildChatPayload(null);
  equal('corpo nulo não quebra', semNada.messages, []);
  equal('mensagens não-array viram lista vazia', buildChatPayload({ messages: 'oi' }).messages, []);
});

group('Chat: números são limitados, não aceitos como vieram', async () => {
  const { buildChatPayload } = await import(chatModule);

  // O caso que motivou: max_tokens gigante é a forma mais barata de queimar
  // o saldo de quem hospeda o servidor.
  const caro = buildChatPayload({ messages: [], max_tokens: 9999999 }, { maxTokensCap: 16384 });
  equal('max_tokens é limitado ao teto', caro.max_tokens, 16384);

  equal('max_tokens negativo vira o mínimo',
    buildChatPayload({ messages: [], max_tokens: -5 }).max_tokens, 1);
  equal('max_tokens fracionário é truncado',
    buildChatPayload({ messages: [], max_tokens: 10.9 }).max_tokens, 10);

  equal('temperature acima da faixa é limitada',
    buildChatPayload({ messages: [], temperature: 99 }).temperature, 2);
  equal('temperature negativa é limitada',
    buildChatPayload({ messages: [], temperature: -3 }).temperature, 0);
  equal('top_p é limitado', buildChatPayload({ messages: [], top_p: 5 }).top_p, 1);

  // Valor não-numérico não pode virar NaN no payload
  check('string em temperature é ignorada',
    buildChatPayload({ messages: [], temperature: 'quente' }).temperature === undefined);
  check('NaN é ignorado',
    buildChatPayload({ messages: [], max_tokens: NaN }).max_tokens === undefined);
});

group('Chat: o limite por chamador existe no SERVIDOR', async () => {
  const { checkRateLimit } = await import(limitsModule);
  const dono = 'chat:user:teste-' + Date.now();

  // O teto que existia era no cliente — e teto no cliente é sugestão.
  for (let i = 0; i < 5; i++) checkRateLimit(dono, 5);

  let barrou = false;
  let codigo = '';
  try { checkRateLimit(dono, 5); } catch (err) { barrou = true; codigo = err.code || ''; }
  check('a sexta chamada é barrada', barrou);
  equal('com código acionável', codigo, 'rate_limited');

  // O limite é POR chamador: um usuário barrado não barra o outro
  let outroPassou = true;
  try { checkRateLimit('chat:user:outro-' + Date.now(), 5); } catch (err) { outroPassou = false; }
  check('outro chamador não é afetado', outroPassou);
});
