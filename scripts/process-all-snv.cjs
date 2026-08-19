/**
 * Processa TODAS as versões do SNV disponíveis no DNIT Cloud
 * Baixa os SHPs, converte para arrays de lat/lon/km, insere no PostgreSQL
 *
 * Uso: node scripts/process-all-snv.cjs [--only 202504a,202501a]
 *
 * Requer: DATABASE_URL no env (docker compose run injeta automaticamente)
 */

const { Pool } = require('pg');
const https = require('https');
const http = require('http');

const SHARE_TOKEN = 'oTpPRmYs5AAdiNr';
const WEBDAV = 'https://servicos.dnit.gov.br/dnitcloud/public.php/webdav';
const SHP_FOLDER = 'SNV Bases Geométricas (2013-Atual) (SHP)';
const AUTH = 'Basic ' + Buffer.from(SHARE_TOKEN + ':').toString('base64');
const D2R = Math.PI / 180;

// ── HTTP helper ──
function httpFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: opts.method || 'GET',
      headers: { 'Authorization': AUTH, ...(opts.headers || {}) },
      timeout: 600000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpFetch(res.headers.location, opts).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, data: buf, text: () => buf.toString('utf-8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Listar ZIPs de SHP no DNIT Cloud via WebDAV ──
async function listShpFiles() {
  const url = `${WEBDAV}/${encodeURIComponent(SHP_FOLDER)}/`;
  const res = await httpFetch(url, { method: 'PROPFIND', headers: { 'Depth': '1' } });
  if (res.status >= 400) throw new Error(`PROPFIND falhou: HTTP ${res.status}`);
  const xml = res.text();
  return [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)]
    .map(m => decodeURIComponent(m[1].split('/').pop()))
    .filter(f => /^\d{6}\w+\.zip$/i.test(f))
    .sort();
}

// ── Baixar ZIP ──
async function downloadZip(filename) {
  const url = `${WEBDAV}/${encodeURIComponent(SHP_FOLDER)}/${encodeURIComponent(filename)}`;
  console.log(`  📥 Baixando ${filename}...`);
  const res = await httpFetch(url);
  if (res.status >= 400) throw new Error(`Download falhou: HTTP ${res.status}`);
  console.log(`     ${(res.data.length / 1024 / 1024).toFixed(1)} MB`);
  return res.data;
}

// ── ZIP parser minimalista (sem dependências) ──
function unzipSync(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const files = {};
  let pos = 0;

  while (pos < buf.length - 4) {
    const sig = view.getUint32(pos, true);
    if (sig !== 0x04034b50) break; // Local file header

    const method = view.getUint16(pos + 8, true);
    const compSize = view.getUint32(pos + 18, true);
    const uncompSize = view.getUint32(pos + 22, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const name = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf-8');
    const dataStart = pos + 30 + nameLen + extraLen;

    if (method === 0) {
      // Stored (sem compressão)
      files[name] = buf.slice(dataStart, dataStart + uncompSize);
    } else if (method === 8) {
      // Deflate
      const zlib = require('zlib');
      const compressed = buf.slice(dataStart, dataStart + compSize);
      files[name] = zlib.inflateRawSync(compressed);
    }

    pos = dataStart + compSize;
  }
  return files;
}

// ── Parsers de SHP e DBF (mesma lógica do fetch-snv-wfs.mjs) ──
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

// ── Converter trechos em arrays planos de lat/lon/km ──
function buildRoadArrays(segs) {
  segs.sort((a, b) => a.ki - b.ki);
  const latArr = [], lonArr = [], kmArr = [];

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
      kmArr.push(Math.round((seg.ki + frac * range) * 1000) / 1000);
      lonArr.push(cc[i][0]);
      latArr.push(cc[i][1]);
    }
  }

  let kmMin = 0, kmMax = 0;
  if (kmArr.length > 0) {
    kmMin = kmArr[0]; kmMax = kmArr[0];
    for (let i = 1; i < kmArr.length; i++) {
      if (kmArr[i] < kmMin) kmMin = kmArr[i];
      if (kmArr[i] > kmMax) kmMax = kmArr[i];
    }
  }

  return { latArr, lonArr, kmArr, kmMin, kmMax };
}

