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
