/**
 * Rotas de rodovias (SNV) — /api/rodovias
 * Compartilhado entre KMCheck e ControlCheck
 *
 * GET /api/rodovias            — lista todas as rodovias disponíveis (br, uf, km_min, km_max)
 * GET /api/rodovias/:br        — lista UFs de uma BR
 * GET /api/rodovias/:br/:uf    — retorna geometria completa (lat, lon, km)
 * POST /api/rodovias/bulk      — importar rodovias em massa (admin)
 */
import { Router, Request, Response } from 'express';
import { query, queryOne, pool } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

export const rodoviasRouter = Router();

/* ── Lista de rodovias (sem geometria — leve) ── */
rodoviasRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT id, br, uf, km_min, km_max, fonte, versao_snv, data_atualizacao
       FROM rodovias ORDER BY br, uf`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao listar rodovias.' });
  }
});

/* ── UFs de uma BR ── */
rodoviasRouter.get('/:br', async (req: Request, res: Response) => {
  try {
    const br = req.params.br as string;
    const rows = await query(
      `SELECT id, br, uf, km_min, km_max, fonte, versao_snv
       FROM rodovias WHERE br = $1 ORDER BY uf`,
      [br.toUpperCase()]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao buscar rodovia.' });
  }
});

/* ── Geometria completa de uma BR/UF ── */
rodoviasRouter.get('/:br/:uf', async (req: Request, res: Response) => {
  try {
    const br = req.params.br as string;
    const uf = req.params.uf as string;
    const row = await queryOne(
      `SELECT * FROM rodovias WHERE br = $1 AND uf = $2 LIMIT 1`,
      [br.toUpperCase(), uf.toUpperCase()]
    );
    if (!row) {
      res.status(404).json({ error: `Rodovia ${br}-${uf} não encontrada.` });
      return;
    }
    res.json(row);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao buscar geometria.' });
  }
});

/* ── Importar rodovias em massa (admin) ── */
rodoviasRouter.post('/bulk', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { rodovias } = req.body as {
      rodovias: Array<{
        br: string;
        uf: string;
        fonte?: string;
        km_min: number;
        km_max: number;
        lat: number[];
        lon: number[];
        km: number[];
        versao_snv?: string;
      }>;
    };

    if (!Array.isArray(rodovias) || rodovias.length === 0) {
      res.status(400).json({ error: 'Envie { rodovias: [...] }' });
      return;
    }

    const client = await pool.connect();
    let inseridas = 0;
    let atualizadas = 0;

    try {
      await client.query('BEGIN');

      for (const rod of rodovias) {
        /* Verificar se já existe */
        const existing = await client.query(
          `SELECT id FROM rodovias WHERE br = $1 AND uf = $2 LIMIT 1`,
          [rod.br, rod.uf]
        );

        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO rodovias (br, uf, fonte, km_min, km_max, lat, lon, km, versao_snv, data_atualizacao)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
            [rod.br, rod.uf, rod.fonte || 'SNV/DNIT', rod.km_min, rod.km_max,
             rod.lat, rod.lon, rod.km, rod.versao_snv || '']
          );
          inseridas++;
        } else {
          await client.query(
            `UPDATE rodovias SET km_min=$1, km_max=$2, lat=$3, lon=$4, km=$5,
             versao_snv=$6, data_atualizacao=NOW(), fonte=$7
             WHERE br=$8 AND uf=$9`,
            [rod.km_min, rod.km_max, rod.lat, rod.lon, rod.km,
             rod.versao_snv || '', rod.fonte || 'SNV/DNIT', rod.br, rod.uf]
          );
          atualizadas++;
        }
      }

      await client.query('COMMIT');
      res.json({ ok: true, inseridas, atualizadas, total: rodovias.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('Erro no bulk import:', err);
    res.status(500).json({ error: 'Erro ao importar rodovias.' });
  }
});
