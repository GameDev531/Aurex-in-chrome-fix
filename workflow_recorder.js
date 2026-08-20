export class WorkflowRecorder {
  static isRecording = false;
  static currentWorkflow = [];
  static activeTabId = null;

  static async startRecording(tabId) {
    this.isRecording = true;
    this.currentWorkflow = [];
    this.activeTabId = tabId;
    
    console.log("[Aurex Recorder] Iniciando gravação...");

    // Injeta script espião na aba para capturar cliques e inputs humanos
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        window.__aurexRecorderActive = true;
        
        // Helper para gerar um CSS Path razoavelmente único
        function getCssPath(el) {
          if (!(el instanceof Element)) return;
          var path = [];
          while (el.nodeType === Node.ELEMENT_NODE) {
            var selector = el.nodeName.toLowerCase();
            if (el.id) {
              selector += '#' + el.id;
              path.unshift(selector);
              break;
            } else {
              var sib = el, nth = 1;
              while (sib = sib.previousElementSibling) {
                if (sib.nodeName.toLowerCase() == selector) nth++;
              }
              if (nth != 1) selector += ":nth-of-type("+nth+")";
            }
            path.unshift(selector);
            el = el.parentNode;
          }
          return path.join(" > ");
        }

        // Âncoras redundantes do elemento. Um caminho CSS sozinho quebra ao
        // primeiro rename de classe ou mudança de layout — a causa nº1 de
        // falha de replay em produção. Guardamos várias formas de reencontrar
        // o mesmo elemento e o replay tenta na ordem da mais estável.
        function describeTarget(el) {
          if (!(el instanceof Element)) return {};
          var label = el.getAttribute('aria-label') ||
            (el.labels && el.labels[0] && el.labels[0].innerText) || '';
          return {
            selector: getCssPath(el),
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            nameAttr: el.getAttribute('name') || null,
            testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || null,
            role: el.getAttribute('role') || null,
            type: el.getAttribute('type') || null,
            placeholder: el.getAttribute('placeholder') || null,
            ariaLabel: label ? String(label).trim().substring(0, 80) : null,
            text: (el.innerText || el.value || '').trim().substring(0, 80) || null,
            url: location.href
          };
        }

        document.addEventListener('click', (e) => {
          if (!window.__aurexRecorderActive) return;
          chrome.runtime.sendMessage({
            type: "recorder_event",
            event: Object.assign({ type: "click", timestamp: Date.now() }, describeTarget(e.target))
          });
        }, true);

        document.addEventListener('change', (e) => {
          if (!window.__aurexRecorderActive) return;
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            chrome.runtime.sendMessage({
              type: "recorder_event",
              event: Object.assign(
                { type: "type", value: e.target.value, timestamp: Date.now() },
                describeTarget(e.target)
              )
            });
          }
        }, true);
      }
    });
  }

  static async stopRecording() {
    this.isRecording = false;
    if (this.activeTabId) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: this.activeTabId },
          func: () => { window.__aurexRecorderActive = false; }
        });
      } catch (e) { /* Tab might be closed */ }
    }
    console.log("[Aurex Recorder] Gravação parada. Total de passos:", this.currentWorkflow.length);
    return this.currentWorkflow;
  }

  static recordEvent(event) {
    if (this.isRecording) {
      this.currentWorkflow.push(event);
      console.log("[Aurex Recorder] Passo salvo:", event);
    }
  }

  // Formato único de workflow. Antes havia duas gravações incompatíveis
  // (um array cru aqui e um objeto no popup), e nada lia de volta.
  static buildWorkflow(name, steps, extra) {
    return Object.assign({
      version: 1,
      name: name,
      steps: (steps || []).map(function (step, index) {
        return {
          index: index,
          type: step.type,          // 'click' | 'type'
          selector: step.selector,
          value: step.value,
          url: step.url || null,
          timestamp: step.timestamp,
          // Âncoras de reserva contra deriva de seletor
          tag: step.tag || null,
          id: step.id || null,
          nameAttr: step.nameAttr || null,
          testId: step.testId || null,
          role: step.role || null,
          placeholder: step.placeholder || null,
          ariaLabel: step.ariaLabel || null,
          text: step.text || null
        };
      }),
      narration: '',
      createdAt: Date.now()
    }, extra || {});
  }

  static async saveWorkflow(name, extra) {
    const workflow = this.buildWorkflow(name, this.currentWorkflow, extra);
    return new Promise((resolve) => {
      chrome.storage.local.get(['aurex_workflows'], (result) => {
        const workflows = result.aurex_workflows || {};
        workflows[name] = workflow;
        chrome.storage.local.set({ aurex_workflows: workflows }, () => resolve(workflow));
      });
    });
  }

  static async listWorkflows() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['aurex_workflows'], (result) => {
        const stored = (result && result.aurex_workflows) || {};
        // Migração silenciosa do formato antigo (array cru ou objeto sem version)
        const normalized = Object.keys(stored).map((name) => {
          const value = stored[name];
          if (Array.isArray(value)) return this.buildWorkflow(name, value);
          if (!value.version) return this.buildWorkflow(name, value.steps || [], { narration: value.narration || '', createdAt: value.createdAt });
          return value;
        });
        resolve(normalized);
      });
    });
  }

  static async getWorkflow(name) {
    const all = await this.listWorkflows();
    return all.find((w) => w.name === name) || null;
  }

  static async deleteWorkflow(name) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['aurex_workflows'], (result) => {
        const workflows = (result && result.aurex_workflows) || {};
        delete workflows[name];
        chrome.storage.local.set({ aurex_workflows: workflows }, resolve);
      });
    });
  }

  static async updateWorkflow(name, workflow) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['aurex_workflows'], (result) => {
        const workflows = (result && result.aurex_workflows) || {};
        workflows[name] = Object.assign({}, workflow, { name: name, version: 1 });
        chrome.storage.local.set({ aurex_workflows: workflows }, () => resolve(workflows[name]));
      });
    });
  }
}
