/**
 * SISDNIT Client — acesso direto ao SISDNIT via HTTP + JSON-RPC
 *
 * Substitui a dependência do SIGO para consultas ao SIAC.
 * Usa o endpoint JSON-RPC para dados estruturados e
 * form submission + PDF parsing para relatórios (ficha contratual, resumo).
 *
 * Fluxo:
 *   1. POST login com senha MD5 → captura JSESSIONID
 *   2. Navega até SIAC e Contratos (registra objetos JSON-RPC)
 *   3. Chama métodos JSON-RPC ou submete formulários → parseia PDF
 */

import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import { createRequire } from 'module';

// pdf-parse v1 is CommonJS — use createRequire for ESM compatibility
const require = createRequire(import.meta.url);
const pdf: (buffer: Buffer) => Promise<{ text: string; numpages: number }> = require('pdf-parse');

const SISDNIT_BASE = 'https://sisdnit.dnit.gov.br/sisdnit';
const JSONRPC_URL = `${SISDNIT_BASE}/JSON-RPC`;

/* ══════════════════════════════════════════
   Tipos
   ══════════════════════════════════════════ */

export interface SisdnitSession {
  jsessionid: string;
  cookies: string;
  /** Timestamp do login (para controlar expiração) */
  loginAt: number;
}

export interface ContratoItem {
  id: number;
  /** Ex: "00 00587/2019 - EMPRESA X LTDA" */
  descricao: string;
  /** Número do contrato extraído (ex: "00587/2019") */
  numero: string;
  /** Nome da empresa extraído */
  empresa: string;
}

export interface UnidadeItem {
  id: number;
  descricao: string;
  sigla: string;
}

export interface FichaContratual {
  contrato: string;
  objeto: string;
  empresa: string;
  cnpj: string;
  fiscal: string;
  superintendencia: string;
  rodovia: string;
  uf: string;
  extensao: string;
  trecho: string;
  valor_original: string;
  valor_atual: string;
  data_assinatura: string;
  data_inicio: string;
  data_fim: string;
  prazo_original: string;
  prazo_atual: string;
  situacao: string;
  tipo_contrato: string;
  campos_extras: Record<string, string>;
  aditivos: Array<Record<string, string>>;
}

export interface ResumoContrato {
  contrato: string;
  empresa: string;
  cnpj: string;
  rodovia: string;
  uf: string;
  extensao: string;
  trecho: string;
  objeto: string;
  valor_contrato: string;
  valor_atual: string;
  situacao: string;
  data_assinatura: string;
  /** Itens da planilha se disponíveis */
  itens: Array<{
    numero: string;
    descricao: string;
    unidade: string;
    quantidade: string;
    preco_unitario: string;
    valor_total: string;
  }>;
  /** Todos os campos extraídos */
  campos_extras: Record<string, string>;
}

/* ══════════════════════════════════════════
   Cache de sessão — evita re-login a cada request
   ══════════════════════════════════════════ */

let cachedSession: SisdnitSession | null = null;
const SESSION_TTL = 25 * 60 * 1000; // 25 min (SISDNIT expira em ~30 min)

function isSessionValid(): boolean {
  if (!cachedSession) return false;
  return Date.now() - cachedSession.loginAt < SESSION_TTL;
}

/* ══════════════════════════════════════════
   Login
   ══════════════════════════════════════════ */

/**
 * Login no SISDNIT.
 * - Senha é hasheada com MD5 antes do envio (replicando o JS do front)
 * - CPF pode ser com ou sem formatação
 * - O captcha (hCaptcha) é apenas client-side, não validado no servidor
 */
