#!/bin/bash
##############################################
# Importar rodovias do SNV/DNIT para PostgreSQL
# Baixa do GitHub e importa via Docker
#
# Rodar na VPS: bash scripts/import-rodovias.sh
##############################################

set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Importando rodovias SNV/DNIT           ║"
echo "╚══════════════════════════════════════════╝"
echo ""

cd /opt/controlcheck-api

# ── 1. Baixar os dados do GitHub ──
REPO_URL="https://github.com/wagnerxm/kmcheck"
TEMP_DIR="/tmp/kmcheck-rodovias"

if [ -d "$TEMP_DIR/data/rodovias" ]; then
    echo "📁 Dados já baixados em $TEMP_DIR"
    echo "🔄 Atualizando..."
    cd "$TEMP_DIR"
    git pull --depth=1 2>/dev/null || true
    cd /opt/controlcheck-api
else
    echo "📥 Baixando dados do repositório KMCheck..."
    echo "   (sparse checkout — apenas data/rodovias)"
    rm -rf "$TEMP_DIR"
    git clone --depth=1 --filter=blob:none --sparse "$REPO_URL" "$TEMP_DIR"
    cd "$TEMP_DIR"
    git sparse-checkout set data/rodovias
    cd /opt/controlcheck-api
fi

RODOVIAS_DIR="$TEMP_DIR/data/rodovias"
FILE_COUNT=$(find "$RODOVIAS_DIR" -name '*.json' ! -name 'index.json' | wc -l)

echo ""
echo "📊 Encontradas $FILE_COUNT rodovias"
echo ""

# ── 2. Importar usando docker compose run com volume montado ──
echo "🔧 Executando importação no container..."
echo ""

docker compose run --rm \
  -v "$RODOVIAS_DIR:/rodovias-data:ro" \
  -v "$PWD/scripts/import-rodovias.cjs:/app/import-rodovias.cjs:ro" \
  api node /app/import-rodovias.cjs

echo ""
echo "🏁 Script finalizado!"
echo ""
