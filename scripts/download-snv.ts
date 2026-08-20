#!/usr/bin/env npx tsx
/**
 * download-snv.ts — Baixa TODA a base SNV do WFS do DNIT e envia para o servidor.
 *
 * Usa o geoserviço INDE/DNIT (WFS) para baixar geometria de todas as rodovias
 * federais do Brasil, processa no formato BaseRodovia (arrays lat/lon/km) e
 * envia em lotes para o endpoint /api/rodovias/import do servidor.
 *
 * Uso:
 *   npx tsx scripts/download-snv.ts
 *   npx tsx scripts/download-snv.ts --server https://controlcheck.duckdns.org
 *   npx tsx scripts/download-snv.ts --uf RN        # só uma UF
 *   npx tsx scripts/download-snv.ts --br 226 --uf RN   # só uma BR/UF
 */

const WFS_URL = 'https://geoservicos.inde.gov.br/geoserver/DNIT/wfs';
const DEFAULT_SERVER = 'https://controlcheck.duckdns.org';
const DEFAULT_IMPORT_KEY = 'controlcheck-snv-import-2026';
const BATCH_SIZE = 5; // rodovias por request (mantém payload gerenciável)

/* ── Parse args ── */
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const SERVER = getArg('server') || DEFAULT_SERVER;
const IMPORT_KEY = getArg('key') || DEFAULT_IMPORT_KEY;
const FILTER_UF = getArg('uf')?.toUpperCase();
const FILTER_BR = getArg('br');

/* ── WFS helpers ── */

interface WfsFeature {
  geometry: { type: string; coordinates: number[][] | number[][][] };
  properties: { vl_br: string; sg_uf: string; vl_km_inic: number; vl_km_fina: number; [k: string]: unknown };
}

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

async function findWfsLayer(): Promise<string> {
  console.log('🔍 Buscando layer SNV mais recente...');
  const r = await fetch(WFS_URL + '?service=WFS&request=GetCapabilities');
  const xml = await r.text();
  const m = [...xml.matchAll(/<Name>(DNIT:snv_\w+)<\/Name>/g)];
  if (!m.length) throw new Error('Layer SNV não encontrada no WFS do DNIT');
  const layer = m.map(x => x[1]).sort().pop()!;
  console.log(`   Layer encontrada: ${layer}`);
  return layer;
}

async function listAllRoads(layer: string): Promise<Array<{ br: string; uf: string }>> {
  console.log('📋 Listando todas as rodovias federais...');
  // Busca com propertyName mínimo para velocidade, sem geometria
  const cql = "sg_tipo_tr='B'";
  const url = `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature&typeName=${layer}&CQL_FILTER=${encodeURIComponent(cql)}&propertyName=vl_br,sg_uf&outputFormat=application/json&count=50000`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ao listar rodovias`);
  const json = await resp.json();

  const features: WfsFeature[] = json.features || [];
  console.log(`   ${features.length} segmentos encontrados no total`);

  // Extrair pares únicos BR/UF
  const set = new Set<string>();
  for (const f of features) {
    const br = String(f.properties.vl_br).padStart(3, '0');
    const uf = String(f.properties.sg_uf).toUpperCase();
    if (br && uf && uf.length === 2) {
      set.add(`${br}|${uf}`);
    }
  }

  const roads = [...set].sort().map(s => {
    const [br, uf] = s.split('|');
    return { br, uf };
  });

  console.log(`   ${roads.length} rodovias únicas (BR/UF)`);
  return roads;
}

async function downloadRoad(layer: string, br: string, uf: string): Promise<RodoviaBase | null> {
  const cql = `vl_br='${br}' AND sg_uf='${uf}' AND sg_tipo_tr='B'`;
  const fields = 'vl_br,sg_uf,vl_km_inic,vl_km_fina,the_geom';
  const url = `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature&typeName=${layer}&CQL_FILTER=${encodeURIComponent(cql)}&propertyName=${fields}&outputFormat=application/json&sortBy=vl_km_inic`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`   ✗ HTTP ${resp.status} para BR-${br}/${uf}`);
    return null;
  }
  const json = await resp.json();
  const feats: WfsFeature[] = json.features || [];
  if (!feats.length) return null;

  // Processar geometria (mesmo algoritmo do rodovias.ts)
  const D2R = Math.PI / 180;
  const segs = feats
    .map(f => {
      const g = f.geometry;
      let c: number[][] = [];
      if (g?.type === 'MultiLineString') c = (g.coordinates as number[][][]).flat();
      else if (g?.type === 'LineString') c = g.coordinates as number[][];
      return { ki: f.properties.vl_km_inic, kf: f.properties.vl_km_fina, c };
    })
    .filter(s => s.c.length >= 2)
    .sort((a, b) => a.ki - b.ki);

  const lat: number[] = [], lon: number[] = [], km: number[] = [];
  for (const seg of segs) {
    const cc = seg.c;
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

  if (!lat.length) return null;

  return {
    br,
    uf,
    fonte: `SNV ${layer.replace('DNIT:', '')}`,
    km_min: km[0],
    km_max: km[km.length - 1],
    lat, lon, km,
  };
}

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
      console.error(`   ✗ Erro ao enviar lote: ${resp.status} ${err}`);
      return false;
    }
    const data = await resp.json();
    return data.ok === true;
  } catch (err: any) {
    console.error(`   ✗ Erro de rede: ${err.message}`);
    return false;
  }
}

async function registerVersion(versao: string, label: string, total: number): Promise<void> {
  try {
    await fetch(`${SERVER}/api/rodovias/versoes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Import-Key': IMPORT_KEY,
      },
      body: JSON.stringify({
        id: versao,
        label,
        total_rodovias: total,
        status: 'concluido',
      }),
    });
  } catch { /* ignora */ }
}