// ── Processar um ZIP de SHP e inserir no banco ──
async function processVersion(client, zipBuf, snvId) {
  console.log(`  🔧 Extraindo ZIP...`);
  const files = unzipSync(zipBuf);
  const names = Object.keys(files);

  const shpName = names.find(n => n.toLowerCase().endsWith('.shp'));
  const dbfName = names.find(n => n.toLowerCase().endsWith('.dbf'));
  if (!shpName || !dbfName) throw new Error('SHP ou DBF não encontrado no ZIP');

  console.log(`  📊 Parseando DBF...`);
  const recs = readDbf(files[dbfName]);
  console.log(`     ${recs.length} registros`);

  console.log(`  📊 Parseando SHP...`);
  const geoms = readShp(files[shpName]);
  console.log(`     ${geoms.length} geometrias`);

  // Agrupar por rodovia
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

  let inseridas = 0, totalCoords = 0;

  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    const [br, uf] = key.split('-');
    const segs = roadMap[key];
    const { latArr, lonArr, kmArr, kmMin, kmMax } = buildRoadArrays(segs);

    totalCoords += latArr.length;
    const id = `rod-${br}-${uf}-${snvId}`;

    await client.query(`
      INSERT INTO rodovias (id, br, uf, fonte, km_min, km_max, lat, lon, km, versao_snv, data_atualizacao)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (id) DO UPDATE SET
        km_min = EXCLUDED.km_min, km_max = EXCLUDED.km_max,
        lat = EXCLUDED.lat, lon = EXCLUDED.lon, km = EXCLUDED.km,
        data_atualizacao = EXCLUDED.data_atualizacao
    `, [id, br, uf, 'SNV/DNIT', kmMin, kmMax, latArr, lonArr, kmArr, snvId]);

    inseridas++;
    if ((k + 1) % 50 === 0 || k === keys.length - 1) {
      console.log(`     [${k + 1}/${keys.length}] BR-${br}/${uf}`);
    }
  }

  // Atualizar versão no catálogo
  await client.query(`
    UPDATE snv_versoes SET total_rodovias = $1, status = 'concluido' WHERE id = $2
  `, [inseridas, snvId]);

  return { inseridas, totalCoords };
}

// ── Gerar label legível de um ID de versão ──
function snvLabel(id) {
  // 202504a → 'SNV 2025/04 (A)'
  const y = id.slice(0, 4);
  const m = id.slice(4, 6);
  const l = id.slice(6).toUpperCase();
  const meses = { '01': 'Jan', '02': 'Fev', '03': 'Mar', '04': 'Abr',
                  '05': 'Mai', '06': 'Jun', '07': 'Jul', '08': 'Ago',
                  '09': 'Set', '10': 'Out', '11': 'Nov', '12': 'Dez' };
  return `SNV ${meses[m] || m}/${y}${l ? ' (' + l + ')' : ''}`;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    // Criar tabela snv_versoes se não existir
    await client.query(`
      CREATE TABLE IF NOT EXISTS snv_versoes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        data_publicacao DATE,
        arquivo_dnit TEXT,
        total_rodovias INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pendente',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Garantir índice único
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rodovias_br_uf_snv
      ON rodovias(br, uf, versao_snv)
    `).catch(() => {});

    // Filtro opcional: --only 202504a,202501a
    const onlyArg = process.argv.find(a => a.startsWith('--only'));
    const onlyFilter = onlyArg
      ? process.argv[process.argv.indexOf(onlyArg) + 1]?.split(',').map(s => s.trim().toLowerCase())
      : null;

    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  Processando todas as versões SNV do DNIT   ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    // Listar ZIPs disponíveis no DNIT Cloud
    console.log('📂 Listando versões no DNIT Cloud...');
    const zipFiles = await listShpFiles();
    console.log(`   ${zipFiles.length} versões encontradas`);
    console.log('');

    // Verificar quais já foram processadas
    const existing = await client.query(`SELECT id FROM snv_versoes WHERE status = 'concluido'`);
    const done = new Set(existing.rows.map(r => r.id));

    let processed = 0, skipped = 0;

    for (const zipName of zipFiles) {
      const snvId = zipName.replace('.zip', '').toLowerCase();

      // Filtro --only
      if (onlyFilter && !onlyFilter.includes(snvId)) continue;

      // Já processada?
      if (!onlyFilter && done.has(snvId)) {
        skipped++;
        continue;
      }

      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📦 Versão: ${snvId} (${zipName})`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      // Registrar versão no catálogo
      await client.query(`
        INSERT INTO snv_versoes (id, label, arquivo_dnit, status)
        VALUES ($1, $2, $3, 'processando')
        ON CONFLICT (id) DO UPDATE SET status = 'processando'
      `, [snvId, snvLabel(snvId), zipName]);

      try {
        await client.query('BEGIN');

        const zipBuf = await downloadZip(zipName);
        const { inseridas, totalCoords } = await processVersion(client, zipBuf, snvId);

        await client.query('COMMIT');

        console.log(`  ✅ ${inseridas} rodovias, ${totalCoords.toLocaleString()} coordenadas`);
        console.log('');
        processed++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ❌ Erro: ${err.message}`);
        await client.query(`UPDATE snv_versoes SET status = 'erro' WHERE id = $1`, [snvId]);
        console.log('');
      }
    }

    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  ✅ Processamento concluído!                 ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Processadas: ${processed}`);
    console.log(`║  Já existiam: ${skipped}`);
    console.log(`║  Total versões: ${zipFiles.length}`);
    console.log('╚══════════════════════════════════════════════╝');

  } catch (err) {
    console.error('ERRO FATAL:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
