/**
 * Rotas de sincronização — /api/sync
 *
 * POST /api/sync/push     — dispositivo envia dados novos/atualizados
 * POST /api/sync/pull     — dispositivo puxa dados do servidor
 * GET  /api/sync/status   — status da última sincronização
 *
 * Protocolo:
 * 1. Pull: app envia { tabela, ultimo_sync } → servidor retorna registros com updated_at > ultimo_sync
 * 2. Push: app envia { tabela, registros[] } → servidor faz upsert e retorna confirmações
 */
import { Router, Request, Response } from 'express';
import { query, queryOne, pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const syncRouter = Router();
syncRouter.use(requireAuth);

/* Tabelas que aceitam sync (whitelist de segurança) */
const SYNC_TABLES: Record<string, { pk: string; columns: string[] }> = {
  contratos_supervisao: {
    pk: 'id',
    columns: ['id', 'numero', 'supervisora', 'cnpj', 'status', 'created_at', 'updated_at', 'created_by'],
  },
  supervisao_members: {
    pk: 'id',
    columns: ['id', 'supervisao_id', 'user_id', 'role', 'status', 'added_at', 'added_by'],
  },
  contratos: {
    pk: 'id',
    columns: ['id', 'organizacao_id', 'contrato_supervisao_id', 'numero', 'rodovia', 'trecho', 'subtrecho',
      'extensao_km', 'km_inicio', 'km_fim', 'empresa', 'cnpj', 'unidade_local', 'valor_total',
      'data_inicio', 'data_fim', 'prazo_meses', 'status', 'versao_servicos', 'created_at', 'updated_at'],
  },
  grupos: {
    pk: 'id',
    columns: ['id', 'contrato_id', 'numero', 'descricao'],
  },
  itens: {
    pk: 'id',
    columns: ['id', 'grupo_id', 'contrato_id', 'sequencia', 'item', 'codigo_siac', 'codigo_sicro',
      'descricao', 'unidade', 'preco_unitario', 'indice', 'reajuste', 'tipo_memoria', 'qtd_contratual',
      'origem', 'regra_medicao_id'],
  },
  field_services: {
    pk: 'id',
    columns: ['id', 'contrato_id', 'nome', 'descricao', 'categoria', 'icone', 'ordem', 'ativo',
      'publicado', 'fotos_min', 'gps_obrigatorio', 'created_at', 'updated_at'],
  },
  service_fields: {
    pk: 'id',
    columns: ['id', 'service_id', 'field_key', 'label', 'tipo', 'ordem', 'obrigatorio', 'unidade',
      'casas_decimais', 'min', 'max', 'opcoes', 'formula', 'mostrar_mobile', 'mostrar_memoria',
      'somente_leitura', 'usar_para_medicao', 'placeholder', 'valor_padrao'],
  },
  service_item_mappings: {
    pk: 'id',
    columns: ['id', 'service_id', 'item_id', 'campo_quantidade', 'unidade', 'condicoes', 'ativo', 'ordem'],
  },
  field_records: {
    pk: 'id',
    columns: ['id', 'contrato_id', 'service_id', 'medicao_id', 'competencia', 'usuario_id',
      'data', 'hora', 'latitude', 'longitude', 'km_interpolado', 'estaca_str', 'valores', 'calculados',
      'status', 'observacao', 'version', 'sync_status', 'device_id',
      'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at'],
  },
  record_photos: {
    pk: 'id',
    columns: ['id', 'record_id', 'storage_path', 'thumbnail_path', 'latitude', 'longitude',
      'km_interpolado', 'estaca_str', 'legenda_texto', 'data_captura', 'sync_status'],
  },
  users: {
    pk: 'id',
    columns: ['id', 'nome', 'email', 'login', 'role', 'status', 'team_id', 'avatar_url',
      'deve_trocar_senha', 'ultimo_acesso', 'created_at', 'updated_at', 'created_by'],
  },
  contract_members: {
    pk: 'id',
    columns: ['id', 'contract_id', 'user_id', 'role', 'permissions', 'status', 'added_at', 'added_by'],
  },
};

/* ── PULL: puxar dados do servidor ── */
syncRouter.post('/pull', async (req: Request, res: Response) => {
  try {
    const { tabelas } = req.body as { tabelas: { nome: string; ultimo_sync?: string }[] };

    if (!Array.isArray(tabelas)) {
      res.status(400).json({ error: 'Envie { tabelas: [{ nome, ultimo_sync }] }' });
      return;
    }

    const resultado: Record<string, any[]> = {};

    for (const { nome, ultimo_sync } of tabelas) {
      const config = SYNC_TABLES[nome];
      if (!config) continue; /* ignora tabelas desconhecidas */

      let rows: any[];
      if (ultimo_sync) {
        /* Pega apenas registros atualizados depois do último sync */
        rows = await query(
          `SELECT * FROM ${nome} WHERE updated_at > $1 OR created_at > $1 ORDER BY created_at`,
          [ultimo_sync]
        );
      } else {
        /* Primeira sync — puxa tudo */
        rows = await query(`SELECT * FROM ${nome} ORDER BY created_at`);
      }

      /* Remover senha_hash dos usuários */
      if (nome === 'users') {
        rows = rows.map(({ senha_hash, ...rest }: any) => rest);
      }

      resultado[nome] = rows;
    }

    res.json({ ok: true, dados: resultado, server_time: new Date().toISOString() });
  } catch (err: any) {
    console.error('Erro no pull:', err);
    res.status(500).json({ error: 'Erro ao buscar dados.' });
  }
});

/* ── PUSH: enviar dados para o servidor ── */
syncRouter.post('/push', async (req: Request, res: Response) => {
  try {
    const { tabela, registros, device_id } = req.body as {
      tabela: string;
      registros: any[];
      device_id?: string;
    };

    const config = SYNC_TABLES[tabela];
    if (!config) {
      res.status(400).json({ error: `Tabela "${tabela}" não aceita sync.` });
      return;
    }

    if (!Array.isArray(registros) || registros.length === 0) {
      res.status(400).json({ error: 'Envie { tabela, registros: [...] }' });
      return;
    }

    const client = await pool.connect();
    let inseridos = 0;
    let atualizados = 0;
    let ignorados = 0;

    try {
      await client.query('BEGIN');

      for (const reg of registros) {
        /* Verificar se já existe */
        const existing = await client.query(
          `SELECT ${config.pk}, updated_at FROM ${tabela} WHERE ${config.pk} = $1`,
          [reg[config.pk]]
        );

        if (existing.rows.length === 0) {
          /* INSERT — novo registro */
          const cols = config.columns.filter(c => reg[c] !== undefined);
          const vals = cols.map(c => {
            const v = reg[c];
            /* Converter objetos/arrays para JSON */
            if (typeof v === 'object' && v !== null) return JSON.stringify(v);
            return v;
          });
          const placeholders = cols.map((_, i) => `$${i + 1}`);

          await client.query(
            `INSERT INTO ${tabela} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
             ON CONFLICT (${config.pk}) DO NOTHING`,
            vals
          );
          inseridos++;
        } else {
          /* UPDATE — só se o registro enviado for mais recente */
          const serverUpdated = existing.rows[0].updated_at;
          const clientUpdated = reg.updated_at || reg.created_at;

          if (clientUpdated && new Date(clientUpdated) > new Date(serverUpdated)) {
            const cols = config.columns.filter(c => c !== config.pk && reg[c] !== undefined);
            const sets = cols.map((c, i) => `${c} = $${i + 2}`);
            const vals = cols.map(c => {
              const v = reg[c];
              if (typeof v === 'object' && v !== null) return JSON.stringify(v);
              return v;
            });

            await client.query(
              `UPDATE ${tabela} SET ${sets.join(', ')} WHERE ${config.pk} = $1`,
              [reg[config.pk], ...vals]
            );
            atualizados++;
          } else {
            ignorados++;
          }
        }
      }

      /* Registrar sync */
      if (device_id) {
        await client.query(
          `INSERT INTO sync_log (id, device_id, user_id, tabela, ultimo_sync, registros_enviados)
           VALUES (uuid_generate_v4()::text, $1, $2, $3, NOW(), $4)
           ON CONFLICT (device_id, tabela) DO UPDATE SET
             ultimo_sync = NOW(),
             registros_enviados = sync_log.registros_enviados + $4`,
          [device_id, req.auth!.userId, tabela, inseridos + atualizados]
        );
      }

      await client.query('COMMIT');

      res.json({
        ok: true,
        inseridos,
        atualizados,
        ignorados,
        server_time: new Date().toISOString(),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('Erro no push:', err);
    res.status(500).json({ error: 'Erro ao salvar dados.' });
  }
});

/* ── STATUS: última sincronização ── */
syncRouter.get('/status', async (req: Request, res: Response) => {
  try {
    const { device_id } = req.query;
    if (!device_id) {
      res.status(400).json({ error: 'Informe device_id como query param.' });
      return;
    }

    const logs = await query(
      `SELECT tabela, ultimo_sync, registros_enviados, registros_recebidos
       FROM sync_log WHERE device_id = $1 ORDER BY ultimo_sync DESC`,
      [device_id]
    );

    res.json({ device_id, tabelas: logs, server_time: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao buscar status.' });
  }
});