export async function loginSisdnit(
  cpf: string,
  senha: string,
): Promise<{ ok: boolean; session?: SisdnitSession; error?: string }> {
  // Reusar sessão válida
  if (isSessionValid() && cachedSession) {
    return { ok: true, session: cachedSession };
  }

  const cpfFormatted = formatCpf(cpf);
  const senhaMd5 = createHash('md5').update(senha).digest('hex');

  /* 1. GET login page → captura JSESSIONID */
  let loginPage: globalThis.Response;
  try {
    loginPage = await fetch(`${SISDNIT_BASE}/jsp/login.do`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  } catch (err: any) {
    return { ok: false, error: `Conexão com SISDNIT falhou: ${err.message}` };
  }

  const initCookies = extractAllCookies(loginPage.headers);
  const jsessionid = extractCookieValue(initCookies, 'JSESSIONID');

  if (!jsessionid) {
    return { ok: false, error: 'SISDNIT não retornou JSESSIONID.' };
  }

  /* 2. POST login com senha MD5 */
  const cookieHeader = buildCookieHeader(initCookies);
  const formBody = new URLSearchParams({
    cpf: cpfFormatted,
    senha: senhaMd5,
    tipoAcao: 'executarLogin',
    tokenCaptcha: '',
    method: 'executarLogin',
  });

  let postRes: globalThis.Response;
  try {
    postRes = await fetch(`${SISDNIT_BASE}/jsp/login.do`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader,
      },
      body: formBody.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  } catch (err: any) {
    return { ok: false, error: `POST login falhou: ${err.message}` };
  }

  /* Merge cookies */
  const postCookies = extractAllCookies(postRes.headers);
  const allCookies = { ...initCookies, ...postCookies };
  const finalCookie = buildCookieHeader(allCookies);

  /* Verificar se logou com sucesso */
  if (postRes.status === 302) {
    const loc = postRes.headers.get('location') || '';
    if (loc.includes('login.do')) {
      return { ok: false, error: 'Login falhou — CPF ou senha inválidos.' };
    }
  }

  if (postRes.status === 200) {
    const body = await postRes.text();
    // Se ainda está na página de login, falhou
    if (body.includes('LoginForm') && body.includes('senhaTemp')) {
      return { ok: false, error: 'Login falhou — CPF ou senha inválidos.' };
    }
  }

  const session: SisdnitSession = {
    jsessionid: extractCookieValue(allCookies, 'JSESSIONID') || jsessionid,
    cookies: finalCookie,
    loginAt: Date.now(),
  };

  /* 3. Visitar SIAC para registrar objetos JSON-RPC */
  await initSiacSession(session);

  cachedSession = session;
  console.log(`[SISDNIT] Login OK — sessão ${session.jsessionid.substring(0, 8)}...`);
  return { ok: true, session };
}

/**
 * Visita as páginas necessárias para registrar os objetos JSON-RPC na sessão
 */
async function initSiacSession(session: SisdnitSession): Promise<void> {
  try {
    // Visitar página SIAC
    await fetch(`${SISDNIT_BASE}/jsp/siac/siac.do?tipoAcao=siac`, {
      headers: { Cookie: session.cookies },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });

    // Visitar Contratos (registra ajaxContrato)
    await fetch(`${SISDNIT_BASE}/jsp/siac/consulta_contrato.do?tipoAcao=reset`, {
      headers: { Cookie: session.cookies },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });

    console.log('[SISDNIT] Sessão SIAC inicializada.');
  } catch (err: any) {
    console.log(`[SISDNIT] Aviso: falha ao inicializar SIAC: ${err.message}`);
  }
}

/* ══════════════════════════════════════════
   JSON-RPC — chamadas estruturadas
   ══════════════════════════════════════════ */

let jsonRpcId = 0;

async function jsonRpcCall(
  session: SisdnitSession,
  method: string,
  params: any[] = [],
): Promise<{ ok: boolean; result?: any; error?: string }> {
  jsonRpcId++;

  let res: globalThis.Response;
  try {
    res = await fetch(JSONRPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': session.cookies,
      },
      body: JSON.stringify({ id: jsonRpcId, method, params }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err: any) {
    return { ok: false, error: `JSON-RPC falhou: ${err.message}` };
  }

  if (!res.ok) {
    return { ok: false, error: `JSON-RPC HTTP ${res.status}` };
  }

  const data = await res.json();

  if (data.error) {
    // Se sessão expirou, invalidar cache
    if (data.error.msg?.includes('session') || data.error.code === 591) {
      cachedSession = null;
    }
    return { ok: false, error: data.error.msg || 'Erro JSON-RPC' };
  }

  return { ok: true, result: data.result };
}

/**
 * Extrai a lista de itens de um resultado JSON-RPC (ArrayList pattern)
 */
function extractList(result: any): Array<{ id: number; descricao: string }> {
  if (!result) return [];
  if (result.list) return result.list;
  if (Array.isArray(result)) return result;
  return [];
}

/* ══════════════════════════════════════════
   API pública — Unidades
   ══════════════════════════════════════════ */

export async function listarUnidades(
  session: SisdnitSession,
): Promise<{ ok: boolean; data?: UnidadeItem[]; error?: string }> {
  const res = await jsonRpcCall(session, 'ajaxContrato.buscarListaUnidades');
  if (!res.ok) return { ok: false, error: res.error };

  const items = extractList(res.result).map((item) => ({
    id: item.id,
    descricao: item.descricao,
    sigla: extractSiglaUnidade(item.descricao),
  }));

  return { ok: true, data: items };
}

/**
 * Encontra o ID da unidade pela sigla do estado (ex: "RN" → id 36)
 */
export async function buscarUnidadePorUf(
  session: SisdnitSession,
  uf: string,
): Promise<number | null> {
  const res = await listarUnidades(session);
  if (!res.ok || !res.data) return null;

  const ufUpper = uf.toUpperCase();

  // Prioridade 1: S.R.E exata (Superintendência Regional)
  const sre = res.data.find(
    (u) => u.descricao.includes(`S.R.E - ${ufUpper}`) || u.descricao.includes(`S.R.E- ${ufUpper}`),
  );
  if (sre) return sre.id;

  // Prioridade 2: sigla exata
  const bySigla = res.data.find((u) => u.sigla === ufUpper);
  if (bySigla) return bySigla.id;

  // Prioridade 3: "- UF -" no nome (evita match parcial como "INTERNA" → "RN")
  const byDash = res.data.find(
    (u) => u.descricao.includes(`- ${ufUpper} -`) || u.descricao.endsWith(`- ${ufUpper}`),
  );
  return byDash?.id ?? null;
}

/* ══════════════════════════════════════════
   API pública — Contratos
   ══════════════════════════════════════════ */

/**
 * Lista todos os contratos de uma unidade.
 * Retorna id (database), número formatado e empresa.
 */
export async function listarContratos(
  session: SisdnitSession,
  unidadeId: number,
): Promise<{ ok: boolean; data?: ContratoItem[]; error?: string }> {
  const res = await jsonRpcCall(session, 'ajaxContrato.buscarContratosFormatadoSiac', [
    String(unidadeId),
  ]);

  if (!res.ok) return { ok: false, error: res.error };

  const items = extractList(res.result).map((item) => {
    const { numero, empresa } = parseContratoDescricao(item.descricao);
    return { id: item.id, descricao: item.descricao, numero, empresa };
  });

  return { ok: true, data: items };
}

/**
 * Busca um contrato por número (ex: "00587/2019-31" ou "587/2019").
 * Procura na lista de contratos da unidade.
 */
export async function buscarContratoPorNumero(
  session: SisdnitSession,
  unidadeId: number,
  numeroContrato: string,
): Promise<{ ok: boolean; data?: ContratoItem; error?: string }> {
  const listRes = await listarContratos(session, unidadeId);
  if (!listRes.ok || !listRes.data) {
    return { ok: false, error: listRes.error || 'Nenhum contrato encontrado.' };
  }

  // Normalizar o número para busca
  const numNorm = normalizeContractNumber(numeroContrato);

  const found = listRes.data.find((c) => {
    const cNorm = normalizeContractNumber(c.numero);
    return cNorm === numNorm || cNorm.includes(numNorm) || numNorm.includes(cNorm);
  });

  if (!found) {
    return {
      ok: false,
      error: `Contrato "${numeroContrato}" não encontrado na unidade ${unidadeId}. ${listRes.data.length} contratos disponíveis.`,
    };
  }

  return { ok: true, data: found };
}

/* ══════════════════════════════════════════
   API pública — Ficha Contratual
   ══════════════════════════════════════════ */

/**
 * Busca a ficha contratual detalhada via form submission.
 * Tenta gerar o relatório via POST para relatorio_ficha_contratual.do.
 */
export async function buscarFichaContratual(
  session: SisdnitSession,
  unidadeId: number,
  contratoId: number,
): Promise<{ ok: boolean; data?: FichaContratual; html?: string; error?: string }> {
  // Visitar a página do relatório primeiro
  await fetch(`${SISDNIT_BASE}/jsp/siac/relatorio_ficha_contratual.do?tipoAcao=reset`, {
    headers: { Cookie: session.cookies },
    signal: AbortSignal.timeout(10000),
  });

  // Submeter o formulário
  const formBody = new URLSearchParams({
    idFiscalizacaoUnidadeResponsavel: String(unidadeId),
    codContrato: String(contratoId),
    tipoAcao: 'gerar',
  });

  let res: globalThis.Response;
  try {
    res = await fetch(`${SISDNIT_BASE}/jsp/siac/relatorio_ficha_contratual.do`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': session.cookies,
      },
      body: formBody.toString(),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
  } catch (err: any) {
    return { ok: false, error: `Falha ao gerar ficha: ${err.message}` };
  }

  const contentType = res.headers.get('content-type') || '';

  // O relatório retorna PDF — parsear o texto do PDF
  if (contentType.includes('application/pdf')) {
    const buffer = Buffer.from(await res.arrayBuffer());
    console.log(`[SISDNIT] Ficha contratual PDF: ${buffer.length} bytes`);
    try {
      const pdfData = await pdf(buffer);
      const data = parsePDFFichaContratual(pdfData.text);
      return { ok: true, data };
    } catch (err: any) {
      return { ok: false, error: `Falha ao parsear PDF da ficha: ${err.message}` };
    }
  }

  const html = await res.text();

  if (html.length < 200 || html.includes('LoginForm')) {
    cachedSession = null;
    return { ok: false, error: 'Sessão expirou. Tente novamente.' };
  }

  // Fallback: tentar parsear como HTML
  const data = parseHTMLFichaContratual(html);
  return { ok: true, data, html: html.substring(0, 5000) };
}

/* ══════════════════════════════════════════
   API pública — Resumo do Contrato
   ══════════════════════════════════════════ */

/**
 * Busca o resumo do contrato (itens, valores) via form submission.
 */
export async function buscarResumoContrato(
  session: SisdnitSession,
  unidadeId: number,
  contratoId: number,
): Promise<{ ok: boolean; data?: ResumoContrato; html?: string; error?: string }> {
  // Visitar a página do relatório primeiro
  await fetch(`${SISDNIT_BASE}/jsp/siac/relatorio_resumo_contrato.do?tipoAcao=reset`, {
    headers: { Cookie: session.cookies },
    signal: AbortSignal.timeout(10000),
  });

  const formBody = new URLSearchParams({
    idFiscalizacaoUnidadeResponsavel: String(unidadeId),
    codContrato: String(contratoId),
    tipoAcao: 'gerar',
  });

  let res: globalThis.Response;
  try {
    res = await fetch(`${SISDNIT_BASE}/jsp/siac/relatorio_resumo_contrato.do`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': session.cookies,
      },
      body: formBody.toString(),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
  } catch (err: any) {
    return { ok: false, error: `Falha ao gerar resumo: ${err.message}` };
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/pdf')) {
    const buffer = Buffer.from(await res.arrayBuffer());
    console.log(`[SISDNIT] Resumo contrato PDF: ${buffer.length} bytes`);
    try {
      const pdfData = await pdf(buffer);
      const data = parsePDFResumoContrato(pdfData.text);
      return { ok: true, data };
    } catch (err: any) {
      return { ok: false, error: `Falha ao parsear PDF do resumo: ${err.message}` };
    }
  }

  const html = await res.text();

  if (html.length < 200 || html.includes('LoginForm')) {
    cachedSession = null;
    return { ok: false, error: 'Sessão expirou. Tente novamente.' };
  }

  const data = parseHTMLResumoContrato(html);
  return { ok: true, data, html: html.substring(0, 5000) };
}

/* ══════════════════════════════════════════
   API pública — Busca completa (substitui SIGO)
   ══════════════════════════════════════════ */

export interface DadosContratoCompleto {
  contrato: string;
  contrato_id: number;
  empresa: string;
  cnpj: string;
  rodovia: string;
  uf: string;
  extensao: string;
  trecho: string;
  objeto: string;
  valor_contrato: string;
  valor_atual: string;
  situacao: string;
  fiscal: string;
  data_assinatura: string;
  data_inicio: string;
  data_fim: string;
  tipo_contrato: string;
  itens: ResumoContrato['itens'];
  aditivos: FichaContratual['aditivos'];
  campos_extras: Record<string, string>;
}

/**
 * Busca todos os dados de um contrato direto do SISDNIT.
 * Substitui completamente o SIGO:
 *   1. Login + busca contrato por número
 *   2. Ficha contratual (empresa, rodovia, valores, aditivos)
 *   3. Resumo (itens da planilha)
 */
export async function buscarContratoCompleto(
  cpf: string,
  senha: string,
  numeroContrato: string,
  uf: string = 'RN',
): Promise<{ ok: boolean; data?: DadosContratoCompleto; error?: string }> {
  /* 1. Login */
  const loginRes = await loginSisdnit(cpf, senha);
  if (!loginRes.ok || !loginRes.session) {
    return { ok: false, error: loginRes.error };
  }
  const session = loginRes.session;

  /* 2. Encontrar unidade por UF */
  const unidadeId = await buscarUnidadePorUf(session, uf);
  if (!unidadeId) {
    return { ok: false, error: `Unidade para UF "${uf}" não encontrada no SISDNIT.` };
  }
  console.log(`[SISDNIT] Unidade ${uf} = ${unidadeId}`);

  /* 3. Buscar contrato por número */
  const contratoRes = await buscarContratoPorNumero(session, unidadeId, numeroContrato);
  if (!contratoRes.ok || !contratoRes.data) {
    return { ok: false, error: contratoRes.error };
  }
  const contrato = contratoRes.data;
  console.log(`[SISDNIT] Contrato encontrado: id=${contrato.id}, empresa="${contrato.empresa}"`);

  /* 4. Buscar ficha contratual e resumo em paralelo */
  const [fichaRes, resumoRes] = await Promise.all([
    buscarFichaContratual(session, unidadeId, contrato.id).catch((e) => ({
      ok: false as const,
      error: e.message,
      data: undefined,
      html: undefined,
    })),
    buscarResumoContrato(session, unidadeId, contrato.id).catch((e) => ({
      ok: false as const,
      error: e.message,
      data: undefined,
      html: undefined,
    })),
  ]);

  const ficha = fichaRes.data;
  const resumo = resumoRes.data;

  /* 5. Montar resultado combinado */
  const data: DadosContratoCompleto = {
    contrato: contrato.numero,
    contrato_id: contrato.id,
    empresa: ficha?.empresa || resumo?.empresa || contrato.empresa || '',
    cnpj: ficha?.cnpj || resumo?.cnpj || '',
    rodovia: ficha?.rodovia || resumo?.rodovia || '',
    uf: ficha?.uf || resumo?.uf || uf,
    extensao: ficha?.extensao || resumo?.extensao || '',
    trecho: ficha?.trecho || resumo?.trecho || '',
    objeto: ficha?.objeto || resumo?.objeto || '',
    valor_contrato: ficha?.valor_original || resumo?.valor_contrato || '',
    valor_atual: ficha?.valor_atual || resumo?.valor_atual || '',
    situacao: ficha?.situacao || resumo?.situacao || '',
    fiscal: ficha?.fiscal || '',
    data_assinatura: ficha?.data_assinatura || resumo?.data_assinatura || '',
    data_inicio: ficha?.data_inicio || '',
    data_fim: ficha?.data_fim || '',
    tipo_contrato: ficha?.tipo_contrato || '',
    itens: resumo?.itens || [],
    aditivos: ficha?.aditivos || [],
    campos_extras: { ...(resumo?.campos_extras || {}), ...(ficha?.campos_extras || {}) },
  };

  console.log(
    `[SISDNIT] Contrato ${numeroContrato}: empresa="${data.empresa}", rodovia="${data.rodovia}", ` +
      `extensão="${data.extensao}", ${data.itens.length} itens, ${data.aditivos.length} aditivos.`,
  );

  return { ok: true, data };
}

/* ══════════════════════════════════════════
   PDF Parsers — ficha contratual e resumo
   ══════════════════════════════════════════ */

/**
 * Parseia o texto extraído do PDF da Ficha Contratual.
 *
 * O PDF tem layout tabular com múltiplas colunas — a extração de texto
 * lineariza colunas de forma imprevisível. Usamos regexes resilientes
 * e fallbacks para cada campo.
 */
function parsePDFFichaContratual(text: string): FichaContratual {
  const campos: Record<string, string> = {};

  // Empresa Executora — "CNPJ - NOME"
  const empresaMatch = text.match(
    /Empresa\s+Executora\s*([\d./-]+)\s*-\s*(.+?)(?:\n|Nº do Convênio)/s,
  );
  const cnpj = empresaMatch?.[1]?.trim() || '';
  const empresa = empresaMatch?.[2]?.trim() || '';

  // Contrato — "NN NNNNN/YYYY" → normalizar para "NNNNN/YYYY"
  const contratoMatch = text.match(/\b\d{2}\s+(\d{5}\/\d{4})\b/);
  const contrato = contratoMatch?.[1] || '';

  // Situação — buscar "ATIVO EM dd/mm/yyyy" ou padrão similar primeiro
  const situacaoAtivo = text.match(/(ATIVO\s+EM\s+\d{2}\/\d{2}\/\d{4})/);
  const situacaoEncerrado = text.match(/(ENCERRADO|PARALISADO|RESCINDIDO|SUSPENSO)/i);
  const situacao = situacaoAtivo?.[1] || situacaoEncerrado?.[1] || '';

  // Tipo do Contrato — buscar "OBRA DE ENGENHARIA", "SERVIÇO", etc. que aparece antes de "ATIVO/LIBERADO"
  const tipoMatch = text.match(/(OBRA\s+DE\s+ENGENHARIA|SERVIÇO|OBRA|CONSULTORIA)/i);
  const tipoContrato = tipoMatch?.[1]?.trim() || '';

  // Objeto do Contrato — texto entre "Objeto do Contrato" e "UNIDADES RESPONSÁVEIS"
  const objetoMatch = text.match(
    /Objeto\s+do\s+Contrato\s*\n([\s\S]*?)(?:UNIDADES\s+RESPONS)/i,
  );
  const objeto = objetoMatch?.[1]?.replace(/\s+/g, ' ').trim() || '';

  // Fiscal — nome de pessoa (MAIÚSCULAS com acentos, 2+ palavras)
  // Aparece após o label "Fiscal" na seção UNIDADES RESPONSÁVEIS
  // O label "Fiscal" vem antes de nomes de unidades (SEDE, COORDENAÇÃO...)
  // e o nome do fiscal vem depois — é o nome de pessoa (não cargo/unidade)
  const fiscalSection = text.match(
    /Fiscal\s*\n([\s\S]*?)(?:LOCALIZAÇÃO\s+DA\s+OBRA|UFVia)/i,
  );
  let fiscal = '';
  if (fiscalSection) {
    // Procurar nomes de pessoa (não organizações) — duas ou mais palavras em maiúsculas
    // sem COORDENAÇÃO, SUPERINTENDÊNCIA, SEDE, DIRETORIA etc.
    const lines = fiscalSection[1].split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (
        /^[A-ZÁÀÃÂÉÊÍÓÔÕÚÇ][A-ZÁÀÃÂÉÊÍÓÔÕÚÇ\s]{5,}$/.test(line) &&
        !/(COORD|SUPER|SEDE|DIRET|GERÊN|UNID|GESTÃO|OPERAÇ|SUBST)/i.test(line)
      ) {
        fiscal = line;
        break;
      }
    }
  }

  // Localização — UF, rodovia, extensão, trecho
  const locSection = text.match(
    /LOCALIZAÇÃO\s+DA\s+OBRA\s*([\s\S]*?)(?:Extensão\s+Total|Solicitado\s+por)/i,
  );
  const locText = locSection?.[1] || '';

  // UF — 2 letras seguidas de "null" ou "BR-" na seção de localização
  const ufMatch = locText.match(/([A-Z]{2})(?:null|BR-)/);
  const uf = ufMatch?.[1] || '';

  // Rodovias — BR-XXX (pode vir como "nullBR-163" no PDF)
  const rodovias = [...locText.matchAll(/(BR-\d{3})/g)].map((m) => m[1]);
  const rodoviasUnicas = [...new Set(rodovias)];
  const rodovia = rodoviasUnicas.join(', ');

  // Extensão Total
  const extMatch = text.match(/Extensão\s+Total\s*([\d.,]+)/);
  const extensao = extMatch?.[1] || '';

  // Trecho — descrição do segmento (texto descritivo após os números de km)
  // O texto tem padrão: "0,000,000,00Trecho descritivo aqui"
  const trechoMatch = locText.match(
    /\d+,\d+([A-ZÁÀÃÂÉÊÍÓÔÕÚÇ].+?)(?:\nPNV|$)/m,
  );
  const trecho = trechoMatch?.[1]?.replace(/\s+/g, ' ').trim() || '';

  // ── Datas ──
  // A seção DATAS tem labels em coluna e valores em coluna separada.
  // Padrão: "Data da Publicação\nData da Aprovação\nData da Proposta\nData da Assinatura\nDD/MM/YYYY\n..."
  // Extrair as 4 datas após os 4 labels
  const datasSection = text.match(
    /Data\s+da\s+Publicação\s*\n[\s\S]*?Data\s+da\s+Assinatura\s*\n([\s\S]*?)(?:Data-Base|REAJUST)/i,
  );
  let dataAssinatura = '';
  if (datasSection) {
    const dates = datasSection[1].match(/\d{2}\/\d{2}\/\d{4}/g) || [];
    // Ordem: Publicação, Aprovação, Proposta, Assinatura
    dataAssinatura = dates[3] || dates[dates.length - 1] || '';
  }
  // Fallback: procurar "Data da Assinatura" seguida de data diretamente
  if (!dataAssinatura) {
    const m = text.match(/Data\s+da\s+Assinatura\s*\n?\s*(\d{2}\/\d{2}\/\d{4})/);
    dataAssinatura = m?.[1] || '';
  }

  // Início e Término dos Serviços
  // Na seção PRAZO, o texto lineariza colunas de forma imprevisível.
  // Estratégia: extrair TODAS as datas entre "PRAZO DE EXECUÇÃO" e "FONTE DE RECURSOS"
  // e usar posição + contexto.
  const prazoSection = text.match(
    /PRAZO\s+DE\s+EXECUÇÃO\s*([\s\S]*?)(?:FONTE\s+DE\s+RECURSOS|REAJUST)/i,
  );
  let dataInicio = '';
  let dataFim = '';
  let prazoOriginal = '';
  let prazoAtual = '';

  if (prazoSection) {
    const pText = prazoSection[1];
    const allDates = pText.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
    // A data mais antiga é geralmente o início, a mais recente o término
    if (allDates.length >= 2) {
      const parsed = allDates.map((d) => {
        const [dd, mm, yy] = d.split('/');
        return { str: d, ts: new Date(`${yy}-${mm}-${dd}`).getTime() };
      });
      parsed.sort((a, b) => a.ts - b.ts);
      dataInicio = parsed[0].str;
      dataFim = parsed[parsed.length - 1].str;
    } else if (allDates.length === 1) {
      dataInicio = allDates[0];
    }

    // Prazo em dias
    const diasMatch = pText.match(/(\d+)\s*\n?\s*Nº\s+dias\s+para\s+a\s+Execução/);
    prazoAtual = diasMatch?.[1] || '';
    const diasOrigMatch = pText.match(
      /Nº\s+dias\s+\(Prazo\s+de\s+Execução\)\s*\n?\s*(?:CORRIDOS|ÚTEIS)\s*\n[\s\S]*?(\d{3,})/,
    );
    prazoOriginal = diasOrigMatch?.[1] || prazoAtual;
  }

  // Fallback para datas via Vigência
  if (!dataInicio || !dataFim) {
    const vigenciaMatch = text.match(
      /Início\s+da\s+Vigência\s*(\d{2}\/\d{2}\/\d{4})/,
    );
    if (vigenciaMatch && !dataInicio) dataInicio = vigenciaMatch[1];
  }

  // Valores
  const valorOrigMatch = text.match(
    /Preço\s+Inicial\s*\n?\s*PI\s+Vigente\s*\n?\s*([\d.,]+)/,
  );
  const valorOriginal = valorOrigMatch?.[1] || '';

  const valorAtualMatch = text.match(/Total\s+\(PI\s*\+\s*R\)\s*([\d.,]+)/);
  const valorAtual = valorAtualMatch?.[1] || '';

  // Superintendência / unidade fiscalização
  const superMatch = text.match(
    /Unid\.\s+Resp\.\s+Fiscalização\s*\n?\s*(.+?)(?:\n|Fiscal)/,
  );
  const superintendencia = superMatch?.[1]?.trim() || '';

  // Campos extras para debug
  campos['edital'] =
    text.match(/Nº\s+do\s+Edital\s*([\d/.-]+)/)?.[1] || '';
  campos['processo'] =
    text.match(/[\d.]+\/\d{4}-\d{2}/)?.[0] || '';
  campos['lei'] = text.match(/(\d+\.\d+\/\d{4})\s*Lei/)?.[1] || '';
  campos['regime'] =
    text.match(/Regime\s+Execução\s*(.+?)(?:\n|Objeto)/)?.[1]?.trim() || '';
  campos['desempenho'] =
    text.match(/([\d.,]+)\s*Desempenho\s+Contratual/)?.[1] || '';

  return {
    contrato,
    objeto,
    empresa,
    cnpj,
    fiscal,
    superintendencia,
    rodovia,
    uf,
    extensao,
    trecho,
    valor_original: valorOriginal,
    valor_atual: valorAtual,
    data_assinatura: dataAssinatura,
    data_inicio: dataInicio,
    data_fim: dataFim,
    prazo_original: prazoOriginal,
    prazo_atual: prazoAtual,
    situacao,
    tipo_contrato: tipoContrato,
    campos_extras: campos,
    aditivos: [], // Aditivos não aparecem na ficha PDF deste formato
  };
}

/**
 * Parseia o texto extraído do PDF do Resumo do Contrato.
 *
 * O PDF header tem:
 *   "NN NNNNN/YYYY\nEMPRESA LTDA\nRESUMO DO CONTRATO\nContrato:\nEmpresa:"
 * Os valores (contrato, empresa) aparecem ANTES dos labels no header.
 * A planilha tem itens por lote, cada lote repete os mesmos códigos.
 */
function parsePDFResumoContrato(text: string): ResumoContrato {
  const campos: Record<string, string> = {};

  // Contrato — aparece no header antes de "RESUMO DO CONTRATO"
  const contratoMatch = text.match(/\d{2}\s+(\d{5}\/\d{4})\s*\n/);
  const contrato = contratoMatch?.[1] || '';

  // Empresa — aparece na linha após o número do contrato
  const empresaMatch = text.match(/\d{2}\s+\d{5}\/\d{4}\s*\n(.+?)\s*\n/);
  const empresa = empresaMatch?.[1]?.trim() || '';

  // Unidades
  const unidFiscMatch = text.match(
    /Unidade\s+Resp\.\s+pela\s+Fiscalização:\s*\n?\s*(.+?)(?:\n|Unidade)/,
  );
  campos['unid_fiscalizacao'] = unidFiscMatch?.[1]?.trim() || '';

  // Itens da planilha — organizado por LOTES
  // Cada item aparece como: código\ndescrição\nvalor\nunidade\nSICRO\nqtde\npreço_unit\nNão
  const itens: ResumoContrato['itens'] = [];

  // Dividir texto por lotes para preservar agrupamento
  const loteRegex = /(\d+\s*-\s*LOTE\s+\d+)/g;
  const lotes = text.split(loteRegex);

  // Item regex para cada bloco
  const itemRegex =
    /(\d{5})\s*\n([A-ZÁÀÃÂÉÊÍÓÔÕÚÇ\s]+?)\s*\n([\d.,]+)\s*\n(\w+)\s*\n([\w-]+)\s*\n([\d.,]+)\s*\n([\d.,]+)\s*\n(?:Não|Sim)/g;

  let loteAtual = '';
  for (let i = 0; i < lotes.length; i++) {
    const part = lotes[i];
    const loteMatch = part.match(/(\d+)\s*-\s*LOTE\s+(\d+)/);
    if (loteMatch) {
      loteAtual = `LOTE ${loteMatch[2]}`;
      continue;
    }

    let m;
    while ((m = itemRegex.exec(part)) !== null) {
      itens.push({
        numero: m[1],
        descricao: loteAtual ? `[${loteAtual}] ${m[2].trim()}` : m[2].trim(),
        unidade: m[4],
        quantidade: m[6],
        preco_unitario: m[7],
        valor_total: m[3],
      });
    }
    // Reset lastIndex for next lote
    itemRegex.lastIndex = 0;
  }

  // Total value — last big number on "Total" line
  const totalMatch = text.match(/Total\s*\n[\s\S]*?([\d.,]{10,})\s*\n/);
  const valorContrato = totalMatch?.[1] || '';

  return {
    contrato,
    empresa,
    cnpj: '',
    rodovia: '',
    uf: '',
    extensao: '',
    trecho: '',
    objeto: '',
    valor_contrato: valorContrato,
    valor_atual: valorContrato,
    situacao: '',
    data_assinatura: '',
    itens,
    campos_extras: campos,
  };
}

/* ══════════════════════════════════════════
   HTML Parsers
   ══════════════════════════════════════════ */

function parseHTMLFichaContratual(html: string): FichaContratual {
  const $ = cheerio.load(html);
  const campos: Record<string, string> = {};

  // Padrão 1: td label + td valor
  $('table tr').each((_, row) => {
    const tds = $(row).find('td');
    for (let i = 0; i < tds.length - 1; i += 2) {
      const label = cleanText($(tds[i]).text());
      const valor = cleanText($(tds[i + 1]).text());
      if (label && valor && label.length < 100) {
        campos[normalizeLabel(label)] = valor;
      }
    }
  });

  // Padrão 2: th + td
  $('table tr').each((_, row) => {
    const th = $(row).find('th');
    const td = $(row).find('td');
    if (th.length && td.length) {
      th.each((j, thEl) => {
        const label = cleanText($(thEl).text());
        const valor = cleanText($(td.eq(j)).text());
        if (label && valor) campos[normalizeLabel(label)] = valor;
      });
    }
  });

  // Padrão 3: <label> seguido de valor
  $('label, span.label, span.rotulo, .rotulo').each((_, el) => {
    const label = cleanText($(el).text());
    const next = $(el).next();
    const valor = cleanText(next.text());
    if (label && valor) campos[normalizeLabel(label)] = valor;
  });

  // Padrão 4: <dt> / <dd>
  $('dt').each((_, dt) => {
    const label = cleanText($(dt).text());
    const dd = $(dt).next('dd');
    if (dd.length) campos[normalizeLabel(label)] = cleanText(dd.text());
  });

  // Aditivos
  const aditivos: Array<Record<string, string>> = [];
  const aditivoTable = $('table')
    .filter((_, t) => $(t).text().toLowerCase().includes('aditivo'))
    .first();
  if (aditivoTable.length) {
    const headers: string[] = [];
    aditivoTable.find('tr:first-child th, tr:first-child td').each((_, th) => {
      headers.push(cleanText($(th).text()));
    });
    aditivoTable
      .find('tr')
      .slice(1)
      .each((_, row) => {
        const adRow: Record<string, string> = {};
        $(row)
          .find('td')
          .each((j, td) => {
            adRow[normalizeLabel(headers[j] || `col_${j}`)] = cleanText($(td).text());
          });
        if (Object.values(adRow).some((v) => v)) aditivos.push(adRow);
      });
  }

  return {
    contrato: findField(campos, ['contrato', 'numero_contrato', 'nr_contrato']) || '',
    objeto: findField(campos, ['objeto', 'descricao', 'desc_objeto']) || '',
    empresa: findField(campos, ['empresa', 'contratada', 'razao_social']) || '',
    cnpj: findField(campos, ['cnpj', 'cnpj_empresa', 'cnpj_contratada']) || '',
    fiscal: findField(campos, ['fiscal', 'gestor', 'responsavel']) || '',
    superintendencia: findField(campos, ['superintendencia', 'sr', 'regional']) || '',
    rodovia: findField(campos, ['rodovia', 'br', 'rodovia_br']) || '',
    uf: findField(campos, ['uf', 'estado']) || '',
    extensao: findField(campos, ['extensao', 'extensao_km', 'km']) || '',
    trecho: findField(campos, ['trecho', 'segmento']) || '',
    valor_original: findField(campos, ['valor_original', 'valor_contrato', 'valor_inicial']) || '',
    valor_atual: findField(campos, ['valor_atual', 'valor_atualizado', 'valor_vigente']) || '',
    data_assinatura: findField(campos, ['data_assinatura', 'assinatura', 'dt_assinatura']) || '',
    data_inicio: findField(campos, ['data_inicio', 'inicio', 'dt_inicio']) || '',
    data_fim: findField(campos, ['data_fim', 'fim', 'dt_fim', 'termino']) || '',
    prazo_original: findField(campos, ['prazo_original', 'prazo', 'prazo_inicial']) || '',
    prazo_atual: findField(campos, ['prazo_atual', 'prazo_vigente']) || '',
    situacao: findField(campos, ['situacao', 'status', 'situacao_contrato']) || '',
    tipo_contrato: findField(campos, ['tipo', 'tipo_contrato', 'modalidade']) || '',
    campos_extras: campos,
    aditivos,
  };
}

function parseHTMLResumoContrato(html: string): ResumoContrato {
  const $ = cheerio.load(html);
  const campos: Record<string, string> = {};

  // Extrair pares label/valor
  $('table tr').each((_, row) => {
    const tds = $(row).find('td');
    for (let i = 0; i < tds.length - 1; i += 2) {
      const label = cleanText($(tds[i]).text());
      const valor = cleanText($(tds[i + 1]).text());
      if (label && valor && label.length < 100) {
        campos[normalizeLabel(label)] = valor;
      }
    }
  });

  $('table tr').each((_, row) => {
    const th = $(row).find('th');
    const td = $(row).find('td');
    if (th.length && td.length) {
      th.each((j, thEl) => {
        const label = cleanText($(thEl).text());
        const valor = cleanText($(td.eq(j)).text());
        if (label && valor) campos[normalizeLabel(label)] = valor;
      });
    }
  });

  // Itens da planilha
  const itens: ResumoContrato['itens'] = [];
  $('table')
    .filter((_, t) => {
      const txt = $(t).text().toLowerCase();
      return (
        txt.includes('item') &&
        (txt.includes('unidade') || txt.includes('qtd') || txt.includes('preço'))
      );
    })
    .first()
    .find('tr')
    .slice(1)
    .each((_, row) => {
      const tds = $(row).find('td');
      if (tds.length >= 4) {
        itens.push({
          numero: cleanText($(tds[0]).text()),
          descricao: cleanText($(tds[1]).text()),
          unidade: cleanText($(tds[2]).text()),
          quantidade: cleanText($(tds[3]).text()),
          preco_unitario: tds.length > 4 ? cleanText($(tds[4]).text()) : '',
          valor_total: tds.length > 5 ? cleanText($(tds[5]).text()) : '',
        });
      }
    });

  return {
    contrato: findField(campos, ['contrato', 'numero_contrato']) || '',
    empresa: findField(campos, ['empresa', 'contratada', 'razao_social']) || '',
    cnpj: findField(campos, ['cnpj']) || '',
    rodovia: findField(campos, ['rodovia', 'br']) || '',
    uf: findField(campos, ['uf', 'estado']) || '',
    extensao: findField(campos, ['extensao', 'km']) || '',
    trecho: findField(campos, ['trecho', 'segmento']) || '',
    objeto: findField(campos, ['objeto', 'descricao']) || '',
    valor_contrato: findField(campos, ['valor_original', 'valor_contrato', 'valor_inicial']) || '',
    valor_atual: findField(campos, ['valor_atual', 'valor_atualizado']) || '',
    situacao: findField(campos, ['situacao', 'status']) || '',
    data_assinatura: findField(campos, ['data_assinatura', 'assinatura']) || '',
    itens,
    campos_extras: campos,
  };
}

/* ══════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════ */

function formatCpf(cpf: string): string {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return cpf;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\n\r\t]/g, ' ')
    .trim()
    .replace(/^[:\-–—\s]+/, '')
    .replace(/[:\-–—\s]+$/, '')
    .trim();
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function findField(campos: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (campos[key]) return campos[key];
  }
  for (const key of keys) {
    for (const [campo, valor] of Object.entries(campos)) {
      if (campo.includes(key) && valor) return valor;
    }
  }
  return undefined;
}

