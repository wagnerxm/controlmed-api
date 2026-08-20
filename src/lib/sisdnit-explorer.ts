/**
 * SISDNIT Explorer — Logs in and discovers all available SIAC URLs
 * Temporary module for URL discovery. Remove after mapping is done.
 */

const SISDNIT_BASE = 'https://sisdnit.dnit.gov.br/sisdnit';

interface DiscoveredPage {
  url: string;
  status: number;
  title: string;
  links: string[];
  forms: string[];
  contentSnippet: string;
  size: number;
}

/**
 * Login and explore SISDNIT to find all SIAC-related URLs
 */
export async function exploreSisdnit(cpf: string, senha: string): Promise<{
  ok: boolean;
  loginRedirect?: string;
  mainPageLinks?: string[];
  siacPages?: DiscoveredPage[];
  allLinks?: string[];
  error?: string;
}> {
  const cpfClean = cpf.replace(/\D/g, '');

  /* 1. GET login page to get JSESSIONID */
  let loginGet: globalThis.Response;
  try {
    loginGet = await fetch(`${SISDNIT_BASE}/jsp/login.do`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  } catch (err: any) {
    return { ok: false, error: `Conexão falhou: ${err.message}` };
  }

  const initialCookies = extractSetCookies(loginGet.headers);

  /* 2. POST login */
  const formBody = new URLSearchParams({ cpf: cpfClean, senha, method: 'login' });
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
    return { ok: false, error: `POST login falhou: ${err.message}` };
  }

  const postCookies = extractSetCookies(postRes.headers);
  const allCookies = mergeCookieArrays(initialCookies, postCookies);
  const cookieHeader = allCookies.join('; ');
  const loginRedirect = postRes.headers.get('location') || '';

  if (postRes.status === 302 && loginRedirect.includes('login.do')) {
    return { ok: false, error: 'Login falhou — credenciais inválidas.' };
  }

  console.log(`[EXPLORER] Login OK, redirect: ${loginRedirect}`);

  /* 3. Follow the login redirect to get the main page */
  const mainUrl = loginRedirect.startsWith('http')
    ? loginRedirect
    : `https://sisdnit.dnit.gov.br${loginRedirect.startsWith('/') ? '' : '/'}${loginRedirect}`;

  let mainPage = '';
  try {
    const mainRes = await fetch(mainUrl, {
      headers: { 'Cookie': cookieHeader },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    mainPage = await mainRes.text();
    console.log(`[EXPLORER] Main page: ${mainRes.status}, size: ${mainPage.length}`);
  } catch (err: any) {
    console.log(`[EXPLORER] Main page fetch failed: ${err.message}`);
  }

  /* 4. Extract ALL links from main page */
  const mainLinks = extractLinksFromHTML(mainPage);
  console.log(`[EXPLORER] Found ${mainLinks.length} links on main page`);

  /* 5. Filter for SIAC-related URLs */
  const siacRelated = mainLinks.filter(l =>
    l.toLowerCase().includes('siac') ||
    l.toLowerCase().includes('contrato') ||
    l.toLowerCase().includes('medicao') ||
    l.toLowerCase().includes('medic') ||
    l.toLowerCase().includes('empenho') ||
    l.toLowerCase().includes('obra') ||
    l.toLowerCase().includes('ficha') ||
    l.toLowerCase().includes('acompanhamento')
  );

  console.log(`[EXPLORER] SIAC-related links: ${siacRelated.length}`);

  /* 6. Visit each SIAC page to discover sub-links and forms */
  const siacPages: DiscoveredPage[] = [];
  const visited = new Set<string>();

  // Also try some common SIAC URL patterns
  const guessUrls = [
    '/sisdnit/jsp/siac/fichaContratual.do',
    '/sisdnit/jsp/siac/resumoContrato.do',
    '/sisdnit/jsp/siac/consultaContrato.do',
    '/sisdnit/jsp/siac/pesquisaContrato.do',
    '/sisdnit/jsp/siac/listaContrato.do',
    '/sisdnit/jsp/siac/historicoMedicao.do',
    '/sisdnit/jsp/siac/consultaMedicao.do',
    '/sisdnit/jsp/siac/medicao.do',
    '/sisdnit/jsp/siac/listaMedicao.do',
    '/sisdnit/jsp/siac/empenho.do',
    '/sisdnit/jsp/siac/consultaEmpenho.do',
    '/sisdnit/jsp/siac/listaEmpenho.do',
    '/sisdnit/jsp/siac/menu.do',
    '/sisdnit/jsp/siac/index.do',
    '/sisdnit/jsp/siac/principal.do',
    '/sisdnit/jsp/siac/home.do',
    '/sisdnit/jsp/siac/resumo.do',
    '/sisdnit/jsp/siac/contrato.do',
    '/sisdnit/jsp/siac/dadosContrato.do',
    '/sisdnit/jsp/siac/detalheContrato.do',
    '/sisdnit/jsp/siac/planilha.do',
    '/sisdnit/jsp/siac/planilhaContrato.do',
    '/sisdnit/jsp/siac/itensPlanilha.do',
    '/sisdnit/jsp/siac/boletim.do',
    '/sisdnit/jsp/siac/boletimMedicao.do',
  ];

  const urlsToVisit = [...new Set([...siacRelated, ...guessUrls])];

  for (const link of urlsToVisit) {
    const fullUrl = link.startsWith('http')
      ? link
      : `https://sisdnit.dnit.gov.br${link.startsWith('/') ? '' : '/sisdnit/jsp/siac/'}${link}`;

    if (visited.has(fullUrl)) continue;
    visited.add(fullUrl);

    try {
      const res = await fetch(fullUrl, {
        headers: { 'Cookie': cookieHeader },
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });

      const status = res.status;
      const body = status === 200 ? await res.text() : '';
      const loc = res.headers.get('location') || '';

      // Skip pages that redirect to login (session expired or unauthorized)
      if (status === 302 && loc.includes('login.do')) {
        siacPages.push({
          url: fullUrl.replace('https://sisdnit.dnit.gov.br', ''),
          status: 302,
          title: '→ login (needs auth or not found)',
          links: [],
          forms: [],
          contentSnippet: `Redirect: ${loc}`,
          size: 0,
        });
        continue;
      }
      // Skip 404s
      if (status === 404) continue;

      const pageLinks = body ? extractLinksFromHTML(body) : [];
      const pageForms = body ? extractFormsFromHTML(body) : [];
      const title = extractTitle(body);

      siacPages.push({
        url: fullUrl.replace('https://sisdnit.dnit.gov.br', ''),
        status,
        title,
        links: pageLinks.slice(0, 30),
        forms: pageForms,
        contentSnippet: body.substring(0, 1500).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        size: body.length,
      });

      console.log(`[EXPLORER] ${status} ${fullUrl.replace('https://sisdnit.dnit.gov.br', '')} — "${title}" (${body.length} bytes, ${pageLinks.length} links, ${pageForms.length} forms)`);

    } catch (err: any) {
      console.log(`[EXPLORER] FAIL ${fullUrl}: ${err.message}`);
    }
  }

  return {
    ok: true,
    loginRedirect,
    mainPageLinks: mainLinks,
    siacPages,
    allLinks: [...new Set(siacPages.flatMap(p => p.links))],
  };
}

/* ── Helpers ── */

function extractSetCookies(headers: Headers): string[] {
  const cookies: string[] = [];
  const setCookies = (headers as any).getSetCookie?.() || [];
  for (const sc of setCookies) {
    const nameVal = sc.split(';')[0];
    if (nameVal) cookies.push(nameVal.trim());
  }
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

function mergeCookieArrays(a: string[], b: string[]): string[] {
  const map = new Map<string, string>();
  for (const c of [...a, ...b]) {
    const [name] = c.split('=', 1);
    map.set(name, c);
  }
  return Array.from(map.values());
}

function extractLinksFromHTML(html: string): string[] {
  const links: string[] = [];
  const regex = /(?:href|action|src)\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const link = m[1].trim();
    if (link && !link.startsWith('javascript:') && !link.startsWith('mailto:') && !link.startsWith('#')) {
      links.push(link);
    }
  }
  return [...new Set(links)];
}

function extractFormsFromHTML(html: string): string[] {
  const forms: string[] = [];
  const regex = /<form[^>]*action\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const action = m[1];
    const formContent = m[2];
    const inputs: string[] = [];
    const inputRegex = /<(?:input|select|textarea)[^>]*name\s*=\s*["']([^"']+)["'][^>]*/gi;
    let im;
    while ((im = inputRegex.exec(formContent)) !== null) {
      inputs.push(im[1]);
    }
    forms.push(`${action} [${inputs.join(', ')}]`);
  }
  return forms;
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
