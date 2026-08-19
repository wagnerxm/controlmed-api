/**
 * Rotas de integração SIAC/SIGO — /api/siac
 *
 * POST /api/siac/consultar     — cria consulta no SIGO e aguarda resultado
 * POST /api/siac/resumo        — atalho: busca resumo-contrato e retorna itens
 * POST /api/siac/medicao       — busca medição(ões) do contrato
 * POST /api/siac/historico     — busca histórico de medições
 *
 * O SIGO faz proxy ao SIAC/SISDNIT do DNIT usando as credenciais do usuário.
 * A chave de API (SIGO_API_KEY) fica no servidor — nunca exposta ao front.
 */
import { Router, Request, Response } from 'express';

export const siacRouter = Router();

const SIGO_BASE = 'https://sigo.eng.br/api/siac/v1';

/* ── Consulta genérica ao SIGO (assíncrona: cria + poll) ── */
async function consultarSigo(body: {
  tipo: string;
  numero_contrato: string;
  fiscalizadora: string;
  cpf: string;
  senha: string;
  numero_medicao?: number;
  formato?: string;
}): Promise<{ ok: boolean; data?: any; error?: string }> {
  const apiKey = process.env.SIGO_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'SIGO_API_KEY não configurada no servidor.' };
  }

  /* 1) Criar a consulta */
  let criaRes: globalThis.Response;
  try {
    criaRes = await fetch(`${SIGO_BASE}/consultas`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err: any) {
    return { ok: false, error: `Erro de conexão com o SIGO: ${err.message}` };
  }

  if (!criaRes.ok) {
    const txt = await criaRes.text().catch(() => '');
    return { ok: false, error: `SIGO retornou HTTP ${criaRes.status}: ${txt}` };
  }

  const cria = await criaRes.json();
  if (!cria.ok || !cria.id) {
    return { ok: false, error: cria.erro || cria.error || 'Resposta inesperada do SIGO.' };
  }

  const consultaId = cria.id;

  /* 2) Poll até concluir (máx ~2 min) */
  const MAX_POLLS = 40;
  const POLL_INTERVAL = 3000; // 3s

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    let pollRes: globalThis.Response;
    try {
      pollRes = await fetch(`${SIGO_BASE}/consultas/${consultaId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      continue; // retry no próximo poll
    }

    if (!pollRes.ok) continue;

    const poll = await pollRes.json();

    if (poll.status === 'concluida') {
      return { ok: true, data: poll };
    }

    if (poll.status === 'erro') {
      return { ok: false, error: poll.erro || 'Erro na consulta SIAC.' };
    }

    // 'na_fila' ou 'processando' → continua polling
  }

  return { ok: false, error: 'Timeout: consulta não concluiu em 2 minutos.' };
}

/* ══════════════════════════════════════════
   POST /api/siac/consultar — consulta genérica
   ══════════════════════════════════════════ */
siacRouter.post('/consultar', async (req: Request, res: Response) => {
  const { tipo, numero_contrato, fiscalizadora, cpf, senha, numero_medicao, formato } = req.body;

  if (!tipo || !numero_contrato || !fiscalizadora || !cpf || !senha) {
    res.status(400).json({ error: 'Campos obrigatórios: tipo, numero_contrato, fiscalizadora, cpf, senha.' });
    return;
  }

  const body: any = { tipo, numero_contrato, fiscalizadora, cpf, senha };
  if (numero_medicao != null) body.numero_medicao = numero_medicao;
  if (formato) body.formato = formato;

  const result = await consultarSigo(body);

  if (!result.ok) {
    res.status(502).json({ error: result.error });
    return;
  }

  res.json(result.data);
});

/* ══════════════════════════════════════════
   POST /api/siac/resumo — busca resumo do contrato
   Atalho para tipo=resumo-contrato, formato=json
   ══════════════════════════════════════════ */
siacRouter.post('/resumo', async (req: Request, res: Response) => {
  const { numero_contrato, fiscalizadora, cpf, senha } = req.body;

  if (!numero_contrato || !fiscalizadora || !cpf || !senha) {
    res.status(400).json({ error: 'Campos obrigatórios: numero_contrato, fiscalizadora, cpf, senha.' });
    return;
  }

  console.log(`[SIAC] Buscando resumo do contrato ${numero_contrato} (${fiscalizadora})...`);

  const result = await consultarSigo({
    tipo: 'resumo-contrato',
    numero_contrato,
    fiscalizadora,
    cpf,
    senha,
    formato: 'json',
  });

  if (!result.ok) {
    console.log(`[SIAC] Erro: ${result.error}`);
    res.status(502).json({ error: result.error });
    return;
  }

  console.log(`[SIAC] Resumo do contrato ${numero_contrato} recebido com sucesso.`);
  res.json(result.data);
});

/* ══════════════════════════════════════════
   POST /api/siac/medicao — lista medições ou detalhe
   ══════════════════════════════════════════ */
siacRouter.post('/medicao', async (req: Request, res: Response) => {
  const { numero_contrato, fiscalizadora, cpf, senha, numero_medicao, formato } = req.body;

  if (!numero_contrato || !fiscalizadora || !cpf || !senha) {
    res.status(400).json({ error: 'Campos obrigatórios: numero_contrato, fiscalizadora, cpf, senha.' });
    return;
  }

  const body: any = {
    tipo: 'medicao',
    numero_contrato,
    fiscalizadora,
    cpf,
    senha,
    formato: formato || 'json',
  };
  if (numero_medicao != null) body.numero_medicao = numero_medicao;

  const result = await consultarSigo(body);

  if (!result.ok) {
    res.status(502).json({ error: result.error });
    return;
  }

  res.json(result.data);
});

/* ══════════════════════════════════════════
   POST /api/siac/historico — histórico de medições
   ══════════════════════════════════════════ */
siacRouter.post('/historico', async (req: Request, res: Response) => {
  const { numero_contrato, fiscalizadora, cpf, senha, formato } = req.body;

  if (!numero_contrato || !fiscalizadora || !cpf || !senha) {
    res.status(400).json({ error: 'Campos obrigatórios: numero_contrato, fiscalizadora, cpf, senha.' });
    return;
  }

  const result = await consultarSigo({
    tipo: 'historico',
    numero_contrato,
    fiscalizadora,
    cpf,
    senha,
    formato: formato || 'json',
  });

  if (!result.ok) {
    res.status(502).json({ error: result.error });
    return;
  }

  res.json(result.data);
});
