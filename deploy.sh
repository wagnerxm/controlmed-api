#!/bin/bash
##############################################
# ControlCheck API — Script de deploy
# Roda no servidor (VPS Contabo)
# Uso: curl -sSL https://raw.githubusercontent.com/wagnerxm/controlmed-api/main/deploy.sh | bash
##############################################

set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ControlCheck API — Deploy Automático    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Atualizar sistema ──
echo "📦 Atualizando sistema..."
apt update -qq && apt upgrade -y -qq

# ── 2. Instalar Docker (se não tiver) ──
if ! command -v docker &> /dev/null; then
    echo "🐳 Instalando Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo "✅ Docker instalado"
else
    echo "✅ Docker já instalado"
fi

# ── 3. Instalar Docker Compose plugin (se não tiver) ──
if ! docker compose version &> /dev/null; then
    echo "🔧 Instalando Docker Compose plugin..."
    apt install -y -qq docker-compose-plugin
fi

# ── 4. Instalar Git (se não tiver) ──
if ! command -v git &> /dev/null; then
    echo "📥 Instalando Git..."
    apt install -y -qq git
fi

# ── 5. Clonar ou atualizar o projeto ──
REPO_DIR="/opt/controlcheck-api"

if [ -d "$REPO_DIR" ]; then
    echo "🔄 Atualizando projeto..."
    cd "$REPO_DIR"
    git pull
else
    echo "📥 Clonando projeto..."
    git clone https://github.com/wagnerxm/controlmed-api.git "$REPO_DIR"
    cd "$REPO_DIR"
fi

# ── 6. Criar .env se não existir ──
if [ ! -f ".env" ]; then
    echo "⚙️  Criando arquivo .env..."

    # Gerar senhas aleatórias
    PG_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
    JWT_SEC=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)

    cat > .env << EOF
# Gerado automaticamente pelo deploy.sh
POSTGRES_DB=controlcheck
POSTGRES_USER=controlcheck
POSTGRES_PASSWORD=${PG_PASS}
JWT_SECRET=${JWT_SEC}
CORS_ORIGIN=*
DOMAIN=
EOF

    echo "✅ Arquivo .env criado"
    echo ""
    echo "⚠️  ANOTE ESTAS SENHAS:"
    echo "   PostgreSQL: ${PG_PASS}"
    echo "   JWT Secret: ${JWT_SEC}"
    echo ""
fi

# ── 7. Subir containers ──
echo "🚀 Subindo containers..."
docker compose up -d --build

# ── 8. Aguardar o banco inicializar ──
echo "⏳ Aguardando PostgreSQL..."
sleep 5

# ── 9. Verificar se tudo subiu ──
echo ""
echo "📊 Status dos containers:"
docker compose ps

echo ""
echo "🔍 Testando API..."
sleep 3
if curl -sf http://localhost/health > /dev/null 2>&1; then
    echo "✅ API respondendo!"
    curl -s http://localhost/api/health | python3 -m json.tool 2>/dev/null || curl -s http://localhost/api/health
else
    echo "⚠️  API ainda iniciando... Teste em alguns segundos:"
    echo "   curl http://localhost/api/health"
fi

# ── 10. Mostrar IP do servidor ──
SERVER_IP=$(curl -sf ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✅ Deploy concluído!                    ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  API: http://${SERVER_IP}/api/health      "
echo "║                                          ║"
echo "║  Próximos passos:                        ║"
echo "║  1. Configurar domínio/DuckDNS           ║"
echo "║  2. Configurar HTTPS (Let's Encrypt)     ║"
echo "║  3. Conectar os apps                     ║"
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
