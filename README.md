# ControlCheck API

API REST para sincronização entre os apps **ControlCheck** (desktop + mobile) e **KMCheck**, com banco PostgreSQL compartilhado.

## Arquitetura

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   KMCheck   │     │ ControlCheck │     │ ControlCheck │
│   (Campo)   │     │   (Mobile)   │     │  (Desktop)   │
└──────┬──────┘     └──────┬───────┘     └──────┬───────┘
       └───────────────────┼────────────────────┘
                    ┌──────▼──────┐
                    │  SERVIDOR   │
                    │  Docker     │
                    │  ├ PostgreSQL
                    │  ├ API Node.js
                    │  └ Nginx
                    └─────────────┘
```

## Deploy rápido (no servidor)

```bash
# 1. Conectar no servidor
ssh root@SEU_IP

# 2. Rodar o deploy automático
curl -sSL https://raw.githubusercontent.com/wagnerxm/controlmed-api/main/deploy.sh | bash
```

Pronto! O script instala Docker, clona o projeto, configura o banco e sobe tudo.

## Endpoints

| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| POST | `/api/auth/register` | Criar usuário | ❌ |
| POST | `/api/auth/login` | Login | ❌ |
| GET | `/api/auth/me` | Dados do logado | ✅ |
| POST | `/api/sync/pull` | Puxar dados | ✅ |
| POST | `/api/sync/push` | Enviar dados | ✅ |
| GET | `/api/sync/status` | Status da sync | ✅ |
| GET | `/api/rodovias` | Listar rodovias | ❌ |
| GET | `/api/rodovias/:br/:uf` | Geometria | ❌ |
| POST | `/api/rodovias/bulk` | Importar SNV | ✅ Admin |
| POST | `/api/upload/photo` | Upload de foto | ✅ |
| GET | `/api/upload/:file` | Servir foto | ❌ |
| GET | `/api/health` | Health check | ❌ |

## Desenvolvimento local

```bash
# Instalar dependências
npm install

# Subir PostgreSQL local
docker compose up postgres -d

# Rodar em dev
cp .env.example .env
npm run dev
```

## Variáveis de ambiente (.env)

| Variável | Descrição |
|----------|-----------|
| `POSTGRES_DB` | Nome do banco (default: controlcheck) |
| `POSTGRES_USER` | Usuário do banco |
| `POSTGRES_PASSWORD` | Senha do banco |
| `JWT_SECRET` | Chave secreta para tokens JWT |
| `CORS_ORIGIN` | Origins permitidos (* para todos) |
| `DOMAIN` | Domínio para HTTPS (opcional) |
