# Arquitetura — mapa dos arquivos

Quem vai mexer no Aurex precisa saber **onde** mexer. Este documento é o mapa,
e a regra que mantém o mapa válido.

## A regra de carregamento

Todos os scripts do painel são **scripts clássicos** (não módulos ES) listados
em ordem no `popup.html`. Eles compartilham **um único escopo global**: uma
função declarada em `web_tools.js` é visível no `popup.js` e vice-versa.

O que isso exige de quem adiciona um arquivo novo:

- **Declare, não execute.** Um módulo pode declarar funções, `const` e `var` no
  topo. O que ele **não** pode é chamar, no carregamento, algo definido em outro
  arquivo — nessa hora o outro arquivo pode ainda não ter rodado.
- **A inicialização mora num lugar só:** o `DOMContentLoaded` do `popup.js`. É
  ele que chama `setupMotion()`, `setupSettingsPanel()`, `setupPlusMenu()` e
  companhia, na ordem certa.
- **Registre o arquivo no `popup.html`.** Sem isso ele simplesmente não existe —
  e o sintoma é um `ReferenceError` no console, não um erro de build.

Módulos ES resolveriam a ordem sozinhos, mas exigiriam reescrever todos os
arquivos de uma vez. Trocar depois é possível; trocar no meio de uma mudança de
comportamento é como se perde uma tarde procurando regressão.

## Painel (`popup.html`)

| Arquivo | O que vive nele |
|---|---|
| `store_catalog.js` | Catálogo da loja de Skills. Dados puros — cresce por adição. |
| `ui_motion.js` | Transições de painel (GSAP com plano B em CSS) e a revelação progressiva da resposta. Respeita `prefers-reduced-motion`. |
| `activity_log.js` | O feed de atividade: uma linha por ferramenta, o resumo do turno, a seta de detalhes e a evidência de verificação. |
| `docx.js` | Markdown → OOXML → ZIP, sem dependências. Não toca em DOM nem em API do Chrome. |
| `net_guard.js` | **Fronteira de segurança.** Decide o que o `web_fetch` pode alcançar. Arquivo próprio para a regra ficar óbvia numa revisão. |
| `web_tools.js` | Busca (provedor configurável), leitura de página, Google Places. Nenhuma chave embutida. |
| `browser_tools.js` | O despachante: resolve a aba alvo, passa pelo portão de permissão do `background.js` e manda cada ferramenta para o caminho certo. |
| `popup.js` | O resto: prompt do sistema, catálogo `TOOLS`, o laço do agente, e toda a UI de configurações, skills, atalhos e permissões. |
| `sandbox_client.js` | Cliente HTTP do `server/` (sonda, exec, arquivos, serviços). |
| `mcp_client.js` | Cliente MCP (Streamable HTTP) com detecção de troca de descrição de ferramenta. |
| `i18n.js` | Traduções. |

## Fora do painel

| Arquivo | Contexto |
|---|---|
| `background.js` | Service worker. **É aqui que mora o portão de permissão** — e é por isso que ele é um portão de verdade: um content script não alcança este contexto. Também fala CDP via `chrome.debugger`. |
| `content.js` | Injetado nas páginas. Roda com o menor privilégio do conjunto; trate tudo que vem dele como não confiável. |
| `injection_guard.js` | Varredura de conteúdo escondido nas leituras de página. |
| `permission_manager.js` | Estado das permissões concedidas. |
| `workflow_recorder.js` | Gravação de fluxos. |
| `server/` | Backend Node: proxy de chat, autenticação e a sandbox Docker. |

## Sobre separar arquivos e segurança

Vale dizer o que a separação **não** faz, para ninguém contar com o que não
existe: uma extensão é entregue em texto puro na máquina do usuário. Com 1
arquivo ou com 20, qualquer pessoa abre `chrome://extensions`, carrega
descompactada e edita o que quiser. Dividir arquivos ajuda a **manter** o
código, não a escondê-lo.

O que protege de verdade é a **separação de privilégio** — colocar a decisão
num contexto que o atacante não alcança:

- o portão de permissão roda no service worker, fora do alcance da página;
- a `Content-Security-Policy` do `manifest.json` proíbe script inline e remoto
  no painel;
- as chaves do usuário nunca entram no histórico enviado ao modelo;
- conteúdo de terceiro chega ao modelo marcado com nonce por conversa
  (`wrapUntrustedToolResult`), separando instrução de dado;
- o `net_guard.js` corta a rede interna antes de o `fetch` sair.

## Testes

`node tests/run.js`. Os testes leem os arquivos de origem e extraem blocos por
marcador de texto (`extractBlock`), avaliando-os com as APIs do Chrome
simuladas. **Consequência prática:** ao mover uma função para outro arquivo,
atualize o nome do arquivo no teste que a extrai. O teste falha alto e claro
("Marcador inicial não encontrado"), então não passa batido.

`npm run check` roda `node --check` em todo `*.js` da raiz que não seja
minificado — não há lista para manter à mão.
