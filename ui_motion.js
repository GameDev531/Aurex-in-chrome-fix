// Animação da interface: transições de painel (GSAP quando presente, CSS
// como plano B) e a revelação progressiva da resposta do modelo.
// Tudo aqui respeita prefers-reduced-motion.

const MotionUI = {
  reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,

  canAnimate() {
    return !this.reduced && typeof gsap !== 'undefined';
  },

  enterMessage(node) {
    if (!this.canAnimate()) return;
    gsap.fromTo(node,
      { autoAlpha: 0, y: 10, scale: 0.985 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.34, ease: 'power2.out', clearProps: 'transform' }
    );
  },

  enterWidget(node) {
    if (!this.canAnimate()) return;
    gsap.fromTo(node,
      { autoAlpha: 0, y: 12, scale: 0.98 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.42, ease: 'power3.out', clearProps: 'transform' }
    );
    gsap.from(node.children, {
      autoAlpha: 0,
      y: 6,
      duration: 0.24,
      delay: 0.08,
      stagger: 0.035,
      ease: 'power2.out',
      clearProps: 'transform'
    });
  },

  dismissWidget(node) {
    if (!node) return;
    // Fallback de segurança: o widget SEMPRE some, mesmo se a animação falhar
    var fallback = setTimeout(function() { if (node.isConnected) node.remove(); }, 700);
    if (!this.canAnimate()) {
      clearTimeout(fallback);
      node.remove();
      return;
    }

    try {
      gsap.to(node, {
        autoAlpha: 0,
        y: -10,
        scale: 0.985,
        height: 0,
        marginTop: 0,
        marginBottom: 0,
        paddingTop: 0,
        paddingBottom: 0,
        duration: 0.42,
        ease: 'power3.inOut',
        overflow: 'hidden',
        onComplete: function() {
          clearTimeout(fallback);
          node.remove();
        }
      });
    } catch (e) {
      clearTimeout(fallback);
      node.remove();
    }
  },

  typeAssistantText(roots) {
    if (!this.canAnimate() || !roots || !roots.length) return;

    const chars = [];
    roots.forEach(function(root) {
      const textNodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (node.parentElement && node.parentElement.closest('.aurex-widget')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      while (walker.nextNode()) textNodes.push(walker.currentNode);

      textNodes.forEach(function(textNode) {
        const fragment = document.createDocumentFragment();
        Array.from(textNode.nodeValue).forEach(function(char) {
          const span = document.createElement('span');
          span.className = 'aurex-typed-char';
          span.textContent = char;
          fragment.appendChild(span);
          chars.push(span);
        });
        textNode.parentNode.replaceChild(fragment, textNode);
      });
    });

    if (!chars.length) return;

    gsap.fromTo(chars,
      { autoAlpha: 0 },
      {
        autoAlpha: 1,
        duration: 0.07,
        stagger: {
          amount: Math.min(3.4, Math.max(0.45, chars.length * 0.012))
        },
        ease: 'power1.out',
        clearProps: 'opacity,visibility',
        onComplete: function() {
          chars.forEach(function(span) {
            if (span.parentNode) {
              span.replaceWith(document.createTextNode(span.textContent));
            }
          });
          roots.forEach(function(root) {
            root.normalize();
          });
        }
      }
    );
  },

  enterTool(node) {
    if (!this.canAnimate()) return;
    gsap.fromTo(node,
      { autoAlpha: 0, x: -8, height: 0 },
      { autoAlpha: 1, x: 0, height: 'auto', duration: 0.32, ease: 'power2.out', clearProps: 'height,transform' }
    );
  },

  completeTool(node, success) {
    if (!this.canAnimate()) return;
    gsap.fromTo(node,
      { borderColor: success ? 'rgba(0,230,138,0.16)' : 'rgba(255,92,92,0.16)' },
      { borderColor: success ? 'rgba(0,230,138,0.52)' : 'rgba(255,92,92,0.52)', duration: 0.24, yoyo: true, repeat: 1 }
    );
  },

  enterServiceStatus(node) {
    if (!this.canAnimate()) return;
    const pulse = node.querySelector('.service-status-pulse');
    gsap.fromTo(node,
      { autoAlpha: 0, y: 10, scale: 0.985 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.36, ease: 'power2.out', clearProps: 'transform' }
    );
    if (pulse) {
      gsap.fromTo(pulse,
        { scale: 0.88, autoAlpha: 0.4 },
        { scale: 1.12, autoAlpha: 1, duration: 0.8, repeat: 1, yoyo: true, ease: 'sine.inOut', clearProps: 'transform' }
      );
    }
  },

  openSkills(panel) {
    if (!this.canAnimate()) return;
    gsap.fromTo(panel,
      { yPercent: 5, autoAlpha: 0 },
      { yPercent: 0, autoAlpha: 1, duration: 0.38, ease: 'power3.out', clearProps: 'transform,opacity,visibility' }
    );
  },

  switchSkillsPanel(panel) {
    if (!this.canAnimate()) return;
    gsap.fromTo(panel,
      { autoAlpha: 0, x: 10 },
      { autoAlpha: 1, x: 0, duration: 0.24, ease: 'power2.out', clearProps: 'transform,opacity,visibility' }
    );
  },

  revealStoreCards(nodes) {
    if (!this.canAnimate() || !nodes || !nodes.length) return;
    gsap.fromTo(nodes,
      { autoAlpha: 0, y: 12, scale: 0.985 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.34, stagger: 0.045, ease: 'power2.out', clearProps: 'transform,opacity,visibility' }
    );
  },

  animateThinking(node) {
    if (!this.canAnimate()) return;
    const orb = node.querySelector('.thinking-orb');
    const dots = node.querySelectorAll('.thinking-dot');
    const bar = node.querySelector('.thinking-bar');
    if (orb) {
      gsap.to(orb, { scale: 1.1, autoAlpha: 0.72, duration: 1.05, repeat: -1, yoyo: true, ease: 'sine.inOut' });
    }
    if (dots.length) {
      gsap.to(dots, { y: -3, autoAlpha: 1, duration: 0.42, repeat: -1, yoyo: true, stagger: 0.12, ease: 'sine.inOut' });
    }
    if (bar) {
      gsap.fromTo(bar,
        { xPercent: -120 },
        { xPercent: 240, duration: 1.35, repeat: -1, ease: 'power1.inOut' }
      );
    }
  }
};

function setupMotion() {
  if (!MotionUI.canAnimate()) return;

  document.body.classList.add('gsap-ready');
  gsap.from('.welcome-screen .greeting, .welcome-screen .input-wrapper', {
    autoAlpha: 0,
    y: 12,
    duration: 0.42,
    stagger: 0.045,
    ease: 'power2.out',
    clearProps: 'transform,opacity,visibility'
  });
  gsap.from('.welcome-screen .skill-btn', {
    y: 8,
    duration: 0.28,
    delay: 0.12,
    stagger: 0.035,
    ease: 'power2.out',
    clearProps: 'transform,opacity,visibility'
  });
}

// ========== STREAMING DA RESPOSTA ==========
//
// O servidor devolve a resposta INTEIRA (stream:false), então não há tokens
// chegando de verdade. Reproduzir isso com máquina de escrever caractere a
// caractere ficaria falso e lento — e a leitura fica pior, porque a palavra
// só faz sentido depois de completa.
//
// Aqui a revelação é por PALAVRA, em blocos que variam com o tamanho do
// texto: resposta curta aparece quase inteira, resposta longa flui. E o
// trecho recém-revelado recebe um realce que apaga sozinho, que é o que dá a
// sensação de "chegando agora" sem precisar animar cada letra.
var AUREX_STREAM_MS = 16;

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (e) { return false; }
}