function normalizeContractNumber(num: string): string {
  return num.replace(/\D/g, '').replace(/^0+/, '');
}

function parseContratoDescricao(desc: string): { numero: string; empresa: string } {
  // Format: "00 00587/2019 - EMPRESA LTDA" or "00 00012/2026 - EMPRESA X"
  const match = desc.match(/^(\d+)\s+(\d+\/\d+)\s*(?:-\s*(\d+))?\s*-\s*(.*)$/);
  if (match) {
    const numero = match[3] ? `${match[2]}-${match[3]}` : match[2];
    return { numero, empresa: match[4]?.trim() || '' };
  }
  // Fallback: split on " - "
  const parts = desc.split(' - ');
  return {
    numero: parts[0]?.trim() || desc,
    empresa: parts.slice(1).join(' - ').trim(),
  };
}

function extractSiglaUnidade(descricao: string): string {
  const match = descricao.match(/-\s*([A-Z]{2})\s/);
  return match ? match[1] : '';
}

function extractAllCookies(headers: Headers): Record<string, string> {
  const cookies: Record<string, string> = {};
  const setCookies = (headers as any).getSetCookie?.() || [];
  for (const sc of setCookies) {
    const nameVal = sc.split(';')[0];
    if (nameVal) {
      const [name, ...rest] = nameVal.split('=');
      cookies[name.trim()] = rest.join('=');
    }
  }
  if (Object.keys(cookies).length === 0) {
    const raw = headers.get('set-cookie');
    if (raw) {
      for (const part of raw.split(/,(?=\s*\w+=)/)) {
        const nameVal = part.split(';')[0];
        if (nameVal) {
          const [name, ...rest] = nameVal.split('=');
          cookies[name.trim()] = rest.join('=');
        }
      }
    }
  }
  return cookies;
}

function extractCookieValue(cookies: Record<string, string>, name: string): string {
  return cookies[name] || '';
}

function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}
