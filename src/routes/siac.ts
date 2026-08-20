/**
 * Rotas de integração SIAC/SIGO — /api/siac
 *
 * POST /api/siac/consultar          — cria consulta no SIGO e aguarda resultado
 * POST /api/siac/resumo             — atalho: busca resumo-contrato e retorna itens
 * POST /api/siac/medicao            — busca medição(ões) do contrato
 * POST /api/siac/historico          — busca histórico de medições
 * POST /api/siac/ficha-contratual   — busca ficha contratual direto do SISDNIT (scraping)
 *
 * O SIGO faz proxy ao SIAC/SISDNIT do DNIT usando as credenciais do usuário.
 * Para a ficha contratual, acessamos o SISDNIT diretamente (o SIGO não expõe esse recurso).
 * A chave de API (SIGO_API_KEY) fica no servidor — nunca exposta ao front.
 */
import { Router, Request, Response } from 'express';
import { loginSisdnit, buscarFichaContratual } from '../lib/sisdnit-scraper.js';

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
   POST /api/siac/contrato-completo
   Busca resumo + histórico em paralelo e retorna dados completos do contrato
   ══════════════════════════════════════════ */
siacRouter.post('/contrato-completo', async (req: Request, res: Response) => {
  const { numero_contrato, fiscalizadora, cpf, senha } = req.body;

  if (!numero_contrato || !fiscalizadora || !cpf || !senha) {
    res.status(400).json({ error: 'Campos obrigatórios: numero_contrato, fiscalizadora, cpf, senha.' });
    return;
  }

  console.log(`[SIAC] Buscando dados completos do contrato ${numero_contrato} (${fiscalizadora})...`);

  /* Buscar resumo, histórico e empenho em paralelo (3 consultas simultâneas) */
  const [resumoResult, historicoResult, empenhoResult] = await Promise.all([
    consultarSigo({ tipo: 'resumo-contrato', numero_contrato, fiscalizadora, cpf, senha, formato: 'json' }),
    consultarSigo({ tipo: 'historico', numero_contrato, fiscalizadora, cpf, senha, formato: 'json' }),
    consultarSigo({ tipo: 'empenho', numero_contrato, fiscalizadora, cpf, senha, formato: 'json' }),
  ]);

  if (!resumoResult.ok) {
    console.log(`[SIAC] Erro no resumo: ${resumoResult.error}`);
    res.status(502).json({ error: resumoResult.error });
    return;
  }

  /* Montar resposta combinada */
  const resumo = resumoResult.data?.resultado || {};
  const historico = historicoResult.ok ? (historicoResult.data?.resultado || {}) : {};
  const empenho = empenhoResult.ok ? (empenhoResult.data?.resultado || {}) : {};

  const resultado = {
    contrato: resumo.contrato || numero_contrato,
    empresa: historico.empresa || '',
    fiscalizadora,
    valor_total: resumo.valor_total || 0,
    valor_servicos: resumo.valor_servicos || 0,
    confere: resumo.confere,
    itens: resumo.itens || [],
    /* Dados do histórico */
    total_medicoes: historico.quantidade || 0,
    medicoes: historico.medicoes || [],
    /* Dados de empenho */
    empenho: {
      total: empenho.total_empenho || 0,
      valor_empenho: empenho.componentes?.valor_empenho || 0,
      valor_ajustes: empenho.componentes?.valor_ajustes || 0,
      valor_consumido: empenho.componentes?.valor_consumido || 0,
      saldo: empenho.componentes?.saldo || 0,
    },
  };

  console.log(`[SIAC] Contrato ${numero_contrato}: empresa="${resultado.empresa}", ${resultado.itens.length} itens, ${resultado.total_medicoes} medições, empenho=${resultado.empenho.total}.`);
  res.json({ ok: true, resultado });
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

/* ══════════════════════════════════════════
   POST /api/siac/ficha-contratual
   Busca a ficha contratual diretamente do SISDNIT (scraping)
   O SIGO não oferece esse recurso, então logamos no SISDNIT
   com o CPF/senha do próprio usuário e parseamos o HTML.
   ══════════════════════════════════════════ */
siacRouter.post('/ficha-contratual', async (req: Request, res: Response) => {
  const { numero_contrato, cpf, senha } = req.body;

  if (!numero_contrato || !cpf || !senha) {
    res.status(400).json({ error: 'Campos obrigatórios: numero_contrato, cpf, senha.' });
    return;
  }

  console.log(`[SISDNIT] Buscando ficha contratual do contrato ${numero_contrato}...`);

  /* 1. Login no SISDNIT */
  const loginResult = await loginSisdnit(cpf, senha);
  if (!loginResult.ok || !loginResult.session) {
    console.log(`[SISDNIT] Login falhou: ${loginResult.error}`);
    res.status(401).json({ error: loginResult.error });
    return;
  }
  console.log(`[SISDNIT] Login OK — JSESSIONID=${loginResult.session.jsessionid.substring(0, 8)}...`);

  /* 2. Buscar a ficha contratual */
  const fichaResult = await buscarFichaContratual(loginResult.session, numero_contrato);
  if (!fichaResult.ok || !fichaResult.data) {
    console.log(`[SISDNIT] Ficha falhou: ${fichaResult.error}`);
    res.status(502).json({ error: fichaResult.error });
    return;
  }

  const ficha = fichaResult.data;
  const camposPreenchidos = Object.entries(ficha)
    .filter(([k, v]) => k !== 'campos_extras' && k !== 'aditivos' && v)
    .length;

  console.log(`[SISDNIT] Ficha contratual do contrato ${numero_contrato}: ${camposPreenchidos} campos preenchidos, ${ficha.aditivos.length} aditivos.`);

  res.json({
    ok: true,
    resultado: ficha,
    /* Para debug: primeiros 2000 chars do HTML original */
    _debug_html: process.env.NODE_ENV !== 'production' ? fichaResult.html?.substring(0, 2000) : undefined,
  });
});
