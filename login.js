// ========== AUREX LOGIN (mockup de consentimento) ==========
// Tela de conexão de conta no estilo do consentimento OAuth.
// Por enquanto é um mockup visual: "Autorizar" grava um usuário de exemplo
// e fecha a aba. Quando o backend de auth estiver pronto, plugar aqui o fluxo
// real chamando loginAurexChrome() (definido em popup.js) via mensagem ao
// background, ou redirecionando para chrome.identity.launchWebAuthFlow.

document.addEventListener('DOMContentLoaded', function () {
  var btnAuthorize = document.getElementById('btn-authorize');
  var btnCancel = document.getElementById('btn-cancel');
  var statusEl = document.getElementById('status');

  function showStatus(msg) {
    statusEl.textContent = msg;
    statusEl.style.display = 'block';
  }

  btnAuthorize.addEventListener('click', function () {
    // MOCKUP: grava um usuário de exemplo. Substituir pelo OAuth real quando
    // o backend (loginAurexChrome em popup.js) estiver disponível.
    var fakeUser = {
      accessToken: 'mock-' + Date.now(),
      refreshToken: 'mock-refresh',
      accessTokenExpiresAt: Date.now() + 1000 * 60 * 60 * 24,
      user: { name: 'Giovanni', org: 'Orvion Labs', email: 'demo@orvionlabs.com' }
    };

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ aurex_auth_tokens: fakeUser }, function () {
        showStatus('Conta conectada com sucesso. Você já pode fechar esta aba.');
        setTimeout(function () {
          if (chrome.tabs) {
            chrome.tabs.getCurrent(function (tab) {
              if (tab && tab.id) chrome.tabs.remove(tab.id);
            });
          } else {
            window.close();
          }
        }, 1200);
      });
    } else {
      showStatus('Armazenamento indisponível neste contexto.');
    }
  });

  btnCancel.addEventListener('click', function () {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.getCurrent) {
      chrome.tabs.getCurrent(function (tab) {
        if (tab && tab.id) chrome.tabs.remove(tab.id);
        else window.close();
      });
    } else {
      window.close();
    }
  });
});