function streamAssistantMessage(node, content) {
  if (!node || typeof content !== 'string' || !content) return;
  // Widget é HTML sanitizado e montado de uma vez: revelar por partes
  // renderizaria marcação quebrada no meio do caminho.
  if (content.indexOf('<widget>') !== -1) return;

  var alvo = node.querySelector('.message-content .streamable');
  if (!alvo) return;

  if (prefersReducedMotion()) { alvo.classList.remove('streaming'); return; }

  var palavras = content.split(/(\s+)/);
  // Quanto maior a resposta, mais palavras por quadro — senão um texto longo
  // levaria tempo demais e a fluidez viraria espera.
  var porQuadro = Math.max(1, Math.ceil(palavras.length / 120));
  var i = 0;

  alvo.classList.add('streaming');

  function passo() {
    if (i >= palavras.length) {
      alvo.classList.remove('streaming');
      alvo.innerHTML = parseMarkdown(content);
      return;
    }
    i = Math.min(palavras.length, i + porQuadro * 2);
    var parcial = palavras.slice(0, i).join('');
    // Markdown a cada passo mantém listas e código formatados enquanto flui,
    // em vez de mostrar a sintaxe crua e reformatar no fim.
    alvo.innerHTML = parseMarkdown(parcial) + '<span class="stream-cursor"></span>';

    var container = document.getElementById('messages-container');
    if (container) container.scrollTop = container.scrollHeight;
    setTimeout(passo, AUREX_STREAM_MS);
  }

  alvo.innerHTML = '';
  setTimeout(passo, AUREX_STREAM_MS);
}

function appendServiceUnavailableMessage() {
  var container = document.getElementById('messages-container');
  var msgDiv = document.createElement('div');
  msgDiv.className = 'message assistant service-status-message';
  msgDiv.innerHTML = `
    <div class="message-sender">Aurex</div>
    <div class="message-content">
      <div class="service-status-card">
        <span class="service-status-pulse"></span>
        <div class="service-status-copy">
          <strong>Servidor indispon\u00edvel no momento</strong>
          <span>Tente novamente mais tarde.</span>
        </div>
      </div>
    </div>
  `;
  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
  MotionUI.enterServiceStatus(msgDiv);
  return msgDiv;
}
