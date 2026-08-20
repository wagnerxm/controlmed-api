#!/usr/bin/env npx tsx
/**
 * download-snv-shp.ts — Baixa TODAS as versões SNV do DNIT Cloud (SHP) e envia para o servidor.
 *
 * Usa o WebDAV do DNIT Cloud para baixar os ZIPs de shapefile de cada versão,
 * processa SHP/DBF, converte para arrays lat/lon/km e envia via /api/rodovias/import.
 *
 * Uso:
 *   npx tsx scripts/download-snv-shp.ts                    # todas as versões pendentes
 *   npx tsx scripts/download-snv-shp.ts --version 202607a  # só uma versão
 *   npx tsx scripts/download-snv-shp.ts --all               # todas, mesmo as já concluídas
 *   npx tsx scripts/download-snv-shp.ts --latest            # só a mais recente
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname, '..', '.tmp-snv-shp');

/* ── Config ── */
const SHARE_TOKEN = 'oTpPRmYs5AAdiNr';
const WEBDAV = 'https://servicos.dnit.gov.br/dnitcloud/public.php/webdav';
const SHP_FOLDER = 'SNV Bases Geométricas (2013-Atual) (SHP)';
const AUTH = 'Basic ' + Buffer.from(SHARE_TOKEN + ':').toString('base64');
const D2R = Math.PI / 180;

const DEFAULT_SERVER = 'https://controlcheck.duckdns.org';
const DEFAULT_IMPORT_KEY = 'controlcheck-snv-import-2026';
const BATCH_SIZE = 5;

/* ── Parse args ── */
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const SERVER = getArg('server') || DEFAULT_SERVER;
const IMPORT_KEY = getArg('key') || DEFAULT_IMPORT_KEY;
const FILTER_VERSION = getArg('version')?.toLowerCase();
const FLAG_ALL = hasFlag('all');
const FLAG_LATEST = hasFlag('latest');

/* ── Retry helper ── */
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 6): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.noRetry) throw e;
      lastErr = e;
      const cause = e?.cause?.code || e?.code || e?.message || e;
      if (i < attempts) {
        const waitMs = Math.min(60000, 5000 * 2 ** (i - 1)) + Math.floor(Math.random() * 2000);
        console.log(`  ${label}: tentativa ${i}/${attempts} falhou (${cause}). Aguardando ${Math.round(waitMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }
  throw new Error(`${label} falhou após ${attempts} tentativas: ${lastErr?.message || lastErr}`);
}

/* ── WebDAV: listar ZIPs ── */
async function listShpFiles(): Promise<string[]> {
  return withRetry(async () => {
    const url = `${WEBDAV}/${encodeURIComponent(SHP_FOLDER)}/`;
    const r = await fetch(url, {
      method: 'PROPFIND',
      headers: { 'Authorization': AUTH, 'Depth': '1' },
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw Object.assign(new Error(`PROPFIND: HTTP ${r.status}`), { noRetry: r.status < 500 && r.status !== 429 });
    const xml = await r.text();
    return [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)]
      .map(m => decodeURIComponent(m[1].split('/').pop()!))
      .filter(f => /^\d{6}\w+\.zip$/i.test(f))
      .sort();
  }, 'Listar pasta SHP');
}

/* ── WebDAV: baixar ZIP ── */
async function downloadZip(filename: string, dest: string): Promise<void> {
  await withRetry(async () => {
    const url = `${WEBDAV}/${encodeURIComponent(SHP_FOLDER)}/${encodeURIComponent(filename)}`;
    const r = await fetch(url, {
      headers: { 'Authorization': AUTH },
      signal: AbortSignal.timeout(600000), // 10 min
    });
    if (!r.ok) throw Object.assign(new Error(`Download: HTTP ${r.status}`), { noRetry: r.status < 500 && r.status !== 429 });
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(dest, buf);
    console.log(`     Baixado: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  }, `Baixar ${filename}`);
}

/* ── Parser DBF puro (sem dependências) ── */
interface DbfRecord { [key: string]: string | number | null }

