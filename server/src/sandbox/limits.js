// Limites por usuário: concorrência e taxa.
// Em memória por processo — com múltiplas instâncias do servidor isto vira
// limite por instância, e a contagem precisaria migrar para o Postgres.
import { sandboxError } from './errors.js';

const running = new Map();   // ownerKey -> quantidade em execução
const recentRuns = new Map(); // ownerKey -> timestamps

export function acquireSlot(ownerKey, maxConcurrent) {
  const current = running.get(ownerKey) || 0;
  if (current >= maxConcurrent) {
    throw sandboxError('too_many_concurrent',
      'Voce ja tem ' + current + ' execucao(oes) em andamento. Aguarde terminar antes de iniciar outra.');
  }
  running.set(ownerKey, current + 1);

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const value = (running.get(ownerKey) || 1) - 1;
    if (value <= 0) running.delete(ownerKey);
    else running.set(ownerKey, value);
  };
}

export function checkRateLimit(ownerKey, ratePerMin) {
  const now = Date.now();
  const windowStart = now - 60000;
  const timestamps = (recentRuns.get(ownerKey) || []).filter((t) => t > windowStart);

  if (timestamps.length >= ratePerMin) {
    const retryAfter = Math.max(1000, timestamps[0] + 60000 - now);
    throw sandboxError('rate_limited',
      'Limite de ' + ratePerMin + ' execucoes por minuto atingido. Tente novamente em ' +
      Math.ceil(retryAfter / 1000) + 's.');
  }

  timestamps.push(now);
  recentRuns.set(ownerKey, timestamps);
}
