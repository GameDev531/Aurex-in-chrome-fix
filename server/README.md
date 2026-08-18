# Aurex Server

Backend do **Aurex in Chrome**: autenticação OAuth (PKCE + Google) e o endpoint
de chat `/v1/chat/completions` usado pela extensão.

## Como rodar

```bash
cd server
npm install
cp .env.example .env   # edite os valores
npm start
```

O servidor sobe em `http://127.0.0.1:3000` (ou a porta do `.env`).

Na extensão, abra **Configurações ▸ Geral ▸ Servidor** e informe o endereço
(ex: `http://127.0.0.1:3000` — o sufixo `/v1` é adicionado automaticamente).
Para usar sem login OAuth, ative **"Servidor local (sem login)"** ou cole uma
chave de `AUREX_API_KEYS` no campo de chave da API.

## Variáveis do .env

| Variável | Descrição |
|---|---|
| `PORT` | Porta HTTP do servidor (padrão 3000) |
| `DATABASE_URL` | Postgres. Sem ela, usa armazenamento em memória (dev) |
| `DATABASE_SSL` | `true` para conexões Postgres com SSL |
| `AUREX_PUBLIC_BASE_URL` | URL pública do servidor (usada nos redirects OAuth) |
| `AUREX_JWT_SECRET` | Segredo dos tokens JWT — troque em produção |
| `GOOGLE_CLIENT_ID/SECRET` | Credenciais OAuth do Google. Sem elas, o login vira um formulário de desenvolvimento (nome + email) |
| `GOOGLE_REDIRECT_URI` | Callback do Google (ex: `https://api.aurexai.com/auth/google/callback`) |
| `DEEPSEEK_API_KEY` | Chave do modelo temporário (proxy DeepSeek) |
| `AUREX_API_KEYS` | Chaves legado/admin aceitas no Bearer, separadas por vírgula |

## Endpoints

- `GET /health` — status (banco e modelo configurados)
- `GET /auth/login?state&code_challenge&redirect_uri` — inicia o fluxo PKCE
- `GET /auth/google/callback` — callback do Google
- `POST /auth/token` — `{ code, code_verifier, redirect_uri }` → tokens
- `POST /auth/refresh` — `{ refreshToken }` → tokens renovados
- `POST /auth/logout` — `{ refreshToken }` → revoga a sessão
- `POST /v1/chat/completions` — corpo compatível com OpenAI (messages, tools);
  `model: "AurexAI"` é mapeado para o modelo real do proxy

## Segurança

- Access token JWT expira em 1h; refresh token opaco expira em 30 dias e é
  rotacionado a cada renovação.
- PKCE S256 verificado no `/auth/token`.
- Sem `AUREX_API_KEYS` configurado e sem token, o `/v1` fica aberto **apenas
  para desenvolvimento local** — configure chaves em produção.

---

## Sandbox de código (execução em container)

Permite que o Aurex execute Python, Node e shell para **produzir arquivos de
verdade** (.docx, .xlsx, .pptx, .pdf, gráficos) e processar dados.

> **Importante:** a sandbox roda **no servidor**, não no computador do usuário.
> Uma extensão Chrome não pode criar processos — por isso a execução vive aqui.

### Como ligar

```bash
# 1. Construir a imagem (uma vez; leva alguns minutos)
./sandbox/build.sh

# 2. Configurar o .env
AUREX_SANDBOX_ENABLED=true
AUREX_API_KEYS=<uma-chave-forte>          # obrigatório
AUREX_JWT_SECRET=<segredo-aleatorio-longo> # obrigatório
AUREX_BIND_HOST=127.0.0.1

# 3. Subir
npm start
```

Na extensão, cole a mesma chave em **Configurações ▸ Geral ▸ Servidor** (campo
"Chave da API"). Sem ela, a execução é recusada.

### Travas de segurança

A sandbox executa código decidido por um modelo que lê páginas da web — ou seja,
uma injeção de prompt numa página é uma tentativa de execução remota. Por isso:

1. Nasce **desligada** (`AUREX_SANDBOX_ENABLED=false`). Desligada, as rotas nem
   são registradas (404, não 403).