function readDbf(buf: Buffer): DbfRecord[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numRecs = v.getUint32(4, true);
  const headerLen = v.getUint16(8, true);
  const recLen = v.getUint16(10, true);
  const fields: { name: string; type: string; len: number }[] = [];
  for (let off = 32; off < headerLen - 1; off += 32) {
    const name = String.fromCharCode(...buf.slice(off, off + 11)).replace(/\0/g, '').trim().toLowerCase();
    const type = String.fromCharCode(buf[off + 11]);
    const len = buf[off + 16];
    fields.push({ name, type, len });
  }
  const recs: DbfRecord[] = [];
  for (let i = 0; i < numRecs; i++) {
    const roff = headerLen + i * recLen + 1;
    const rec: DbfRecord = {};
    let foff = 0;
    for (const f of fields) {
      const raw = buf.slice(roff + foff, roff + foff + f.len).toString('utf8').trim();
      if (f.type === 'N' || f.type === 'F') rec[f.name] = raw === '' ? null : parseFloat(raw);
      else rec[f.name] = raw;
      foff += f.len;
    }
    recs.push(rec);
  }
  return recs;
}

/* ── Parser SHP puro (polyline type 3 e 5) ── */
function readShp(buf: Buffer): (number[][] | null)[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const feats: (number[][] | null)[] = [];
  let off = 100; // skip header
  while (off < buf.length) {
    const contentLen = v.getInt32(off + 4, false);
    const recStart = off + 8;
    const type = v.getInt32(recStart, true);
    if (type === 3 || type === 5) { // PolyLine or Polygon
      const numParts = v.getInt32(recStart + 36, true);
      const numPoints = v.getInt32(recStart + 40, true);
      const ptsOff = recStart + 44 + numParts * 4;
      const points: number[][] = [];
      for (let i = 0; i < numPoints; i++) {
        points.push([
          Math.round(v.getFloat64(ptsOff + i * 16, true) * 1e7) / 1e7,     // lon
          Math.round(v.getFloat64(ptsOff + i * 16 + 8, true) * 1e7) / 1e7, // lat
        ]);
      }
      feats.push(points);
    } else {
      feats.push(null);
    }
    off = recStart + contentLen * 2;
  }
  return feats;
}

/* ── Processar SHP/DBF em rodovias (lat/lon/km) ── */
interface RodoviaBase {
  br: string;
  uf: string;
  fonte: string;
  km_min: number;
  km_max: number;
  lat: number[];
  lon: number[];
  km: number[];
}

function processShpDbf(shpBuf: Buffer, dbfBuf: Buffer, versaoLabel: string): RodoviaBase[] {
  const recs = readDbf(dbfBuf);
  const geoms = readShp(shpBuf);

  // Agrupar segmentos por BR/UF
  const roadMap: Record<string, Array<{ ki: number; kf: number; pts: number[][] }>> = {};
  let skipped = 0;

  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.sg_tipo_tr !== 'B') { skipped++; continue; }
    const ki = r.vl_km_inic as number | null;
    const kf = r.vl_km_fina as number | null;
    if (ki == null || kf == null) continue;
    const pts = geoms[i];
    if (!pts || pts.length < 2) continue;
    const br = String(r.vl_br).padStart(3, '0');
    const uf = r.sg_uf as string;
    if (!uf || uf.length !== 2) continue;
    const key = `${br}-${uf}`;
    (roadMap[key] = roadMap[key] || []).push({ ki, kf, pts });
  }

  // Converter cada BR/UF em RodoviaBase
  const rodovias: RodoviaBase[] = [];
  for (const key of Object.keys(roadMap).sort()) {
    const [br, uf] = key.split('-');
    const segs = roadMap[key].sort((a, b) => a.ki - b.ki);

    const lat: number[] = [], lon: number[] = [], km: number[] = [];
    for (const seg of segs) {
      const cc = seg.pts;
      let total = 0;
      const cum = [0];
      for (let i = 1; i < cc.length; i++) {
        const cos = Math.cos(((cc[i - 1][1] + cc[i][1]) / 2) * D2R);
        const dx = (cc[i][0] - cc[i - 1][0]) * cos;
        const dy = cc[i][1] - cc[i - 1][1];
        total += Math.sqrt(dx * dx + dy * dy);
        cum.push(total);
      }
      const range = seg.kf - seg.ki;
      for (let i = 0; i < cc.length; i++) {
        const frac = total > 0 ? cum[i] / total : 0;
        km.push(+(seg.ki + frac * range).toFixed(6));
        lon.push(+cc[i][0].toFixed(8));
        lat.push(+cc[i][1].toFixed(8));
      }
    }

    if (!lat.length) continue;

    rodovias.push({
      br, uf,
      fonte: `SNV ${versaoLabel}`,
      km_min: km[0],
      km_max: km[km.length - 1],
      lat, lon, km,
    });
  }

  return rodovias;
}

