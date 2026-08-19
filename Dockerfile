FROM node:20-alpine AS builder

WORKDIR /app

# Instalar TODAS as dependências (incluindo devDependencies para compilar)
COPY package.json package-lock.json* ./
RUN npm ci

# Copiar código e compilar TypeScript
COPY src/ ./src/
COPY tsconfig.json ./
RUN npx -p typescript tsc

# ── Estágio final (sem devDependencies) ──
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copiar código compilado do builder
COPY --from=builder /app/dist ./dist

# Criar pasta de uploads
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "dist/server.js"]