/* ── Main ── */

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Download SNV → ControlCheck Server      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Servidor: ${SERVER}`);
  if (FILTER_UF) console.log(`  Filtro UF: ${FILTER_UF}`);
  if (FILTER_BR) console.log(`  Filtro BR: ${FILTER_BR}`);
  console.log('');

  // 1. Encontrar layer
  const layer = await findWfsLayer();
  // Versão no formato DNIT (ex: "202507a"), sem prefixo "snv_"
  const versao = layer.replace('DNIT:', '').replace(/^snv_/i, '').toLowerCase();

  // 2. Listar rodovias
  let roads = await listAllRoads(layer);

  // Aplicar filtros
  if (FILTER_UF) {
    roads = roads.filter(r => r.uf === FILTER_UF);
    console.log(`   Filtrado para UF ${FILTER_UF}: ${roads.length} rodovias`);
  }
  if (FILTER_BR) {
    const brPad = FILTER_BR.padStart(3, '0');
    roads = roads.filter(r => r.br === brPad);
    console.log(`   Filtrado para BR-${brPad}: ${roads.length} rodovias`);
  }

  if (!roads.length) {
    console.log('❌ Nenhuma rodovia encontrada com os filtros aplicados.');
    return;
  }

  console.log(`\n🚀 Baixando ${roads.length} rodovias do WFS do DNIT...\n`);

  // 3. Baixar e enviar em lotes
  let downloaded = 0;
  let sent = 0;
  let errors = 0;
  let batch: RodoviaBase[] = [];
  const startTime = Date.now();

  for (let i = 0; i < roads.length; i++) {
    const { br, uf } = roads[i];
    const pct = ((i + 1) / roads.length * 100).toFixed(0);
    process.stdout.write(`  [${pct}%] BR-${br}/${uf}...`);

    try {
      const road = await downloadRoad(layer, br, uf);
      if (road) {
        downloaded++;
        batch.push(road);
        const pts = road.lat.length;
        process.stdout.write(` ✓ ${pts} pontos, KM ${road.km_min.toFixed(1)}–${road.km_max.toFixed(1)}\n`);

        // Enviar lote quando acumula
        if (batch.length >= BATCH_SIZE) {
          process.stdout.write(`  → Enviando lote de ${batch.length} rodovias para ${SERVER}...`);
          const ok = await sendBatch(batch, versao);
          if (ok) {
            sent += batch.length;
            process.stdout.write(` ✓\n`);
          } else {
            errors += batch.length;
            process.stdout.write(` ✗\n`);
          }
          batch = [];
        }
      } else {
        process.stdout.write(` (sem dados)\n`);
      }
    } catch (err: any) {
      process.stdout.write(` ✗ ${err.message}\n`);
      errors++;
    }

    // Pequeno delay para não sobrecarregar o WFS
    if (i < roads.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Enviar último lote
  if (batch.length > 0) {
    process.stdout.write(`  → Enviando último lote (${batch.length} rodovias)...`);
    const ok = await sendBatch(batch, versao);
    if (ok) {
      sent += batch.length;
      process.stdout.write(` ✓\n`);
    } else {
      errors += batch.length;
      process.stdout.write(` ✗\n`);
    }
  }

  // 4. Registrar versão
  const label = `SNV ${versao.replace('snv_', '').toUpperCase()}`;
  await registerVersion(versao, label, sent);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(`  ✓ Download concluído em ${elapsed} minutos`);
  console.log(`  • Rodovias encontradas: ${roads.length}`);
  console.log(`  • Baixadas com sucesso: ${downloaded}`);
  console.log(`  • Enviadas ao servidor: ${sent}`);
  if (errors > 0) console.log(`  • Erros: ${errors}`);
  console.log(`  • Versão SNV: ${versao}`);
  console.log('═══════════════════════════════════════════');
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err);
  process.exit(1);
});
