export class PermissionManager {
  static _memoryFallback = [];

  static async getAllowlist() {
    return new Promise((resolve) => {
      if (chrome.storage.session) {
        chrome.storage.session.get(['aurex_allowed_origins'], (result) => {
          resolve(result.aurex_allowed_origins || []);
        });
      } else {
        resolve(this._memoryFallback);
      }
    });
  }

  static async checkPermission(origin) {
    if (!origin || origin === 'null') return true; // Local files or extensions might have null origin
    const allowlist = await this.getAllowlist();
    return allowlist.includes(origin);
  }

  static async grantPermission(origin) {
    if (!origin || origin === 'null') return;
    const allowlist = await this.getAllowlist();
    if (!allowlist.includes(origin)) {
      allowlist.push(origin);
      if (chrome.storage.session) {
        return new Promise((resolve) => {
          chrome.storage.session.set({ aurex_allowed_origins: allowlist }, resolve);
        });
      } else {
        this._memoryFallback = allowlist;
      }
    }
  }

  static async revokePermission(origin) {
    const allowlist = await this.getAllowlist();
    const newList = allowlist.filter(o => o !== origin);
    if (chrome.storage.session) {
      return new Promise((resolve) => {
        chrome.storage.session.set({ aurex_allowed_origins: newList }, resolve);
      });
    } else {
      this._memoryFallback = newList;
    }
  }

  static pendingResolvers = {};
  static _keepaliveTimer = null;

  // O service worker MV3 é morto após ~30s ocioso. Enquanto houver uma
  // permissão pendente (esperando o clique do usuário), fazemos chamadas
  // periódicas a uma API do Chrome para resetar o timer de idle — senão o
  // worker morre, o pendingResolvers some e o banner "congela".
  static _startKeepalive() {
    if (this._keepaliveTimer) return;
    this._keepaliveTimer = setInterval(() => {
      if (Object.keys(this.pendingResolvers).length === 0) {
        this._stopKeepalive();
        return;
      }
      try { chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; }); } catch (e) { /* ignore */ }
    }, 20000);
  }

  static _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  // Intercepta a chamada no background e avisa o popup caso não tenha permissão
  static async requirePermission(tabId, origin) {
    const hasPerm = await this.checkPermission(origin);
    if (hasPerm) return true;

    // SECURITY FIX: Token imprevisível
    const token = crypto.randomUUID();

    console.warn(`[Aurex PermissionManager] Acesso pausado para a origem: ${origin}. Aguardando aprovação do usuário...`);

    // Pausa a execução do agente retornando uma Promise que só resolve quando o usuário clicar
    return new Promise((resolve) => {
      // Timeout de segurança: se ninguém decidir em 5 minutos, nega e libera
      // o agente em vez de travar a tarefa para sempre.
      const timeoutId = setTimeout(() => {
        this.resolvePending(origin, false);
      }, 5 * 60 * 1000);

      this.pendingResolvers[origin] = {
        resolve: resolve,
        token: token,
        timeoutId: timeoutId
      };
      this._startKeepalive();

      // Registra o pending request antes de expor a aprovação ao popup.
      chrome.runtime.sendMessage({
        type: "permission_required",
        origin: origin,
        tabId: tabId,
        token: token
      }, () => {
        // Painel fechado (sem listener): falha rápido em vez de pendurar a tarefa
        if (chrome.runtime.lastError) {
          this.resolvePending(origin, false);
        }
      });
    });
  }

  static resolvePending(origin, granted = true) {
    if (this.pendingResolvers[origin]) {
      if (this.pendingResolvers[origin].timeoutId) {
        clearTimeout(this.pendingResolvers[origin].timeoutId);
      }
      this.pendingResolvers[origin].resolve(granted);
      delete this.pendingResolvers[origin];
    }
    if (Object.keys(this.pendingResolvers).length === 0) this._stopKeepalive();
  }
}
