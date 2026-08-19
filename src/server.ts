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
 * POST /api/siac/resumo      — buscar resumo do contrato via SIGO/SIAC
 * POST /api/siac/medicao     — buscar medição(ões) via SIGO/SIAC
 * POST /api/siac/historico   — histórico de medições via SIGO/SIAC
 * POST /api/siac/consultar   — consulta genérica SIGO/SIAC
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

/* ── Boot ── */
async function start() {
  try {
    await testConnection();
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
