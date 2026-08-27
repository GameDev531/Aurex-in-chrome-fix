// Montagem do payload enviado ao modelo.
//
// Antes era `{ ...body, model, stream:false }` — o corpo INTEIRO do chamador
// ia para a API de destino. Isso é mass assignment: quem chama define qualquer
// parâmetro do upstream, inclusive os que só servem para gastar dinheiro
// (max_tokens gigante, n múltiplo). O servidor precisa decidir o que passa.
//
// Fica em módulo próprio porque index.js chama start() ao ser importado, e um
// controle que não dá para testar sem subir o servidor não é testado.

export const CHAT_ALLOWED_FIELDS = [
  'messages', 'tools', 'tool_choice', 'response_format',
  'temperature', 'top_p', 'max_tokens'
];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function buildChatPayload(body, options = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const defaultModel = options.defaultModel || 'deepseek-chat';
  const maxTokensCap = options.maxTokensCap || 16384;

  const payload = {
    // A extensão envia model: "AurexAI"; mapeamos para o modelo real do proxy.
    model: !input.model || input.model === 'AurexAI' ? defaultModel : String(input.model),
    messages: Array.isArray(input.messages) ? input.messages : [],
    // Nunca deixamos o chamador ligar streaming: o proxy lê a resposta inteira.
    stream: false
  };

  if (Array.isArray(input.tools)) payload.tools = input.tools;
  if (input.tool_choice !== undefined) payload.tool_choice = input.tool_choice;
  if (input.response_format !== undefined) payload.response_format = input.response_format;

  // Números vêm com limite: o chamador escolhe dentro da faixa, não além dela.
  if (Number.isFinite(input.temperature)) payload.temperature = clamp(input.temperature, 0, 2);
  if (Number.isFinite(input.top_p)) payload.top_p = clamp(input.top_p, 0, 1);
  if (Number.isFinite(input.max_tokens)) payload.max_tokens = clamp(Math.floor(input.max_tokens), 1, maxTokensCap);

  return payload;
}
