-- ═══════════════════════════════════════════════════════════════
-- 002 — Suporte a múltiplas versões do SNV
-- Permite que cada rodovia tenha dados de várias publicações
-- ═══════════════════════════════════════════════════════════════

-- ── Tabela de versões do SNV disponíveis ──
CREATE TABLE IF NOT EXISTS snv_versoes (
  id TEXT PRIMARY KEY,              -- ex: '202504a'
  label TEXT NOT NULL,              -- ex: 'SNV 2025/04 (A)'
  data_publicacao DATE,             -- data da publicação DNIT
  arquivo_dnit TEXT,                -- ex: '202504A.zip'
  total_rodovias INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pendente',   -- pendente | processando | concluido | erro
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Limpar rodovias antigas (serão reimportadas com versão) ──
TRUNCATE rodovias;

-- ── Tornar versao_snv NOT NULL (default vazio só para a transição) ──
ALTER TABLE rodovias ALTER COLUMN versao_snv SET NOT NULL;
ALTER TABLE rodovias ALTER COLUMN versao_snv SET DEFAULT '';

-- ── Índice composto para busca eficiente ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_rodovias_br_uf_snv
  ON rodovias(br, uf, versao_snv);

-- ── Índice para listar versões de uma rodovia ──
CREATE INDEX IF NOT EXISTS idx_rodovias_versao
  ON rodovias(versao_snv);
