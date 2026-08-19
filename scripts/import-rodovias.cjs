/**
 * Importa rodovias do SNV/DNIT para PostgreSQL
 * Lê arquivos JSON de /rodovias-data/ e insere no banco
 *
 * Uso: node scripts/import-rodovias.cjs
 * (extensão .cjs para funcionar mesmo com "type":"module" no package.json)
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATA_DIR = '/rodovias-data';

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Importando rodovias SNV/DNIT            ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && f !== 'index.json')
    .sort();

  console.log(`📊 ${files.length} arquivos de rodovias encontrados`);
  console.log('');

  let inseridas = 0;
  let atualizadas = 0;
  let erros = 0;
  let totalCoords = 0;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const data = JSON.parse(raw);
        const { br, uf, snv, updated, km: totalKm, segments } = data;

        // Converter segments → arrays planos de lat, lon, km
        const latArr = [];
        const lonArr = [];
        const kmArr = [];

        if (segments && segments.length > 0) {
          for (const seg of segments) {
            const { ki, kf, c } = seg;
            if (!c || c.length === 0) continue;
            const n = c.length;

            for (let i = 0; i < n; i++) {
              const [lon, lat] = c[i];
              // Interpolar km entre ki e kf para cada coordenada
              const kmVal = n > 1 ? ki + (kf - ki) * (i / (n - 1)) : ki;
              latArr.push(lat);
              lonArr.push(lon);
              kmArr.push(Math.round(kmVal * 1000) / 1000);
            }
          }
        }

        totalCoords += latArr.length;

        // Evitar Math.min/max(...arr) — causa stack overflow em arrays grandes
        let kmMin = 0, kmMax = totalKm || 0;
        if (kmArr.length > 0) {
          kmMin = kmArr[0];
          kmMax = kmArr[0];
          for (let i = 1; i < kmArr.length; i++) {
            if (kmArr[i] < kmMin) kmMin = kmArr[i];
            if (kmArr[i] > kmMax) kmMax = kmArr[i];
          }
        }

        const snvId = (snv || '').toLowerCase();
        const id = `rod-${br}-${uf}-${snvId}`;

        // UPSERT
        await client.query(`
          INSERT INTO rodovias (id, br, uf, fonte, km_min, km_max, lat, lon, km, versao_snv, data_atualizacao)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
          ON CONFLICT (id) DO UPDATE SET
            km_min = EXCLUDED.km_min,
            km_max = EXCLUDED.km_max,
            lat = EXCLUDED.lat,
            lon = EXCLUDED.lon,
            km = EXCLUDED.km,
            versao_snv = EXCLUDED.versao_snv,
            data_atualizacao = EXCLUDED.data_atualizacao,
            fonte = EXCLUDED.fonte
        `, [id, br, uf, 'SNV/DNIT', kmMin, kmMax, latArr, lonArr, kmArr, snv || '']);

        inseridas++;

        // Progresso a cada 25 rodovias
        if ((fi + 1) % 25 === 0 || fi === files.length - 1) {
          console.log(`  ✅ ${fi + 1}/${files.length}  BR-${br}/${uf}  (${latArr.length} pts)`);
        }
      } catch (err) {
        console.error(`  ❌ ${file}: ${err.message}`);
        erros++;
      }
    }

    await client.query('COMMIT');

    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║  ✅ Importação concluída!                ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Rodovias:      ${inseridas}`);
    console.log(`║  Erros:         ${erros}`);
    console.log(`║  Coordenadas:   ${totalCoords.toLocaleString()}`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERRO FATAL:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
