/**
 * Rotas de integração SIAC — /api/siac
 *
 * Acesso DIRETO ao SISDNIT via login + JSON-RPC + scraping.
 * Não depende do SIGO — tudo é feito pelo nosso servidor.
 *
 * POST /api/siac/contrato-completo   — busca todos os dados de um contrato
 * POST /api/siac/listar-contratos    — lista contratos de uma unidade
 * POST /api/siac/listar-unidades     — lista unidades do DNIT
 * POST /api/siac/ficha-contratual    — busca ficha contratual
 * POST /api/siac/resumo              — busca resumo do contrato
 * POST /api/siac/login-test          — testa login no SISDNIT
 *
 * Credenciais SIAC podem vir no body ou do .env (SIAC_CPF, SIAC_SENHA).
 */
import { Router, Request, Response } from 'express';
import {
  loginSisdnit,
  listarUnidades,
  listarContratos,
  buscarContratoPorNumero,
  buscarFichaContratual,
  buscarResumoContrato,
  buscarContratoCompleto,
  buscarUnidadePorUf,
} from '../lib/sisdnit-client.js';

export const siacRouter = Router();

/* ── Credenciais SIAC padrão (do .env) ── */
function getSiacCredentials(body: { cpf?: string; senha?: string; fiscalizadora?: string }) {
  return {
    cpf: body.cpf || process.env.SIAC_CPF || '',
    senha: body.senha || process.env.SIAC_SENHA || '',
    fiscalizadora: body.fiscalizadora || process.env.SIAC_FISCALIZADORA || 'RN',
  };
}

/* ══════════════════════════════════════════
   POST /api/siac/login-test — testa login no SISDNIT
   ══════════════════════════════════════════ */
siacRouter.post('/login-test', async (req: Request, res: Response) => {
  const { cpf, senha } = getSiacCredentials(req.body);

  if (!cpf || !senha) {
    res.status(400).json({ error: 'Credenciais SIAC não informadas.' });
    return;
  }

  console.log(`[SIAC] Testando login SISDNIT...`);
  const result = await loginSisdnit(cpf, senha);

  if (!result.ok) {
    res.status(401).json({ error: result.error });
    return;
  }

  res.json({
    ok: true,
    message: 'Login no SISDNIT OK!',
    session: result.session?.jsessionid.substring(0, 8) + '...',
  });
});

/* ══════════════════════════════════════════
   POST /api/siac/listar-unidades — lista unidades do DNIT
   ══════════════════════════════════════════ */
siacRouter.post('/listar-unidades', async (req: Request, res: Response) => {
  const { cpf, senha } = getSiacCredentials(req.body);

  if (!cpf || !senha) {
    res.status(400).json({ error: 'Credenciais SIAC não informadas.' });
    return;
  }

  const loginRes = await loginSisdnit(cpf, senha);
  if (!loginRes.ok || !loginRes.session) {
    res.status(401).json({ error: loginRes.error });
    return;
  }

  const result = await listarUnidades(loginRes.session);
  if (!result.ok) {
    res.status(502).json({ error: result.error });
    return;
  }

  res.json({ ok: true, resultado: result.data });
});

/* ══════════════════════════════════════════
   POST /api/siac/listar-contratos — lista contratos de uma unidade
   ══════════════════════════════════════════ */
siacRouter.post('/listar-contratos', async (req: Request, res: Response) => {
  const { cpf, senha, fiscalizadora } = getSiacCredentials(req.body);

  if (!cpf || !senha) {
    res.status(400).json({ error: 'Credenciais SIAC não informadas.' });
    return;
  }

  const loginRes = await loginSisdnit(cpf, senha);
  if (!loginRes.ok || !loginRes.session) {
    res.status(401).json({ error: loginRes.error });
    return;
  }

  // Encontrar unidade pela UF
  const unidadeId = await buscarUnidadePorUf(loginRes.session, fiscalizadora);
  if (!unidadeId) {
    res.status(404).json({ error: `Unidade para "${fiscalizadora}" não encontrada.` });
    return;
  }

  const result = await listarContratos(loginRes.session, unidadeId);
  if (!result.ok) {
    res.status(502).json({ error: result.error });
    return;
  }

  console.log(`[SIAC] ${result.data?.length} contratos encontrados para ${fiscalizadora}.`);
  res.json({ ok: true, unidade_id: unidadeId, resultado: result.data });
});

/* ══════════════════════════════════════════
   POST /api/siac/contrato-completo
   Busca TODOS os dados de um contrato direto do SISDNIT
   Substitui completamente o SIGO!
   ══════════════════════════════════════════ */
