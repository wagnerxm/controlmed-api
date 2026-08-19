FROM node:20-alpine

WORKDIR /app

# Instalar dependências primeiro (cache de build)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copiar código
COPY src/ ./src/
COPY tsconfig.json ./

# Compilar TypeScript
RUN npx tsc

# Criar pasta de uploads
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "dist/server.js"]