/* ── Enviar rodovias para o servidor ── */
async function sendBatch(rodovias: RodoviaBase[], versao: string): Promise<boolean> {
  try {
    const resp = await fetch(`${SERVER}/api/rodovias/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Import-Key': IMPORT_KEY,
      },
      body: JSON.stringify({ versao_snv: versao, rodovias }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`     ✗ Erro ao enviar lote: ${resp.status} ${err.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`     ✗ Erro de rede: ${err.message}`);
    return false;
  }
}

async function registerVersion(id: string, label: string, total: number): Promise<void> {
  try {
    await fetch(`${SERVER}/api/rodovias/versoes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Import-Key': IMPORT_KEY },
      body: JSON.stringify({ id, label, total_rodovias: total, status: 'concluido' }),
    });
  } catch { /* ignora */ }
}

/* ── Buscar versões já concluídas no servidor ── */
async function getCompletedVersions(): Promise<Set<string>> {
  try {
    const r = await fetch(`${SERVER}/api/rodovias/versoes`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return new Set();
    const vers: Array<{ id: string; status: string }> = await r.json();
    return new Set(vers.filter(v => v.status === 'concluido').map(v => v.id));
  } catch {
    return new Set();
  }
}

/* ── Main ── */
async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║  Download SNV (SHP) → ControlCheck Server         ║');
  console.log('║  Todas as versões históricas do DNIT Cloud        ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`  Servidor: ${SERVER}`);
  console.log('');

  // 1. Listar versões no DNIT Cloud
  console.log('📋 Listando versões SHP no DNIT Cloud...');
  const files = await listShpFiles();
  console.log(`   ${files.length} versões encontradas\n`);

  // 2. Determinar quais versões processar
  const completed = await getCompletedVersions();
  console.log(`   ${completed.size} versão(ões) já concluída(s) no servidor\n`);

  let toProcess: string[];

  if (FILTER_VERSION) {
    toProcess = files.filter(f => f.toLowerCase().replace('.zip', '') === FILTER_VERSION);
    if (!toProcess.length) {
      console.log(`❌ Versão "${FILTER_VERSION}" não encontrada. Disponíveis:`);
      files.forEach(f => console.log(`   - ${f}`));
      return;
    }
  } else if (FLAG_LATEST) {
    toProcess = [files[files.length - 1]];
  } else if (FLAG_ALL) {
    toProcess = files;
  } else {
    // Apenas as que não foram concluídas
    toProcess = files.filter(f => {
      const vid = f.replace('.zip', '').toLowerCase();
      return !completed.has(vid);
    });
  }

  if (!toProcess.length) {
    console.log('✅ Todas as versões já estão concluídas no servidor!');
    return;
  }

  console.log(`🚀 Processando ${toProcess.length} versão(ões):\n`);
  toProcess.forEach(f => {
    const vid = f.replace('.zip', '').toLowerCase();
    const done = completed.has(vid);
    console.log(`   ${done ? '✓' : '○'} ${f}${done ? ' (re-processar)' : ''}`);
  });
  console.log('');

  mkdirSync(TMP, { recursive: true });

  const startTotal = Date.now();
  let versionsOk = 0;
  let versionsFail = 0;

  for (let vi = 0; vi < toProcess.length; vi++) {
    const filename = toProcess[vi];
    const vid = filename.replace('.zip', '').toLowerCase();
    const pct = ((vi + 1) / toProcess.length * 100).toFixed(0);

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  [${pct}%] Versão ${vi + 1}/${toProcess.length}: ${filename}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const startVer = Date.now();

    try {
      // Baixar ZIP
      const zipPath = join(TMP, filename);
      console.log(`  📥 Baixando ${filename}...`);
      await downloadZip(filename, zipPath);

      // Extrair
      console.log(`  📦 Extraindo...`);
      const extractDir = join(TMP, vid);
      mkdirSync(extractDir, { recursive: true });
      try {
        execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });
      } catch {
        // Tentar com 7z se unzip falhar
        try {
          execSync(`7z x "${zipPath}" -o"${extractDir}" -y`, { stdio: 'pipe' });
        } catch {
          console.log(`  ✗ Não foi possível extrair ${filename}. Pulando.`);
          versionsFail++;
          continue;
        }
      }

      // Encontrar SHP + DBF
      const extracted = readdirSync(extractDir);
      // Pode ter subpastas
      let allFiles = [...extracted];
      for (const d of extracted) {
        const sub = join(extractDir, d);
        try {
          const subFiles = readdirSync(sub);
          allFiles.push(...subFiles.map(f => join(d, f)));
        } catch { /* não é diretório */ }
      }

      const shpFile = allFiles.find(f => f.toLowerCase().endsWith('.shp'));
      const dbfFile = allFiles.find(f => f.toLowerCase().endsWith('.dbf'));

      if (!shpFile || !dbfFile) {
        console.log(`  ✗ SHP ou DBF não encontrado no ZIP. Arquivos: ${extracted.join(', ')}`);
        versionsFail++;
        continue;
      }

      // Ler e processar
      console.log(`  🔍 Processando ${shpFile}...`);
      const shpBuf = readFileSync(join(extractDir, shpFile));
      const dbfBuf = readFileSync(join(extractDir, dbfFile));

      const versaoLabel = vid.replace(/^snv_/i, '');
      const rodovias = processShpDbf(shpBuf, dbfBuf, versaoLabel);
      console.log(`     ${rodovias.length} rodovias extraídas`);

      if (!rodovias.length) {
        console.log(`  ✗ Nenhuma rodovia extraída. Pulando.`);
        versionsFail++;
        continue;
      }

      // Enviar em lotes
      console.log(`  📤 Enviando ${rodovias.length} rodovias ao servidor...`);
      let sent = 0;
      for (let i = 0; i < rodovias.length; i += BATCH_SIZE) {
        const batch = rodovias.slice(i, i + BATCH_SIZE);
        const ok = await sendBatch(batch, vid);
        if (ok) sent += batch.length;
        const p = Math.round((i + batch.length) / rodovias.length * 100);
        if (p % 20 === 0 || i + batch.length === rodovias.length) {
          process.stdout.write(`     ${p}% (${sent}/${rodovias.length} enviadas)\r`);
        }
      }
      console.log(`     ✓ ${sent}/${rodovias.length} rodovias enviadas                `);

      // Registrar versão
      const MESES = ['', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
      const year = vid.slice(0, 4);
      const month = parseInt(vid.slice(4, 6), 10);
      const suffix = vid.slice(6).toUpperCase();
      const label = `SNV ${MESES[month] || vid.slice(4, 6)}/${year} (${suffix})`;
      await registerVersion(vid, label, sent);

      // Limpar arquivos desta versão
      rmSync(extractDir, { recursive: true, force: true });
      rmSync(zipPath, { force: true });

      const elapsedVer = ((Date.now() - startVer) / 1000).toFixed(0);
      console.log(`  ✓ ${vid} concluída em ${elapsedVer}s`);
      versionsOk++;
    } catch (err: any) {
      console.error(`  ✗ Erro na versão ${vid}: ${err.message}`);
      versionsFail++;
    }
  }

  // Limpar temp
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}

  const elapsedTotal = ((Date.now() - startTotal) / 1000 / 60).toFixed(1);

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  ✓ Download concluído em ${elapsedTotal} minutos`);
  console.log(`  • Versões processadas com sucesso: ${versionsOk}`);
  if (versionsFail > 0) console.log(`  • Versões com erro: ${versionsFail}`);
  console.log(`  • Total de versões no DNIT Cloud: ${files.length}`);
  console.log('═══════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err);
  process.exit(1);
});
