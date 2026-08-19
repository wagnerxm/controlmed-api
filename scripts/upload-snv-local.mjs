/**
 * Processa versões do SNV localmente e envia para o servidor ControlCheck
 *
 * Roda na máquina local (que consegue acessar o DNIT) e faz upload
 * via HTTPS para a API no servidor.
 *
 * Uso:
 *   node scripts/upload-snv-local.mjs                            # baixa TUDO do DNIT Cloud
 *   node scripts/upload-snv-local.mjs --only 202504a,202501a     # versões específicas
 *   node scripts/upload-snv-local.mjs --folder "D:\SNV ZIPs"     # processa ZIPs já baixados
 *   node scripts/upload-snv-local.mjs --file 202504A.zip --version 202504a  # um ZIP específico
 *   node scripts/upload-snv-local.mjs --batch 20                 # 20 rodovias por request
 *
 * Download em streaming com progresso (não carrega tudo na memória).
 * Pula versões já processadas no servidor automaticamente.
 *
 * Requer: IMPORT_KEY no .env do servidor (mesma chave usada aqui)
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname, '..', '.tmp-snv-upload');

// ── Configuração ──
const API_URL = 'https://controlcheck.duckdns.org/api';
const IMPORT_KEY = 'controlcheck-snv-import-2026';   // deve bater com IMPORT_KEY no .env do servidor
const SHARE_TOKEN = 'oTpPRmYs5AAdiNr';
const WEBDAV = 'https://servicos.dnit.gov.br/dnitcloud/public.php/webdav';
const SHP_FOLDER = 'SNV Bases Geométricas (2013-Atual) (SHP)';
const AUTH = 'Basic ' + Buffer.from(SHARE_TOKEN + ':').toString('base64');
const D2R = Math.PI / 180;

// ── Args ──
const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const onlyFilter = onlyIdx >= 0 ? args[onlyIdx + 1]?.split(',').map(s => s.trim().toLowerCase()) : null;
const batchIdx = args.indexOf('--batch');
const BATCH_SIZE = batchIdx >= 0 ? parseInt(args[batchIdx + 1]) || 10 : 10;
const fileIdx = args.indexOf('--file');
const LOCAL_FILE = fileIdx >= 0 ? args[fileIdx + 1] : null;
const versionIdx = args.indexOf('--version');
const LOCAL_VERSION = versionIdx >= 0 ? args[versionIdx + 1]?.toLowerCase() : null;
const folderIdx = args.indexOf('--folder');
const LOCAL_FOLDER = folderIdx >= 0 ? args[folderIdx + 1] : null;

// ── Fetch com retry ──
async function fetchRetry(url, opts = {}, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(600000), ...opts });
      return r;
    } catch (e) {
      if (i === attempts) throw e;
      const wait = 5000 * Math.pow(2, i - 1);
      console.log(`  ⏳ Tentativa ${i}/${attempts} falhou, aguardando ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// ── Listar versões SHP no DNIT Cloud ──
async function listShpFiles() {
  const url = `${WEBDAV}/${encodeURIComponent(SHP_FOLDER)}/`;
  const r = await fetchRetry(url, {
    method: 'PROPFIND',
    headers: { 'Authorization': AUTH, 'Depth': '1' }
  });
  if (!r.ok) throw new Error(`PROPFIND: HTTP ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)]
    .map(m => decodeURIComponent(m[1].split('/').pop()))
    .filter(f => /^\d{6}\w+\.zip$/i.test(f))
    .sort();
}

// ── Baixar ZIP do DNIT com streaming (não carrega tudo na memória) ──
async function downloadZip(filename, dest) {
  const url = `${WEBDAV}/${encodeURIComponent(SHP_FOLDER)}/${encodeURIComponent(filename)}`;
  console.log(`  📥 Baixando ${filename}...`);
  // Timeout longo (30 min) — ZIPs podem ter 200MB+ e o DNIT é lento
  const r = await fetchRetry(url, { headers: { 'Authorization': AUTH }, signal: AbortSignal.timeout(1800000) }, 3);
  if (!r.ok) throw new Error(`Download ${filename}: HTTP ${r.status}`);
  const total = parseInt(r.headers.get('content-length') || '0');
  let downloaded = 0;
  const progress = new TransformStream({
    transform(chunk, controller) {
      downloaded += chunk.length;
      const mb = (downloaded / 1024 / 1024).toFixed(1);
      const pct = total ? ` (${Math.round(downloaded / total * 100)}%)` : '';
      process.stdout.write(`     ${mb} MB${pct}\r`);
      controller.enqueue(chunk);
    }
  });
  const readable = Readable.fromWeb(r.body.pipeThrough(progress));
  await pipeline(readable, createWriteStream(dest));
  const mb = (downloaded / 1024 / 1024).toFixed(1);
  console.log(`     ${mb} MB ✅                    `);
}

// ── Parsers SHP/DBF ──
function readDbf(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numRecs = v.getUint32(4, true);
  const headerLen = v.getUint16(8, true);
  const recLen = v.getUint16(10, true);
  const fields = [];
  for (let off = 32; off < headerLen - 1; off += 32) {
    const name = buf.slice(off, off + 11).toString('utf-8').replace(/\0/g, '').trim().toLowerCase();
    const type = String.fromCharCode(buf[off + 11]);
    const len = buf[off + 16];
    fields.push({ name, type, len });
  }
  const recs = [];
  for (let i = 0; i < numRecs; i++) {
    const roff = headerLen + i * recLen + 1;
    const rec = {};
    let foff = 0;
    for (const f of fields) {
      const raw = buf.slice(roff + foff, roff + foff + f.len).toString('utf-8').trim();
      if (f.type === 'N' || f.type === 'F') rec[f.name] = raw === '' ? null : parseFloat(raw);
      else rec[f.name] = raw;
      foff += f.len;
    }
    recs.push(rec);
  }
  return recs;
}

function readShp(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const feats = [];
  let off = 100;
  while (off < buf.length - 8) {
    const contentLen = v.getInt32(off + 4, false);
    if (contentLen <= 0) break;
    const recStart = off + 8;
    const type = v.getInt32(recStart, true);
    if (type === 3 || type === 5) {
      const numParts = v.getInt32(recStart + 36, true);
      const numPoints = v.getInt32(recStart + 40, true);
      const ptsOff = recStart + 44 + numParts * 4;
      const points = [];
      for (let i = 0; i < numPoints; i++) {
        points.push([
          Math.round(v.getFloat64(ptsOff + i * 16, true) * 1e7) / 1e7,
          Math.round(v.getFloat64(ptsOff + i * 16 + 8, true) * 1e7) / 1e7
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

// ── Converter trechos → arrays planos ──
function buildRoad(segs) {
  segs.sort((a, b) => a.ki - b.ki);
  const lat = [], lon = [], km = [];
  for (const seg of segs) {
    const cc = seg.pts;
    if (!cc || cc.length < 2) continue;
    let total = 0;
    const cum = [0];
    for (let i = 1; i < cc.length; i++) {
      const cos = Math.cos((cc[i - 1][1] + cc[i][1]) / 2 * D2R);
      const dx = (cc[i][0] - cc[i - 1][0]) * cos, dy = cc[i][1] - cc[i - 1][1];
      total += Math.sqrt(dx * dx + dy * dy);
      cum.push(total);
    }
    const range = seg.kf - seg.ki;
    for (let i = 0; i < cc.length; i++) {
      const frac = total > 0 ? cum[i] / total : 0;
      km.push(Math.round((seg.ki + frac * range) * 1000) / 1000);
      lon.push(cc[i][0]);
      lat.push(cc[i][1]);
    }
  }
  let kmMin = 0, kmMax = 0;
  if (km.length) { kmMin = km[0]; kmMax = km[0]; for (const v of km) { if (v < kmMin) kmMin = v; if (v > kmMax) kmMax = v; } }
  return { lat, lon, km, km_min: kmMin, km_max: kmMax };
}

// ── Upload para o servidor em lotes ──
async function uploadBatch(rodovias, snvId) {
  const r = await fetchRetry(`${API_URL}/rodovias/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-import-key': IMPORT_KEY,
    },
    body: JSON.stringify({ versao_snv: snvId, rodovias }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Upload falhou: HTTP ${r.status} — ${txt}`);
  }
  return r.json();
}

// ── Registrar versão no catálogo ──
async function registerVersion(snvId, totalRodovias, zipName) {
  const meses = { '01': 'Jan', '02': 'Fev', '03': 'Mar', '04': 'Abr', '05': 'Mai', '06': 'Jun',
                  '07': 'Jul', '08': 'Ago', '09': 'Set', '10': 'Out', '11': 'Nov', '12': 'Dez' };
  const y = snvId.slice(0, 4), m = snvId.slice(4, 6), l = snvId.slice(6).toUpperCase();
  const label = `SNV ${meses[m] || m}/${y}${l ? ' (' + l + ')' : ''}`;

  const r = await fetchRetry(`${API_URL}/rodovias/versoes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-import-key': IMPORT_KEY },
    body: JSON.stringify({ id: snvId, label, arquivo_dnit: zipName, total_rodovias: totalRodovias, status: 'concluido' }),
  });
  if (!r.ok) console.warn(`  ⚠️ Falha ao registrar versão: HTTP ${r.status}`);
}

// ── Processar uma versão ──
async function processVersion(zipPath, snvId, zipName) {
  console.log(`  🔧 Extraindo ZIP...`);

  // Usar unzip nativo ou PowerShell
  const extractDir = join(TMP, snvId);
  mkdirSync(extractDir, { recursive: true });

  try {
    // Tentar PowerShell (Windows)
    execSync(`powershell -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${extractDir}'"`, { stdio: 'pipe' });
  } catch {
    // Fallback: unzip (Linux/Mac)
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });
  }

  // Buscar SHP e DBF recursivamente (podem estar em subpasta)
  const { readdirSync, statSync } = await import('node:fs');
  function findFiles(dir) {
    let result = [];
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) result = result.concat(findFiles(full));
      else result.push(full);
    }
    return result;
  }
  const allFiles = findFiles(extractDir);
  const shpPath = allFiles.find(f => f.toLowerCase().endsWith('.shp'));
  const dbfPath = allFiles.find(f => f.toLowerCase().endsWith('.dbf'));
  if (!shpPath || !dbfPath) {
    console.error('     Arquivos encontrados:', allFiles.map(f => f.split(/[/\\]/).pop()).join(', '));
    throw new Error('SHP ou DBF não encontrado no ZIP');
  }

  console.log(`  📊 Parseando DBF...`);
  const recs = readDbf(readFileSync(dbfPath));
  console.log(`     ${recs.length} registros`);

  console.log(`  📊 Parseando SHP...`);
  const geoms = readShp(readFileSync(shpPath));

  // Agrupar por rodovia (só tipo B = eixo principal)
  const roadMap = {};
  let skipped = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.sg_tipo_tr !== 'B') { skipped++; continue; }
    const ki = r.vl_km_inic, kf = r.vl_km_fina;
    if (ki == null || kf == null) continue;
    const pts = geoms[i];
    if (!pts || pts.length < 2) continue;
    const br = String(r.vl_br).padStart(3, '0');
    const uf = r.sg_uf;
    const key = `${br}-${uf}`;
    (roadMap[key] = roadMap[key] || []).push({ ki, kf, pts });
  }

  const keys = Object.keys(roadMap).sort();
  console.log(`     ${keys.length} rodovias (${skipped} trechos não-B ignorados)`);

  // Upload em lotes
  console.log(`  📤 Enviando para o servidor (lotes de ${BATCH_SIZE})...`);
  let sent = 0, totalCoords = 0;
  let batch = [];

  for (let k = 0; k < keys.length; k++) {
    const [br, uf] = keys[k].split('-');
    const road = buildRoad(roadMap[keys[k]]);
    totalCoords += road.lat.length;
    batch.push({ br, uf, ...road, fonte: 'SNV/DNIT' });

    if (batch.length >= BATCH_SIZE || k === keys.length - 1) {
      await uploadBatch(batch, snvId);
      sent += batch.length;
      process.stdout.write(`     [${sent}/${keys.length}] ✅\r`);
      batch = [];
    }
  }
  console.log(`     ${sent} rodovias enviadas, ${totalCoords.toLocaleString()} coordenadas`);

  // Registrar versão no catálogo
  await registerVersion(snvId, sent, zipName);

  // Limpar arquivos extraídos
  rmSync(extractDir, { recursive: true, force: true });

  return { sent, totalCoords };
}

// ── Main ──
async function main() {
  mkdirSync(TMP, { recursive: true });

  console.log('');
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║  Upload local de versões SNV → Servidor           ║');
  console.log('║  Baixa do DNIT · Processa · Envia para a API     ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  API: ${API_URL}`);
  console.log(`  Lote: ${BATCH_SIZE} rodovias por request`);
  if (onlyFilter) console.log(`  Filtro: ${onlyFilter.join(', ')}`);
  console.log('');

  // Testar conexão com o servidor
  console.log('🔗 Testando conexão com o servidor...');
  try {
    const health = await fetchRetry(`${API_URL}/health`, {}, 2);
    if (!health.ok) throw new Error('HTTP ' + health.status);
    console.log('   ✅ Servidor OK');
  } catch (e) {
    console.error(`   ❌ Servidor inacessível: ${e.message}`);
    process.exit(1);
  }

  // ── Modo arquivo local: --file <caminho.zip> --version <202504a> ──
  if (LOCAL_FILE) {
    if (!LOCAL_VERSION) {
      console.error('❌ Use --version <id> junto com --file. Ex: --file 202504A.zip --version 202504a');
      process.exit(1);
    }
    if (!existsSync(LOCAL_FILE)) {
      console.error(`❌ Arquivo não encontrado: ${LOCAL_FILE}`);
      process.exit(1);
    }
    console.log('');
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📦 Arquivo local: ${LOCAL_FILE}`);
    console.log(`   Versão: ${LOCAL_VERSION}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    const { sent, totalCoords } = await processVersion(LOCAL_FILE, LOCAL_VERSION, LOCAL_FILE.split(/[/\\]/).pop());
    console.log(`  ✅ ${LOCAL_VERSION}: ${sent} rodovias, ${totalCoords.toLocaleString()} coordenadas\n`);
    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║  ✅ Concluído!                                    ║');
    console.log('╚════════════════════════════════════════════════════╝');
    return;
  }

  // Verificar quais versões já estão no servidor
  let existingVersions = new Set();
  try {
    const vr = await fetchRetry(`${API_URL}/rodovias/versoes`);
    if (vr.ok) {
      const vers = await vr.json();
      existingVersions = new Set(vers.filter(v => v.status === 'concluido').map(v => v.id));
      if (existingVersions.size) console.log(`   ${existingVersions.size} versões já no servidor: ${[...existingVersions].join(', ')}`);
    }
  } catch {}

  // ── Modo pasta local: --folder <caminho> (processa todos os ZIPs da pasta) ──
  if (LOCAL_FOLDER) {
    const { readdirSync } = await import('node:fs');
    if (!existsSync(LOCAL_FOLDER)) {
      console.error(`❌ Pasta não encontrada: ${LOCAL_FOLDER}`);
      process.exit(1);
    }
    const zips = readdirSync(LOCAL_FOLDER)
      .filter(f => /^\d{6}\w+\.zip$/i.test(f))
      .sort();
    console.log(`\n📂 Pasta local: ${LOCAL_FOLDER}`);
    console.log(`   ${zips.length} ZIPs encontrados\n`);

    let processed = 0, skippedLocal = 0;
    for (const zipName of zips) {
      const snvId = zipName.replace('.zip', '').toLowerCase();
      if (onlyFilter && !onlyFilter.includes(snvId)) continue;
      if (!onlyFilter && existingVersions.has(snvId)) {
        console.log(`⏭️  ${snvId} — já processada no servidor`);
        skippedLocal++;
        continue;
      }
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📦 Versão: ${snvId} (${zipName})`);
      try {
        const { sent, totalCoords } = await processVersion(join(LOCAL_FOLDER, zipName), snvId, zipName);
        console.log(`  ✅ ${snvId}: ${sent} rodovias, ${totalCoords.toLocaleString()} coordenadas\n`);
        processed++;
      } catch (err) {
        console.error(`  ❌ Erro em ${snvId}: ${err.message}\n`);
      }
    }
    console.log(`\n✅ Concluído! Processadas: ${processed}, Já existiam: ${skippedLocal}`);
    return;
  }

  // Listar versões no DNIT Cloud
  console.log('');
  console.log('📂 Listando versões no DNIT Cloud...');
  const zipFiles = await listShpFiles();
  console.log(`   ${zipFiles.length} versões encontradas\n`);

  let processed = 0, skipped = 0;

  for (const zipName of zipFiles) {
    const snvId = zipName.replace('.zip', '').toLowerCase();

    if (onlyFilter && !onlyFilter.includes(snvId)) continue;

    if (!onlyFilter && existingVersions.has(snvId)) {
      console.log(`⏭️  ${snvId} — já processada no servidor`);
      skipped++;
      continue;
    }

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📦 Versão: ${snvId} (${zipName})`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    try {
      const zipPath = join(TMP, zipName);
      if (!existsSync(zipPath)) {
        await downloadZip(zipName, zipPath);
      } else {
        console.log(`  📁 ZIP já baixado: ${zipPath}`);
      }

      const { sent, totalCoords } = await processVersion(zipPath, snvId, zipName);
      console.log(`  ✅ ${snvId}: ${sent} rodovias, ${totalCoords.toLocaleString()} coordenadas\n`);
      processed++;
    } catch (err) {
      console.error(`  ❌ Erro em ${snvId}: ${err.message}\n`);
    }
  }

  // Limpar TMP
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║  ✅ Concluído!                                    ║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log(`║  Processadas: ${processed}`);
  console.log(`║  Já existiam: ${skipped}`);
  console.log(`║  Total:       ${zipFiles.length} versões disponíveis`);
  console.log('╚════════════════════════════════════════════════════╝');
}

main().catch(e => { console.error(e); process.exit(1); });
