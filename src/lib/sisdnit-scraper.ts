/**
 * SISDNIT Scraper — acessa o SISDNIT diretamente via HTTP
 * para buscar dados que a API SIGO não expõe (ex: ficha contratual).
 *
 * Fluxo:
 *   1. POST login → captura JSESSIONID
 *   2. GET/POST a página desejada (fichaContratual.do etc.)
 *   3. Parseia o HTML com cheerio e retorna JSON
 */

import * as cheerio from 'cheerio';

const SISDNIT_BASE = 'https://sisdnit.dnit.gov.br/sisdnit';

/* ── Tipos ── */
export interface SisdnitSession {
  jsessionid: string;
  cookies: string[];
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
  /** Todos os pares label→valor encontrados na página, para campos que não mapeamos */
  campos_extras: Record<string, string>;
  /** Aditivos se houver tabela de aditivos */
  aditivos: Array<Record<string, string>>;
}

/* ── Login no SISDNIT ── */
export async function loginSisdnit(cpf: string, senha: string): Promise<{ ok: boolean; session?: SisdnitSession; error?: string }> {
  /* Primeiro, pegar a página de login para obter o JSESSIONID inicial */
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

  /* Capturar cookies da página de login */
  const initialCookies = extractCookies(loginPage.headers);
  const jsessionFromGet = extractJsessionId(initialCookies);

  /* Formatar CPF sem pontos/traço */
  const cpfClean = cpf.replace(/\D/g, '');

  /* POST login */
  const formBody = new URLSearchParams({
    cpf: cpfClean,
    senha: senha,
    method: 'login',
  });

  let postRes: globalThis.Response;
  try {
    postRes = await fetch(`${SISDNIT_BASE}/jsp/login.do`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': initialCookies.join('; '),
      },
      body: formBody.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  } catch (err: any) {
    return { ok: false, error: `Erro no POST de login: ${err.message}` };
  }

  /* Se der 302 para algo que NÃO seja login.do, é sucesso */
  const location = postRes.headers.get('location') || '';
  const postCookies = extractCookies(postRes.headers);
  const allCookies = mergeCookies(initialCookies, postCookies);
  const jsessionid = extractJsessionId(allCookies) || jsessionFromGet || '';

  if (postRes.status === 302) {
    if (location.includes('login.do')) {
      /* Voltou pro login → credenciais inválidas */
      return { ok: false, error: 'Login falhou — CPF ou senha inválidos para o SISDNIT.' };
    }
    /* Sucesso */
    return { ok: true, session: { jsessionid, cookies: allCookies } };
  }

  if (postRes.status === 200) {
    /* Pode ter ficado na mesma página (erro de login inline) */
    const body = await postRes.text();
    if (body.includes('inválid') || body.includes('incorret') || body.includes('falhou')) {
      return { ok: false, error: 'Login falhou — CPF ou senha inválidos para o SISDNIT.' };
    }
    /* Também pode ser que 200 = logou OK (sem redirect) */
    return { ok: true, session: { jsessionid, cookies: allCookies } };
  }

  return { ok: false, error: `Login retornou HTTP ${postRes.status}` };
}

