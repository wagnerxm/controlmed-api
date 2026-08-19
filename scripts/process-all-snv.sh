#!/bin/bash
##############################################
# Processar todas as versões SNV do DNIT Cloud
# Baixa SHP, converte, insere no PostgreSQL
#
# Rodar na VPS: bash scripts/process-all-snv.sh
# Filtrar:      bash scripts/process-all-snv.sh --only 202504a,202501a
##############################################

set -e

cd /opt/controlcheck-api

echo ""
echo "Rebuilding API container with new dependencies..."
docker compose build api
docker compose up -d api
sleep 5

echo ""
echo "Running SNV processor..."
docker compose run --rm \
  -v "$PWD/scripts/process-all-snv.cjs:/app/process-all-snv.cjs:ro" \
  api node /app/process-all-snv.cjs "$@"

echo ""
echo "🏁 Finalizado!"