siacRouter.post('/contrato-completo', async (req: Request, res: Response) => {
  const { numero_contrato } = req.body;
  const { cpf, senha, fiscalizadora } = getSiacCredentials(req.body);

  if (!numero_contrato) {
    res.status(400).json({ error: 'Campo obrigatório: numero_contrato.' });
    return;
  }
  if (!cpf || !senha) {
    res.status(400).json({ error: 'Credenciais SIAC não informadas e não configuradas no servidor.' });
    return;
  }

  console.log(`[SIAC] Buscando contrato completo ${numero_contrato} (${fiscalizadora}) — direto SISDNIT...`);

  const result = await buscarContratoCompleto(cpf, senha, numero_contrato, fiscalizadora);

  if (!result.ok) {
    console.log(`[SIAC] Erro: ${result.error}`);
    res.status(502).json({ error: result.error });
    return;
  }

  console.log(`[SIAC] Contrato ${numero_contrato}: OK — ${JSON.stringify(result.data).length} bytes.`);
  res.json({ ok: true, resultado: result.data });
});

/* ══════════════════════════════════════════
   POST /api/siac/resumo — busca resumo do contrato
   Compatibilidade com o front existente
   ══════════════════════════════════════════ */
siacRouter.post('/resumo', async (req: Request, res: Response) => {
  const { numero_contrato } = req.body;
  const { cpf, senha, fiscalizadora } = getSiacCredentials(req.body);

  if (!numero_contrato) {
    res.status(400).json({ error: 'Campo obrigatório: numero_contrato.' });
    return;
  }
  if (!cpf || !senha) {
    res.status(400).json({ error: 'Credenciais SIAC não informadas.' });
    return;
  }

  console.log(`[SIAC] Buscando resumo do contrato ${numero_contrato}...`);

  // Redirecionar para contrato-completo
  const result = await buscarContratoCompleto(cpf, senha, numero_contrato, fiscalizadora);

  if (!result.ok) {
    res.status(502).json({ error: result.error });
    return;
  }

  res.json({ ok: true, resultado: result.data });
});

/* ══════════════════════════════════════════
   POST /api/siac/ficha-contratual
   Busca ficha contratual do SISDNIT
   ══════════════════════════════════════════ */
siacRouter.post('/ficha-contratual', async (req: Request, res: Response) => {
  const { numero_contrato } = req.body;
  const { cpf, senha, fiscalizadora } = getSiacCredentials(req.body);

  if (!numero_contrato) {
    res.status(400).json({ error: 'Campo obrigatório: numero_contrato.' });
    return;
  }
  if (!cpf || !senha) {
    res.status(400).json({ error: 'Credenciais SIAC não informadas.' });
    return;
  }

  console.log(`[SISDNIT] Buscando ficha contratual do contrato ${numero_contrato}...`);

  /* Login */
  const loginRes = await loginSisdnit(cpf, senha);
  if (!loginRes.ok || !loginRes.session) {
    res.status(401).json({ error: loginRes.error });
    return;
  }

  /* Encontrar unidade */
  const unidadeId = await buscarUnidadePorUf(loginRes.session, fiscalizadora);
  if (!unidadeId) {
    res.status(404).json({ error: `Unidade ${fiscalizadora} não encontrada.` });
    return;
  }

  /* Encontrar contrato */
  const contratoRes = await buscarContratoPorNumero(loginRes.session, unidadeId, numero_contrato);
  if (!contratoRes.ok || !contratoRes.data) {
    res.status(404).json({ error: contratoRes.error });
    return;
  }

  /* Buscar ficha */
  const fichaRes = await buscarFichaContratual(loginRes.session, unidadeId, contratoRes.data.id);
  if (!fichaRes.ok || !fichaRes.data) {
    res.status(502).json({ error: fichaRes.error });
    return;
  }

  res.json({ ok: true, resultado: fichaRes.data });
});

/* ══════════════════════════════════════════
   Rotas legado (SIGO) — mantidas para compatibilidade
   Redirecionam para a implementação direta
   ══════════════════════════════════════════ */

// POST /api/siac/consultar — mantido por compatibilidade
siacRouter.post('/consultar', async (req: Request, res: Response) => {
  const { tipo, numero_contrato } = req.body;
  const { cpf, senha, fiscalizadora } = getSiacCredentials(req.body);

  if (!tipo || !numero_contrato) {
    res.status(400).json({ error: 'Campos obrigatórios: tipo, numero_contrato.' });
    return;
  }
  if (!cpf || !senha) {
    res.status(400).json({ error: 'Credenciais SIAC não informadas.' });
    return;
  }

  // Redirecionar para contrato-completo
  const result = await buscarContratoCompleto(cpf, senha, numero_contrato, fiscalizadora);
  if (!result.ok) {
    res.status(502).json({ error: result.error });
    return;
  }

  res.json({ ok: true, resultado: result.data });
});

// POST /api/siac/historico — compatibilidade
siacRouter.post('/historico', async (_req: Request, res: Response) => {
  res.status(501).json({
    error: 'Endpoint /historico não disponível na integração direta. Use /contrato-completo.',
  });
});

// POST /api/siac/medicao — compatibilidade
siacRouter.post('/medicao', async (_req: Request, res: Response) => {
  res.status(501).json({
    error: 'Endpoint /medicao não disponível na integração direta. Use /contrato-completo.',
  });
});
