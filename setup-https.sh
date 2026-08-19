#!/bin/bash
##############################################
# Configurar HTTPS com Let's Encrypt
# Uso: bash setup-https.sh controlcheck.duckdns.org
##############################################

set -e

DOMAIN=${1:?"Uso: bash setup-https.sh SEU_DOMINIO.duckdns.org"}

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Configurando HTTPS para: $DOMAIN"
echo "╚══════════════════════════════════════════╝"
echo ""

cd /opt/controlcheck-api

# ── 1. Obter certificado SSL ──
echo "🔐 Obtendo certificado SSL..."
docker compose run --rm certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email admin@$DOMAIN \
  --agree-tos \
  --no-eff-email \
  -d $DOMAIN

# ── 2. Atualizar nginx.conf com HTTPS ──
echo "⚙️  Atualizando Nginx..."

cat > nginx/nginx.conf << 'NGINXEOF'
##############################################
# Nginx — Reverse proxy com HTTPS
##############################################

events {
    worker_connections 1024;
}

http {
    access_log /var/log/nginx/access.log;
    error_log  /var/log/nginx/error.log;

    client_max_body_size 25m;

    gzip on;
    gzip_types application/json text/plain text/css;

    limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;

    upstream api_backend {
        server api:3000;
    }

    # ── HTTP → redireciona para HTTPS ──
    server {
        listen 80;
        server_name DOMAIN_PLACEHOLDER;

        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }

        location / {
            return 301 https://$host$request_uri;
        }
    }

    # ── HTTPS ──
    server {
        listen 443 ssl http2;
        server_name DOMAIN_PLACEHOLDER;

        ssl_certificate /etc/letsencrypt/live/DOMAIN_PLACEHOLDER/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/DOMAIN_PLACEHOLDER/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;

        location /api/ {
            limit_req zone=api burst=50 nodelay;

            proxy_pass http://api_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto https;

            proxy_connect_timeout 30s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;
        }

        location /health {
            proxy_pass http://api_backend/api/health;
        }

        location / {
            return 200 '{"service":"controlcheck-api","status":"running","https":true}';
            add_header Content-Type application/json;
        }
    }
}
NGINXEOF

# Substituir placeholder pelo domínio real
sed -i "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" nginx/nginx.conf

# ── 3. Atualizar .env com o domínio ──
if grep -q "^DOMAIN=" .env; then
    sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" .env
else
    echo "DOMAIN=$DOMAIN" >> .env
fi

# ── 4. Reiniciar Nginx ──
echo "🔄 Reiniciando Nginx..."
docker compose restart nginx

# ── 5. Testar HTTPS ──
echo ""
sleep 3
if curl -sf https://$DOMAIN/api/health > /dev/null 2>&1; then
    echo "╔══════════════════════════════════════════╗"
    echo "║  ✅ HTTPS configurado com sucesso!       ║"
    echo "╠══════════════════════════════════════════╣"
    echo "║                                          ║"
    echo "║  🔒 https://$DOMAIN/api/health"
    echo "║                                          ║"
    echo "╚══════════════════════════════════════════╝"
else
    echo "⚠️  HTTPS pode demorar alguns segundos."
    echo "   Teste: curl https://$DOMAIN/api/health"
fi

echo ""
echo "✅ Pronto! A API agora está acessível via HTTPS."
echo ""