/* ── Buscar Ficha Contratual ── */
export async function buscarFichaContratual(
  session: SisdnitSession,
  contrato: string,
): Promise<{ ok: boolean; data?: FichaContratual; html?: string; error?: string }> {
  const cookieHeader = session.cookies.join('; ');

  /* Tentar acessar a ficha contratual - testar vários formatos de parâmetro */
  const params = [
    `contrato=${encodeURIComponent(contrato)}`,
    `numContrato=${encodeURIComponent(contrato)}`,
    `numero_contrato=${encodeURIComponent(contrato)}`,
    `nrContrato=${encodeURIComponent(contrato)}`,
  ];

  let html = '';
  let fichaResponse: globalThis.Response | null = null;

  /* Estratégia 1: Tentar GET com diferentes parâmetros */
  for (const param of params) {
    try {
      const url = `${SISDNIT_BASE}/jsp/siac/fichaContratual.do?${param}`;
      console.log(`[SISDNIT] Tentando: ${url}`);

      fichaResponse = await fetch(url, {
        method: 'GET',
        headers: { 'Cookie': cookieHeader },
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });

      /* Se redirecionar pro login, a sessão expirou */
      const loc = fichaResponse.headers.get('location') || '';
      if (fichaResponse.status === 302 && loc.includes('login.do')) {
        return { ok: false, error: 'Sessão SISDNIT expirou. Tente novamente.' };
      }

      if (fichaResponse.status === 200) {
        html = await fichaResponse.text();
        /* Se a página tem conteúdo relevante (não é uma página de erro) */
        if (html.includes('contrato') || html.includes('Contrato') || html.includes('CONTRATO')) {
          console.log(`[SISDNIT] Ficha contratual encontrada com param: ${param}`);
          break;
        }
      }
    } catch {
      continue;
    }
  }

  /* Estratégia 2: POST se GET não funcionou */
  if (!html || html.length < 500) {
    try {
      const formBody = new URLSearchParams({
        contrato: contrato,
        numContrato: contrato,
        method: 'consultar',
      });

      fichaResponse = await fetch(`${SISDNIT_BASE}/jsp/siac/fichaContratual.do`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookieHeader,
        },
        body: formBody.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });

      if (fichaResponse.status === 200) {
        html = await fichaResponse.text();
        console.log(`[SISDNIT] Ficha via POST, tamanho: ${html.length}`);
      }
    } catch (err: any) {
      console.log(`[SISDNIT] POST falhou: ${err.message}`);
    }
  }

  if (!html || html.length < 200) {
    return { ok: false, error: 'Não foi possível acessar a ficha contratual no SISDNIT.' };
  }

  /* Parsear o HTML */
  const data = parseHTMLFichaContratual(html);
  return { ok: true, data, html: html.substring(0, 5000) }; /* html truncado para debug */
}

