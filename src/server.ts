/**
 * ControlCheck API — Servidor principal
 * Express + PostgreSQL
 *
 * Endpoints:
 * POST /api/auth/login       — login
 * POST /api/auth/register    — criar usuário
 * GET  /api/auth/me          — dados do logado
 * POST /api/sync/pull        — puxar dados do servidor
 * POST /api/sync/push        — enviar dados pro servidor
 * GET  /api/sync/status      — status da sync
 * GET  /api/rodovias         — listar rodovias (SNV)
 * GET  /api/rodovias/:br/:uf — geometria de uma rodovia
 * POST /api/rodovias/bulk    — importar rodovias (admin)
 * POST /api/upload/photo     — upload de foto
 * GET  /api/upload/:file     — servir foto
 * POST /api/siac/contrato-completo  — buscar dados completos (resumo + histórico)
 * POST /api/siac/resumo             — buscar resumo do contrato via SIGO/SIAC
 * POST /api/siac/medicao            — buscar medição(ões) via SIGO/SIAC
 * POST /api/siac/historico          — histórico de medições via SIGO/SIAC
 * POST /api/siac/ficha-contratual   — ficha contratual via SISDNIT (scraping)
 * POST /api/siac/consultar          — consulta genérica SIGO/SIAC
 * GET  /api/health           — health check
 */
import express from 'express';
import cors from 'cors';
import { testConnection } from './db.js';
import { authRouter } from './routes/auth.js';
import { syncRouter } from './routes/sync.js';
import { rodoviasRouter } from './routes/rodovias.js';
import { uploadRouter } from './routes/upload.js';
import { siacRouter } from './routes/siac.js';
import { adminRouter } from './routes/admin.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

/* ── Middleware ── */
app.use(cors({
  origin: process.env.CORS_ORIGIN === '*' ? '*' : process.env.CORS_ORIGIN?.split(','),
  credentials: true,
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

/* ── Rotas ── */
app.use('/api/auth', authRouter);
app.use('/api/sync', syncRouter);
app.use('/api/rodovias', rodoviasRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/siac', siacRouter);
app.use('/api/admin', adminRouter);

/* ── Painel admin (HTML estático) ── */
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

/* ── Health check ── */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'controlcheck-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

/* ── 404 ── */
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado.' });
});

/* ── Auto-migrações (idempotentes) ── */
async function runMigrations() {
  const { pool: p } = await import('./db.js');
  // 003: coluna tipo_tr na tabela rodovias
  const col = await p.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rodovias' AND column_name = 'tipo_tr'
  `);
  if (!col.rowCount) {
    console.log('🔧 Migração 003: adicionando coluna tipo_tr...');
    await p.query(`ALTER TABLE rodovias ADD COLUMN tipo_tr CHAR(1) NOT NULL DEFAULT 'B'`);
    await p.query(`DROP INDEX IF EXISTS idx_rodovias_br_uf_snv`);
    await p.query(`CREATE UNIQUE INDEX idx_rodovias_br_uf_tipo_snv ON rodovias(br, uf, tipo_tr, versao_snv)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_rodovias_tipo ON rodovias(tipo_tr)`);
    console.log('✅ Migração 003 concluída');
  }

  // 004: tabela kmcheck_devices para rastrear aparelhos
  const devTbl = await p.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'kmcheck_devices'
  `);
  if (!devTbl.rowCount) {
    console.log('🔧 Migração 004: criando tabela kmcheck_devices...');
    await p.query(`
      CREATE TABLE kmcheck_devices (
        device_id    VARCHAR(64) PRIMARY KEY,
        app_version  VARCHAR(16),
        platform     VARCHAR(32),
        user_agent   TEXT,
        screen_info  VARCHAR(32),
        first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        total_pings  INTEGER NOT NULL DEFAULT 1
      )
    `);
    await p.query(`CREATE INDEX idx_devices_last_seen ON kmcheck_devices(last_seen DESC)`);
    await p.query(`CREATE INDEX idx_devices_version ON kmcheck_devices(app_version)`);
    console.log('✅ Migração 004 concluída');
  }
}

/* ── Boot ── */
async function start() {
  try {
    await testConnection();
    await runMigrations();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`
╔══════════════════════════════════════════╗
║  ControlCheck API v1.0.0                 ║
║  Porta: ${PORT}                            ║
║  Ambiente: ${process.env.NODE_ENV || 'development'}             ║
╚══════════════════════════════════════════╝
      `);
    });
  } catch (err) {
    console.error('❌ Falha ao iniciar:', err);
    process.exit(1);
  }
}

start();
