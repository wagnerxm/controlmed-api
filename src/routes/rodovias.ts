/**
 * Rotas de rodovias (SNV) — /api/rodovias
 * Compartilhado entre KMCheck e ControlCheck
 *
 * GET  /api/rodovias                — lista rodovias (sem geometria)
 * GET  /api/rodovias/versoes        — lista versões do SNV disponíveis
 * GET  /api/rodovias/:br            — UFs de uma BR
 * GET  /api/rodovias/:br/:uf        — geometria completa (?snv=202504a)
 * GET  /api/rodovias/:br/:uf/versoes — versões disponíveis para uma BR/UF
 * POST /api/rodovias/bulk           — importar rodovias em massa (admin)
 */
import { Router, Request, Response } from 'express';
import { query, queryOne, pool } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

export const rodoviasRouter = Router();

/* ── Lista versões do SNV disponíveis ── */
rodoviasRouter.get('/versoes', async (_req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT id, label, data_publicacao, arquivo_dnit, total_rodovias, status, created_at
       FROM snv_versoes
       ORDER BY id DESC`
    );
    res.json(rows);
  } catch (err: any) {
    // Se a tabela não existe ainda, retorna lista vazia
    if (err.code === '42P01') { res.json([]); return; }
    res.status(500).json({ error: 'Erro ao listar versões SNV.' });
  }
});

/* ── Lista de rodovias (sem geometria — leve) ── */
rodoviasRouter.get('/', async (req: Request, res: Response) => {
  try {
    const snv = (req.query.snv as string) || '';
    const tipo = ((req.query.tipo as string) || '').toUpperCase() || null;
    let sql: string;
    let params: any[];

    if (snv && tipo) {
      sql = `SELECT id, br, uf, tipo_tr, km_min, km_max, fonte, versao_snv, data_atualizacao
             FROM rodovias WHERE versao_snv = $1 AND tipo_tr = $2 ORDER BY br, uf`;
      params = [snv.toLowerCase(), tipo];
    } else if (snv) {
      sql = `SELECT id, br, uf, tipo_tr, km_min, km_max, fonte, versao_snv, data_atualizacao
             FROM rodovias WHERE versao_snv = $1 ORDER BY br, uf`;
      params = [snv.toLowerCase()];
    } else {
      sql = `SELECT DISTINCT ON (br, uf, tipo_tr)
               id, br, uf, tipo_tr, km_min, km_max, fonte, versao_snv, data_atualizacao
             FROM rodovias
             ORDER BY br, uf, tipo_tr, versao_snv DESC`;
      params = [];
    }
    const rows = await query(sql, params);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao listar rodovias.' });
  }
});

/* ── UFs de uma BR ── */
rodoviasRouter.get('/:br', async (req: Request, res: Response) => {
  try {
    const br = (req.params.br as string).replace(/\D/g, '').padStart(3, '0');
    const snv = (req.query.snv as string) || '';
    const tipo = ((req.query.tipo as string) || '').toUpperCase() || null;

    let sql: string;
    let params: any[];

    if (snv && tipo) {
      sql = `SELECT id, br, uf, tipo_tr, km_min, km_max, fonte, versao_snv
             FROM rodovias WHERE br = $1 AND versao_snv = $2 AND tipo_tr = $3 ORDER BY uf`;
      params = [br, snv.toLowerCase(), tipo];
    } else if (snv) {
      sql = `SELECT id, br, uf, tipo_tr, km_min, km_max, fonte, versao_snv
             FROM rodovias WHERE br = $1 AND versao_snv = $2 ORDER BY uf`;
      params = [br, snv.toLowerCase()];
    } else {
      sql = `SELECT DISTINCT ON (uf, tipo_tr)
               id, br, uf, tipo_tr, km_min, km_max, fonte, versao_snv
             FROM rodovias WHERE br = $1
             ORDER BY uf, tipo_tr, versao_snv DESC`;
      params = [br];
    }
    const rows = await query(sql, params);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao buscar rodovia.' });
  }
});

/* ── Versões disponíveis para uma BR/UF ── */
rodoviasRouter.get('/:br/:uf/versoes', async (req: Request, res: Response) => {
  try {
    const br = (req.params.br as string).replace(/\D/g, '').padStart(3, '0');
    const uf = (req.params.uf as string).toUpperCase();

    const rows = await query(
      `SELECT r.versao_snv, r.km_min, r.km_max, r.data_atualizacao,
              v.label, v.data_publicacao
       FROM rodovias r
       LEFT JOIN snv_versoes v ON v.id = r.versao_snv
       WHERE r.br = $1 AND r.uf = $2
       ORDER BY r.versao_snv DESC`,
      [br, uf]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao buscar versões.' });
  }
});

/* ── Geometria completa de uma BR/UF ── */
rodoviasRouter.get('/:br/:uf', async (req: Request, res: Response) => {
  try {
    const br = (req.params.br as string).replace(/\D/g, '').padStart(3, '0');
    const uf = (req.params.uf as string).toUpperCase();
    const snv = (req.query.snv as string) || '';
    const tipo = ((req.query.tipo as string) || 'B').toUpperCase(); // default B para retrocompat

    let sql: string;
    let params: any[];

    if (snv) {
      sql = `SELECT * FROM rodovias WHERE br = $1 AND uf = $2 AND versao_snv = $3 AND tipo_tr = $4 LIMIT 1`;
      params = [br, uf, snv.toLowerCase(), tipo];
    } else {
      sql = `SELECT * FROM rodovias WHERE br = $1 AND uf = $2 AND tipo_tr = $3
             ORDER BY versao_snv DESC LIMIT 1`;
      params = [br, uf, tipo];
    }
    const row = await queryOne(sql, params);
    if (!row) {
      res.status(404).json({ error: `Rodovia BR-${br}/${uf} (tipo ${tipo})${snv ? ' SNV ' + snv : ''} não encontrada.` });
      return;
    }
    res.json(row);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao buscar geometria.' });
  }
});

/* ── Registrar/atualizar versão SNV no catálogo ── */
rodoviasRouter.post('/versoes', async (req: Request, res: Response) => {
  try {
    const importKey = req.headers['x-import-key'] as string;
    const serverKey = process.env.IMPORT_KEY;
    if (!serverKey || importKey !== serverKey) {
      res.status(403).json({ error: 'Chave de importação inválida.' });
      return;
    }
    const { id, label, arquivo_dnit, total_rodovias, status } = req.body;
    if (!id) { res.status(400).json({ error: 'id é obrigatório.' }); return; }

    await pool.query(`
      INSERT INTO snv_versoes (id, label, arquivo_dnit, total_rodovias, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        label = COALESCE(EXCLUDED.label, snv_versoes.label),
        arquivo_dnit = COALESCE(EXCLUDED.arquivo_dnit, snv_versoes.arquivo_dnit),
        total_rodovias = COALESCE(EXCLUDED.total_rodovias, snv_versoes.total_rodovias),
        status = COALESCE(EXCLUDED.status, snv_versoes.status)
    `, [id, label || id, arquivo_dnit || '', total_rodovias || 0, status || 'concluido']);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Erro ao registrar versão:', err);
    res.status(500).json({ error: 'Erro ao registrar versão.' });
  }
});

/* ── Importar rodovias via chave de importação (scripts locais) ── */
rodoviasRouter.post('/import', async (req: Request, res: Response) => {
  try {
    const importKey = req.headers['x-import-key'] as string;
    const serverKey = process.env.IMPORT_KEY;
    if (!serverKey || importKey !== serverKey) {
      res.status(403).json({ error: 'Chave de importação inválida. Defina IMPORT_KEY no .env do servidor.' });
      return;
    }

    const { rodovias, versao_snv } = req.body as {
      versao_snv: string;
      rodovias: Array<{
        br: string; uf: string; tipo_tr?: string; fonte?: string;
        km_min: number; km_max: number;
        lat: number[]; lon: number[]; km: number[];
      }>;
    };

    if (!versao_snv) { res.status(400).json({ error: 'versao_snv é obrigatório.' }); return; }
    if (!Array.isArray(rodovias) || !rodovias.length) { res.status(400).json({ error: 'Envie { versao_snv, rodovias: [...] }' }); return; }

    const client = await pool.connect();
    let inseridas = 0;
    try {
      await client.query('BEGIN');
      for (const rod of rodovias) {
        const snv = versao_snv.toLowerCase();
        const tipo = (rod.tipo_tr || 'B').toUpperCase();
        const id = `rod-${rod.br}-${tipo}-${rod.uf}-${snv}`;
        await client.query(`
          INSERT INTO rodovias (id, br, uf, tipo_tr, fonte, km_min, km_max, lat, lon, km, versao_snv, data_atualizacao)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
          ON CONFLICT (id) DO UPDATE SET
            km_min=EXCLUDED.km_min, km_max=EXCLUDED.km_max,
            lat=EXCLUDED.lat, lon=EXCLUDED.lon, km=EXCLUDED.km,
            data_atualizacao=EXCLUDED.data_atualizacao, fonte=EXCLUDED.fonte,
            tipo_tr=EXCLUDED.tipo_tr
        `, [id, rod.br, rod.uf, tipo, rod.fonte || 'SNV/DNIT', rod.km_min, rod.km_max,
            rod.lat, rod.lon, rod.km, snv]);
        inseridas++;
      }
      await client.query('COMMIT');
      res.json({ ok: true, inseridas, total: rodovias.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('Erro no import:', err);
    res.status(500).json({ error: 'Erro ao importar rodovias.' });
  }
});

/* ── Reset para reimportação (apaga rodovias de uma versão e reseta status) ── */
rodoviasRouter.post('/reset', async (req: Request, res: Response) => {
  try {
    const importKey = req.headers['x-import-key'] as string;
    const serverKey = process.env.IMPORT_KEY;
    if (!serverKey || importKey !== serverKey) {
      res.status(403).json({ error: 'Chave de importação inválida.' });
      return;
    }
    const { versao_snv, all } = req.body as { versao_snv?: string; all?: boolean };
    if (all) {
      await pool.query(`DELETE FROM rodovias`);
      await pool.query(`UPDATE snv_versoes SET status = 'disponivel', total_rodovias = 0`);
      res.json({ ok: true, message: 'Todas as rodovias apagadas e versões resetadas.' });
    } else if (versao_snv) {
      const snv = versao_snv.toLowerCase();
      await pool.query(`DELETE FROM rodovias WHERE versao_snv = $1`, [snv]);
      await pool.query(`UPDATE snv_versoes SET status = 'disponivel', total_rodovias = 0 WHERE id = $1`, [snv]);
      res.json({ ok: true, message: `Versão ${snv} resetada.` });
    } else {
      res.status(400).json({ error: 'Informe versao_snv ou all:true.' });
    }
  } catch (err: any) {
    console.error('Erro no reset:', err);
    res.status(500).json({ error: 'Erro ao resetar.' });
  }
});

/* ── Importar rodovias em massa (admin autenticado) ── */
rodoviasRouter.post('/bulk', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { rodovias, versao_snv } = req.body as {
      versao_snv?: string;
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
        const snv = (rod.versao_snv || versao_snv || '').toLowerCase();
        const id = `rod-${rod.br}-${rod.uf}-${snv}`;

        await client.query(`
          INSERT INTO rodovias (id, br, uf, fonte, km_min, km_max, lat, lon, km, versao_snv, data_atualizacao)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
          ON CONFLICT (id) DO UPDATE SET
            km_min = EXCLUDED.km_min, km_max = EXCLUDED.km_max,
            lat = EXCLUDED.lat, lon = EXCLUDED.lon, km = EXCLUDED.km,
            versao_snv = EXCLUDED.versao_snv, data_atualizacao = EXCLUDED.data_atualizacao,
            fonte = EXCLUDED.fonte
        `, [id, rod.br, rod.uf, rod.fonte || 'SNV/DNIT', rod.km_min, rod.km_max,
            rod.lat, rod.lon, rod.km, snv]);

        inseridas++;
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
