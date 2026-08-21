/**
 * Rotas administrativas — /api/admin
 * Painel de monitoramento do KMCheck (somente admin/dono)
 *
 * GET  /api/admin/dashboard    — dados completos do painel
 * GET  /api/admin/snv-status   — status de todas as versões SNV
 * GET  /api/admin/devices      — dispositivos registrados
 * POST /api/admin/devices/ping — registrar/atualizar dispositivo (chamado pelo KMCheck)
 */
import { Router, Request, Response } from 'express';
import { query, queryOne, pool } from '../db.js';

export const adminRouter = Router();

/* ── Validação admin via IMPORT_KEY (simples, sem auth JWT) ── */
function isAdmin(req: Request): boolean {
  const key = req.headers['x-admin-key'] as string || req.query.key as string;
  return !!process.env.IMPORT_KEY && key === process.env.IMPORT_KEY;
}

/* ── Ping de dispositivo (chamado pelo KMCheck no boot) ── */
adminRouter.post('/devices/ping', async (req: Request, res: Response) => {
  try {
    const { device_id, app_version, platform, user_agent, screen } = req.body;
    if (!device_id) { res.status(400).json({ error: 'device_id obrigatório' }); return; }

    await pool.query(`
      INSERT INTO kmcheck_devices (device_id, app_version, platform, user_agent, screen_info, last_seen, total_pings)
      VALUES ($1, $2, $3, $4, $5, NOW(), 1)
      ON CONFLICT (device_id) DO UPDATE SET
        app_version = COALESCE(EXCLUDED.app_version, kmcheck_devices.app_version),
        platform = COALESCE(EXCLUDED.platform, kmcheck_devices.platform),
        user_agent = COALESCE(EXCLUDED.user_agent, kmcheck_devices.user_agent),
        screen_info = COALESCE(EXCLUDED.screen_info, kmcheck_devices.screen_info),
        last_seen = NOW(),
        total_pings = kmcheck_devices.total_pings + 1
    `, [device_id, app_version || null, platform || null, user_agent || null, screen || null]);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Erro no ping:', err);
    res.status(500).json({ error: 'Erro ao registrar dispositivo.' });
  }
});

/* ── Dashboard completo (admin) ── */
adminRouter.get('/dashboard', async (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'Acesso negado.' }); return; }
  try {
    // 1. Versões SNV
    const snvVersions = await query(`
      SELECT id, label, arquivo_dnit, total_rodovias, status, created_at
      FROM snv_versoes ORDER BY id DESC
    `);

    // 2. Estatísticas de rodovias por versão
    const rodoviaStats = await query(`
      SELECT versao_snv,
             COUNT(*) as total_rodovias,
             COUNT(DISTINCT br) as total_brs,
             COUNT(DISTINCT uf) as total_ufs,
             COUNT(DISTINCT tipo_tr) as total_tipos,
             array_agg(DISTINCT tipo_tr ORDER BY tipo_tr) as tipos
      FROM rodovias
      GROUP BY versao_snv
      ORDER BY versao_snv DESC
    `);

    // 3. Resumo geral
    const resumo = await queryOne(`
      SELECT
        COUNT(*) as total_rodovias,
        COUNT(DISTINCT versao_snv) as total_versoes,
        COUNT(DISTINCT br) as total_brs,
        COUNT(DISTINCT uf) as total_ufs,
        MIN(versao_snv) as versao_mais_antiga,
        MAX(versao_snv) as versao_mais_recente
      FROM rodovias
    `);

    // 4. Dispositivos
    const devices = await query(`
      SELECT device_id, app_version, platform, screen_info, last_seen, first_seen, total_pings
      FROM kmcheck_devices
      ORDER BY last_seen DESC
    `).catch(() => []);  // tabela pode não existir ainda

    // 5. Dispositivos ativos (últimas 24h / 7d / 30d)
    const deviceStats = await queryOne(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '24 hours') as ativos_24h,
        COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '7 days') as ativos_7d,
        COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '30 days') as ativos_30d,
        COUNT(DISTINCT app_version) as versoes_app,
        COUNT(DISTINCT platform) as plataformas
      FROM kmcheck_devices
    `).catch(() => null);

    // 6. Distribuição por versão do app
    const versionDist = await query(`
      SELECT app_version, COUNT(*) as qty
      FROM kmcheck_devices
      WHERE app_version IS NOT NULL
      GROUP BY app_version
      ORDER BY app_version DESC
    `).catch(() => []);

    // 7. Distribuição por plataforma
    const platformDist = await query(`
      SELECT platform, COUNT(*) as qty
      FROM kmcheck_devices
      WHERE platform IS NOT NULL
      GROUP BY platform
      ORDER BY qty DESC
    `).catch(() => []);

    res.json({
      resumo,
      snvVersions,
      rodoviaStats,
      devices,
      deviceStats,
      versionDist,
      platformDist,
      serverTime: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('Erro no dashboard:', err);
    res.status(500).json({ error: 'Erro ao gerar dashboard.' });
  }
});

/* ── Status SNV (admin) ── */
adminRouter.get('/snv-status', async (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'Acesso negado.' }); return; }
  try {
    const rows = await query(`
      SELECT v.id, v.label, v.arquivo_dnit, v.total_rodovias, v.status, v.created_at,
             COALESCE(r.real_count, 0) as rodovias_no_banco,
             COALESCE(r.tipos, '{}') as tipos_presentes,
             COALESCE(r.brs, 0) as brs_distintas
      FROM snv_versoes v
      LEFT JOIN (
        SELECT versao_snv,
               COUNT(*) as real_count,
               array_agg(DISTINCT tipo_tr ORDER BY tipo_tr) as tipos,
               COUNT(DISTINCT br) as brs
        FROM rodovias
        GROUP BY versao_snv
      ) r ON r.versao_snv = v.id
      ORDER BY v.id DESC
    `);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao buscar status SNV.' });
  }
});

/* ── Lista dispositivos (admin) ── */
adminRouter.get('/devices', async (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'Acesso negado.' }); return; }
  try {
    const rows = await query(`
      SELECT device_id, app_version, platform, user_agent, screen_info,
             first_seen, last_seen, total_pings
      FROM kmcheck_devices
      ORDER BY last_seen DESC
    `);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao listar dispositivos.' });
  }
});
