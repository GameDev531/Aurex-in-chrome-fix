export class PermissionManager {
  static _memoryFallback = [];

  // Duas listas com tempos de vida diferentes:
  // - sessão (chrome.storage.session): "só desta vez", some ao fechar o Chrome
  // - permanente (chrome.storage.local): "sempre permitir", escolha explícita
  //   do usuário e revogável nas Configurações
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

  static async getPersistentAllowlist() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['aurex_trusted_origins'], (result) => {
        resolve((result && result.aurex_trusted_origins) || []);
      });
    });
  }

  static async trustOriginForever(origin) {
    if (!origin || origin === 'null') return;
    const trusted = await this.getPersistentAllowlist();
    if (!trusted.includes(origin)) {
      trusted.push(origin);
      await new Promise((resolve) => {
        chrome.storage.local.set({ aurex_trusted_origins: trusted }, resolve);
      });
    }
  }

  static async untrustOrigin(origin) {
    const trusted = await this.getPersistentAllowlist();
    const next = trusted.filter((o) => o !== origin);
    await new Promise((resolve) => {
      chrome.storage.local.set({ aurex_trusted_origins: next }, resolve);
    });
  }

  static async checkPermission(origin) {
    // Origem vazia ou opaca já foi liberada aqui ("local files might have null
    // origin"), o que abria uma exceção justamente para o caso mais sensível:
    // uma página file:// é um arquivo do usuário. Sem origem utilizável a
    // resposta é NÃO, e quem chamou pede permissão com um rótulo estável.
    if (!origin || origin === 'null') return false;
    const trusted = await this.getPersistentAllowlist();
    if (trusted.includes(origin)) return true;
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

  // Intercepta a chamada no background e avisa o popup caso não tenha permissão.
  // Resolve com { granted, reason } — 'granted' | 'denied' | 'pending' | 'no-panel'.
  // NUNCA nega por conta própria enquanto o usuário ainda pode decidir: o agente
  // deve ficar aguardando, não desistir da tarefa.
  static async requirePermission(tabId, origin) {
    const hasPerm = await this.checkPermission(origin);
    if (hasPerm) return { granted: true, reason: 'granted' };

    // Se já existe um pedido pendente para esta origem, não abre outro:
    // reaproveita o mesmo (evita banners duplicados e pedidos concorrentes).
    if (this.pendingResolvers[origin]) {
      return new Promise((resolve) => {
        this.pendingResolvers[origin].waiters.push(resolve);
      });
    }

    // SECURITY FIX: Token imprevisível
    const token = crypto.randomUUID();

    console.warn(`[Aurex PermissionManager] Acesso pausado para a origem: ${origin}. Aguardando decisão do usuário...`);

    return new Promise((resolve) => {
      // Janela generosa para o usuário decidir. Ao expirar NÃO negamos: o
      // agente é avisado de que a decisão ainda está pendente e deve aguardar.
      const timeoutId = setTimeout(() => {
        this._settle(origin, { granted: false, reason: 'pending' });
      }, 10 * 60 * 1000);

      this.pendingResolvers[origin] = {
        waiters: [resolve],
        token: token,
        timeoutId: timeoutId
      };
      this._startKeepalive();

      chrome.runtime.sendMessage({
        type: "permission_required",
        origin: origin,
        tabId: tabId,
        token: token
      }, (response) => {
        const err = chrome.runtime.lastError;
        if (!err) return; // Painel recebeu e confirmou: seguimos aguardando o clique

        // "Receiving end does not exist" = nenhum listener, painel fechado.
        // Outros erros (ex: porta fechada sem resposta) NÃO significam ausência
        // de painel — nesse caso continuamos aguardando a decisão do usuário.
        if ((err.message || '').includes('Receiving end does not exist')) {
          this._settle(origin, { granted: false, reason: 'no-panel' });
        }
      });
    });
  }

  static _settle(origin, result) {
    const pending = this.pendingResolvers[origin];
    if (!pending) return;
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    delete this.pendingResolvers[origin];
    pending.waiters.forEach((resolve) => resolve(result));
    if (Object.keys(this.pendingResolvers).length === 0) this._stopKeepalive();
  }

  static resolvePending(origin, granted = true) {
    this._settle(origin, { granted: granted, reason: granted ? 'granted' : 'denied' });
  }
}