/* ── Parser HTML → FichaContratual ── */
function parseHTMLFichaContratual(html: string): FichaContratual {
  const $ = cheerio.load(html);

  /* Map para coletar todos os pares label → valor */
  const campos: Record<string, string> = {};

  /* Padrão 1: tabelas com td label + td valor (layout típico SISDNIT) */
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

  /* Padrão 2: th + td */
  $('table tr').each((_, row) => {
    const th = $(row).find('th');
    const td = $(row).find('td');
    if (th.length && td.length) {
      th.each((j, thEl) => {
        const label = cleanText($(thEl).text());
        const valor = cleanText($(td.eq(j)).text());
        if (label && valor) {
          campos[normalizeLabel(label)] = valor;
        }
      });
    }
  });

  /* Padrão 3: <label> ou <span class="label"> seguido de valor */
  $('label, span.label, span.rotulo, .rotulo').each((_, el) => {
    const label = cleanText($(el).text());
    const next = $(el).next();
    const valor = cleanText(next.text());
    if (label && valor) {
      campos[normalizeLabel(label)] = valor;
    }
  });

  /* Padrão 4: <dt> / <dd> */
  $('dt').each((_, dt) => {
    const label = cleanText($(dt).text());
    const dd = $(dt).next('dd');
    if (dd.length) {
      campos[normalizeLabel(label)] = cleanText(dd.text());
    }
  });

  /* Parsear tabela de aditivos, se existir */
  const aditivos: Array<Record<string, string>> = [];
  const aditivoTable = $('table').filter((_, table) => {
    const text = $(table).text().toLowerCase();
    return text.includes('aditivo') || text.includes('termo aditivo');
  }).first();

  if (aditivoTable.length) {
    const headers: string[] = [];
    aditivoTable.find('tr:first-child th, tr:first-child td').each((_, th) => {
      headers.push(cleanText($(th).text()));
    });

    aditivoTable.find('tr').slice(1).each((_, row) => {
      const adRow: Record<string, string> = {};
      $(row).find('td').each((j, td) => {
        const key = headers[j] || `col_${j}`;
        adRow[normalizeLabel(key)] = cleanText($(td).text());
      });
      if (Object.values(adRow).some(v => v)) {
        aditivos.push(adRow);
      }
    });
  }

  /* Mapear campos conhecidos com fuzzy matching */
  const ficha: FichaContratual = {
    contrato: findField(campos, ['contrato', 'numero_contrato', 'nr_contrato', 'num_contrato', 'n_contrato']) || '',
    objeto: findField(campos, ['objeto', 'descricao', 'desc_objeto', 'objeto_contrato']) || '',
    empresa: findField(campos, ['empresa', 'contratada', 'razao_social', 'nome_empresa']) || '',
    cnpj: findField(campos, ['cnpj', 'cnpj_empresa', 'cnpj_contratada']) || '',
    fiscal: findField(campos, ['fiscal', 'gestor', 'responsavel', 'fiscal_contrato']) || '',
    superintendencia: findField(campos, ['superintendencia', 'sr', 'regional', 'unidade']) || '',
    rodovia: findField(campos, ['rodovia', 'br', 'rodovia_br']) || '',
    uf: findField(campos, ['uf', 'estado']) || '',
    extensao: findField(campos, ['extensao', 'extensao_km', 'km']) || '',
    trecho: findField(campos, ['trecho', 'segmento', 'trecho_rodoviario']) || '',
    valor_original: findField(campos, ['valor_original', 'valor_contrato', 'valor_inicial', 'valor']) || '',
    valor_atual: findField(campos, ['valor_atual', 'valor_atualizado', 'valor_vigente', 'valor_com_aditivos']) || '',
    data_assinatura: findField(campos, ['data_assinatura', 'assinatura', 'dt_assinatura']) || '',
    data_inicio: findField(campos, ['data_inicio', 'inicio', 'dt_inicio', 'inicio_vigencia']) || '',
    data_fim: findField(campos, ['data_fim', 'fim', 'dt_fim', 'termino', 'fim_vigencia', 'data_termino']) || '',
    prazo_original: findField(campos, ['prazo_original', 'prazo', 'prazo_inicial', 'prazo_dias']) || '',
    prazo_atual: findField(campos, ['prazo_atual', 'prazo_vigente', 'prazo_com_aditivos']) || '',
    situacao: findField(campos, ['situacao', 'status', 'situacao_contrato', 'estado_contrato']) || '',
    tipo_contrato: findField(campos, ['tipo', 'tipo_contrato', 'modalidade', 'tipo_obra']) || '',
    campos_extras: campos,
    aditivos,
  };

  return ficha;
}

/* ── Helpers ── */

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
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function findField(campos: Record<string, string>, keys: string[]): string | undefined {
  /* Busca exata */
  for (const key of keys) {
    if (campos[key]) return campos[key];
  }
  /* Busca parcial (campo contém a key) */
  for (const key of keys) {
    for (const [campo, valor] of Object.entries(campos)) {
      if (campo.includes(key) && valor) return valor;
    }
  }
  return undefined;
}

function extractCookies(headers: Headers): string[] {
  const cookies: string[] = [];
  /* Headers.getSetCookie() (Node 20+) ou fallback */
  const setCookies = (headers as any).getSetCookie?.() || [];
  for (const sc of setCookies) {
    const nameVal = sc.split(';')[0];
    if (nameVal) cookies.push(nameVal.trim());
  }
  /* Fallback: get all Set-Cookie via raw */
  if (!cookies.length) {
    const raw = headers.get('set-cookie');
    if (raw) {
      for (const part of raw.split(/,(?=\s*\w+=)/)) {
        const nameVal = part.split(';')[0];
        if (nameVal) cookies.push(nameVal.trim());
      }
    }
  }
  return cookies;
}

function extractJsessionId(cookies: string[]): string {
  for (const c of cookies) {
    const m = c.match(/JSESSIONID=([^;]+)/i);
    if (m) return m[1];
  }
  return '';
}

function mergeCookies(a: string[], b: string[]): string[] {
  const map = new Map<string, string>();
  for (const c of [...a, ...b]) {
    const [name] = c.split('=', 1);
    map.set(name, c);
  }
  return Array.from(map.values());
}