2. O servidor **se recusa a subir** (`exit 1`) se a sandbox estiver ligada e:
   `AUREX_API_KEYS` estiver vazio; `AUREX_JWT_SECRET` for o valor de exemplo;
   o bind for público sem `AUREX_SANDBOX_ALLOW_PUBLIC_BIND=true`; ou o processo
   estiver rodando como root sem `AUREX_SANDBOX_ALLOW_ROOT=true`.
3. Execução **nunca** aceita chamador anônimo, mesmo que o `/chat` aceite.
4. O bind agora é `127.0.0.1` por padrão — antes o servidor escutava em todas as
   interfaces apesar do log dizer o contrário.

### Isolamento

Cada execução roda num container descartável com `--network none`, usuário sem
privilégios, rootfs read-only, `--cap-drop ALL`, `no-new-privileges`, limites de
memória/CPU/PIDs e timeout duplo (dentro e fora do container). O comando do
usuário viaja como argumento de argv, nunca interpolado numa string de shell.

O workspace de cada conversa é um diretório persistente montado em `/work`.

**Sobre instalar pacotes — leia com atenção:** `PIP_USER` e `NPM_CONFIG_PREFIX`
apontam para dentro de `/work`, o que garante que um pacote instalado **sobreviva
ao descarte do container**. Isso resolve a *persistência*, não o *download*: com
`--network none` (o padrão), `pip install` **falha**, porque não há como alcançar
o PyPI. Ou seja:

| Configuração | `pip install` baixa? | Pacote sobrevive entre execuções? |
|---|---|---|
| `AUREX_SANDBOX_ALLOW_NETWORK=false` (padrão) | Não | — |
| `AUREX_SANDBOX_ALLOW_NETWORK=true` | Sim | Sim |

Por isso a imagem já traz as bibliotecas que cobrem os casos de uso previstos
(documentos, planilhas, PDFs, gráficos, dados). Se você precisa de algo fora
dessa lista, tem duas saídas: **adicionar ao `requirements.txt` e reconstruir a
imagem** (recomendado — mantém o container sem rede), ou ligar
`AUREX_SANDBOX_ALLOW_NETWORK=true` aceitando o risco descrito abaixo.

### Limitações honestas

- **Sem rede no container, por padrão.** O que a imagem não trouxer, não roda —
  inclusive `pip install`. Isso é deliberado: o container processa conteúdo lido
  de páginas web, e dar saída de rede a ele criaria um canal de exfiltração.
  Ligar a rede hoje é tudo-ou-nada (bridge padrão do Docker), o que também dá ao
  container acesso à sua rede local. Uma allowlist só para PyPI/npm via proxy de
  egresso é o próximo passo natural, e ainda **não** está implementada.
- **Pertencer ao grupo `docker` equivale a root no host.** Se o processo Node
  for comprometido, o isolamento do *sandbox* não protege o *host*. A mitigação
  real é **Docker rootless** — motivo pelo qual a sandbox nasce desligada e se
  recusa a subir junto com autenticação anônima.
- **Execução síncrona** com timeout (padrão 120 s, máximo configurável). Builds
  muito longos não são o caso de uso desta versão.
- Jobs não sobrevivem a um restart do servidor; containers órfãos são varridos
  no boot.

### Endpoints

| Método | Rota | Função |
|---|---|---|
| POST | `/v1/sandbox/sessions/:sid/exec` | executa comando ou código |
| GET | `/v1/sandbox/sessions/:sid/files` | lista o workspace |
| GET | `/v1/sandbox/sessions/:sid/files/content` | lê um arquivo |
| POST | `/v1/sandbox/sessions/:sid/files` | grava um arquivo |
| GET | `/v1/sandbox/sessions/:sid/files/raw` | baixa um artefato |
| DELETE | `/v1/sandbox/sessions/:sid` | destrói o workspace |
| GET | `/v1/sandbox/health` | estado detalhado (autenticado) |

O `GET /health` (sem autenticação) já traz um bloco `sandbox` com
`enabled`/`ready`/`reason` — é o que a extensão sonda para saber se pode
oferecer as ferramentas ao modelo.
