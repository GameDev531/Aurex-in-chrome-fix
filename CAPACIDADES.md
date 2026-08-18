# Aurex in Chrome — o que ele faz, e o que não faz

## Em uma frase

Um agente que **opera o seu navegador**: lê páginas (inclusive dentro de
iframes), navega, clica e preenche formulários **verificando cada ação**,
pesquisa na web, consulta APIs oficiais como o Google Maps, e — quando você
liga a sandbox — executa Python, Node e shell num container isolado no
servidor para gerar planilhas, documentos Word, PDFs e apresentações, que ele
então **baixa pelo navegador** para a sua pasta de downloads.

---

## O que ele consegue fazer

### 1. Operar páginas com verificação real

A diferença que mais importa: ele **não diz "pronto" sem ter conferido**.

- Lê a página pela árvore de acessibilidade, **incluindo conteúdo dentro de
  iframes** — o que costuma travar agentes em ambientes de estudo, visualizadores
  de PDF e checkouts.
- Encontra elementos por descrição natural ("o botão de login") com pontuação de
  confiança, e avisa quando há mais de um candidato parecido.
- Depois de clicar ou digitar, **confirma que algo mudou de fato** (a URL mudou?
  o texto entrou mesmo no campo?) e sabe **esperar** uma condição acontecer.
- Você vê essa verificação na tela, em cada passo: *"Verificado: a URL mudou
  para X"*, *"Nenhuma mudança detectada na página"*. Dá para auditar o que ele
  afirma ter feito.
- Navega entre abas, preenche formulários, rola a página, tira capturas.

### 2. Buscar e consultar informação

- Pesquisa na internet pelo provedor que você escolher (Gemini, Brave, Tavily
  ou Serper), com a sua chave.
- Lê o conteúdo de uma página sem precisar abrir aba.
- Consulta o **Google Places API (New)** para endereços, estabelecimentos,
  horários e avaliações — dados oficiais, não raspagem do site do Maps.
- Chama qualquer API que você cadastrar em Configurações.

### 3. Executar código e produzir arquivos *(opcional)*

Se você ligar a sandbox no servidor Aurex:

- Executa **Python, Node e shell** num container Linux isolado e descartável.
- Gera **arquivos de verdade**: `.docx`, `.xlsx`, `.pptx`, `.pdf`, gráficos —
  além de processar dados e converter formatos.
- O diretório de trabalho **persiste durante a conversa**: um script escrito
  numa mensagem pode ser corrigido e reexecutado na seguinte.
- **Como o arquivo chega até você:** ele é gerado no servidor, e a extensão o
  baixa pelo navegador (o mesmo mecanismo de qualquer download) para a sua
  pasta de downloads. Não há mágica nem agente instalado na sua máquina.

### 4. Como ele trabalha

- Ciclo *entender → planejar → executar → observar → verificar → corrigir*.
- Modos de operação: **Plano** (mostra o plano e espera aprovação), **Normal**,
  **Rápido** e **Autônomo**.
- Permissão por site, pedida num banner acima do chat, válida só na sessão.
- Chat temporário (não vai para o histórico), skills instaláveis, atalhos.

---

## O que ele NÃO faz

Isto é tão importante quanto a lista acima — e é onde muitos produtos exageram.

- **Não acessa seus arquivos, não executa comandos na sua máquina e não vê suas
  senhas salvas ou histórico de navegação.** Ele controla o *navegador* (que
  está no seu computador), mas não tem acesso ao sistema. Toda execução de
  código acontece num container no servidor — nunca localmente.
- **Não burla proteção anti-bot.** Em sites com CAPTCHA, verificação de
  comportamento ou bloqueio de automação, ele pode simplesmente **não
  funcionar** ou precisar que você resolva o desafio manualmente. Não fazemos
  falsificação de impressão digital nem resolução automática de CAPTCHA — onde
  existe API oficial, usamos a API oficial.
- **Não age sem permissão** em um site novo: ele pausa e pergunta.
- **Não inventa capacidade que não tem.** Se a sandbox está desligada, se uma
  chave não está configurada ou se uma ação falhou, ele diz.

---

## Requisitos

| Recurso | Precisa de quê |
|---|---|
| Operar páginas, verificar ações | Nada além da extensão |
| Busca na web | Sua chave de um provedor de busca |
| Google Maps / lugares | Sua chave do Google Places API (New) |
| Executar código e gerar arquivos | Servidor Aurex com Docker e sandbox ligada |

O servidor pode ser **o seu próprio**, rodando em `127.0.0.1` — é a configuração
padrão recomendada para quem não quer que os dados saiam da própria máquina.
Basta apontar o endereço em **Configurações ▸ Geral ▸ Servidor**; chat, login e
sandbox passam a usar esse endereço.

As chaves de busca e de mapas ficam **apenas no seu navegador** e são enviadas
somente ao serviço dono delas. O valor da chave é removido de qualquer resposta
antes de chegar ao modelo.
