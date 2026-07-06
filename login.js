// ========== AUREX LOGIN ==========
// Fluxo de conexão de conta em duas etapas:
//   1. Consentimento (estilo OAuth). Se um servidor Aurex estiver configurado
//      e o modo local estiver desligado, o token real vem do backend via
//      chrome.identity (feito pelo popup). Aqui gravamos a sessão do navegador.
//   2. Nome do usuário + aviso de beta. O nome é usado na saudação e no chat
//      ("Boa noite, Paulo") — nunca é fixo.

document.addEventListener('DOMContentLoaded', function () {
  var stepConsent = document.getElementById('step-consent');
  var stepName = document.getElementById('step-name');
  var btnAuthorize = document.getElementById('btn-authorize');
  var btnCancel = document.getElementById('btn-cancel');
  var btnStart = document.getElementById('btn-start');
  var nameInput = document.getElementById('user-name');
  var statusEl = document.getElementById('status');

  function showStatus(msg) {
    statusEl.textContent = msg;
    statusEl.style.display = 'block';
  }

  function closeTab() {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.getCurrent) {
      chrome.tabs.getCurrent(function (tab) {
        if (tab && tab.id) chrome.tabs.remove(tab.id);
        else window.close();
      });
    } else {
      window.close();
    }
  }

  btnAuthorize.addEventListener('click', function () {
    // Avança para a etapa do nome. A sessão só é gravada no "Começar".
    stepConsent.classList.remove('active');
    stepName.classList.add('active');
    setTimeout(function () { nameInput.focus(); }, 50);
  });

  function finishLogin() {
    var name = (nameInput.value || '').trim();
    if (!name) {
      nameInput.style.borderColor = '#ff6b6b';
      nameInput.focus();
      return;
    }

    var session = {
      accessToken: 'session-' + Date.now(),
      refreshToken: 'session-refresh',
      accessTokenExpiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30,
      user: { name: name, org: 'Orvion Labs' }
    };

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        aurex_auth_tokens: session,
        aurex_user_name: name,
        aurex_onboarded: true
      }, function () {
        showStatus('Bem-vindo(a), ' + name + '! Abra o painel do Aurex para começar.');
        setTimeout(closeTab, 1400);
      });
    } else {
      showStatus('Armazenamento indisponível neste contexto.');
    }
  }

  btnStart.addEventListener('click', finishLogin);
  nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') finishLogin();
  });
  nameInput.addEventListener('input', function () {
    nameInput.style.borderColor = '';
  });

  btnCancel.addEventListener('click', closeTab);
});
