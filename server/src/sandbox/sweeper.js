// Limpeza periódica: workspaces expirados viram lixo em disco se ninguém
// recolher. Roda a cada 10 minutos enquanto o servidor estiver de pé.
import { listExpiredSandboxSessions, deleteSandboxSession } from '../db.js';
import { destroyWorkspace, workspacePathFor } from './workspace.js';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export function startSandboxSweeper(cfg) {
  async function sweep() {
    try {
      const expired = await listExpiredSandboxSessions();
      for (const session of expired) {
        try {
          await destroyWorkspace(workspacePathFor(cfg, session.ownerKey, session.id));
        } catch (err) {
          console.warn('[Aurex Sandbox] Falha ao apagar workspace', session.id, err.message);
        }
        await deleteSandboxSession(session.id);
      }
      if (expired.length) {
        console.log(`[Aurex Sandbox] ${expired.length} workspace(s) expirado(s) removido(s).`);
      }
    } catch (err) {
      console.warn('[Aurex Sandbox] Sweeper falhou:', err.message);
    }
  }

  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref(); // não segura o processo
  sweep();
  return timer;
}
