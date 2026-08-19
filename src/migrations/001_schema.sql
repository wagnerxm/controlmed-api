-- ═══════════════════════════════════════════════════════════════
-- ControlCheck — Schema PostgreSQL
-- Banco unificado: KMCheck (rodovias) + ControlCheck (medição)
-- ═══════════════════════════════════════════════════════════════

-- ── Extensões ──
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ══════════════════════════════════
-- AUTENTICAÇÃO E EQUIPES
-- ══════════════════════════════════

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  login TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'inspetor',
  status TEXT NOT NULL DEFAULT 'ativo',
  team_id TEXT,
  avatar_url TEXT,
  deve_trocar_senha BOOLEAN DEFAULT FALSE,
  ultimo_acesso TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'inspetor',
  status TEXT NOT NULL DEFAULT 'ativo',
  added_at TIMESTAMPTZ DEFAULT NOW(),
  added_by TEXT,
  UNIQUE(team_id, user_id)
);

-- ══════════════════════════════════
-- HIERARQUIA DE SUPERVISÃO
-- ══════════════════════════════════

CREATE TABLE contratos_supervisao (
  id TEXT PRIMARY KEY,
  numero TEXT NOT NULL,
  supervisora TEXT NOT NULL,
  cnpj TEXT,
  status TEXT NOT NULL DEFAULT 'ativo',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT
);

CREATE TABLE supervisao_members (
  id TEXT PRIMARY KEY,
  supervisao_id TEXT NOT NULL REFERENCES contratos_supervisao(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'inspetor',
  status TEXT NOT NULL DEFAULT 'ativo',
  added_at TIMESTAMPTZ DEFAULT NOW(),
  added_by TEXT,
  UNIQUE(supervisao_id, user_id)
);

-- ══════════════════════════════════
-- CONTRATOS SUPERVISIONADOS
-- ══════════════════════════════════

CREATE TABLE contratos (
  id TEXT PRIMARY KEY,
  organizacao_id TEXT NOT NULL DEFAULT '',
  contrato_supervisao_id TEXT REFERENCES contratos_supervisao(id),
  numero TEXT NOT NULL,
  rodovia TEXT NOT NULL DEFAULT '',
  trecho TEXT NOT NULL DEFAULT '',
  subtrecho TEXT NOT NULL DEFAULT '',
  extensao_km NUMERIC DEFAULT 0,
  km_inicio NUMERIC DEFAULT 0,
  km_fim NUMERIC DEFAULT 0,
  empresa TEXT NOT NULL DEFAULT '',
  cnpj TEXT NOT NULL DEFAULT '',
  unidade_local TEXT NOT NULL DEFAULT '',
  valor_total NUMERIC DEFAULT 0,
  data_inicio TEXT NOT NULL DEFAULT '',
  data_fim TEXT NOT NULL DEFAULT '',
  prazo_meses INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ativo',
  versao_servicos INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE contract_members (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contratos(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'inspetor',
  permissions JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ativo',
  added_at TIMESTAMPTZ DEFAULT NOW(),
  added_by TEXT,
  UNIQUE(contract_id, user_id)
);

-- ══════════════════════════════════
-- SERVIÇOS E ITENS DE PAGAMENTO
-- ══════════════════════════════════

CREATE TABLE grupos (
  id TEXT PRIMARY KEY,
  contrato_id TEXT NOT NULL REFERENCES contratos(id),
  numero INTEGER NOT NULL,
  descricao TEXT NOT NULL
);

CREATE TABLE itens (
  id TEXT PRIMARY KEY,
  grupo_id TEXT NOT NULL REFERENCES grupos(id),
  contrato_id TEXT NOT NULL REFERENCES contratos(id),
  sequencia INTEGER DEFAULT 0,
  item TEXT NOT NULL DEFAULT '',
  codigo_siac INTEGER,
  codigo_sicro INTEGER,
  descricao TEXT NOT NULL,
  unidade TEXT NOT NULL,
  preco_unitario NUMERIC NOT NULL DEFAULT 0,
  indice TEXT NOT NULL DEFAULT '',
  reajuste BOOLEAN DEFAULT FALSE,
  tipo_memoria TEXT NOT NULL DEFAULT 'F',
  qtd_contratual NUMERIC DEFAULT 0,
  origem TEXT NOT NULL DEFAULT 'campo',
  regra_medicao_id TEXT
);

-- ══════════════════════════════════
-- MOTOR DINÂMICO — SERVIÇOS DE CAMPO
-- ══════════════════════════════════

CREATE TABLE field_services (
  id TEXT PRIMARY KEY,
  contrato_id TEXT NOT NULL REFERENCES contratos(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  categoria TEXT,
  icone TEXT,
  ordem INTEGER DEFAULT 0,
  ativo BOOLEAN DEFAULT TRUE,
  publicado BOOLEAN DEFAULT FALSE,
  fotos_min INTEGER DEFAULT 0,
  gps_obrigatorio BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE service_fields (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES field_services(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'text',
  ordem INTEGER DEFAULT 0,
  obrigatorio BOOLEAN DEFAULT FALSE,
  unidade TEXT,
  casas_decimais INTEGER,
  min NUMERIC,
  max NUMERIC,
  opcoes JSONB,
  formula TEXT,
  mostrar_mobile BOOLEAN DEFAULT TRUE,
  mostrar_memoria BOOLEAN DEFAULT TRUE,
  somente_leitura BOOLEAN DEFAULT FALSE,
  usar_para_medicao BOOLEAN DEFAULT FALSE,
  placeholder TEXT,
  valor_padrao TEXT
);

CREATE TABLE service_item_mappings (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES field_services(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES itens(id),
  campo_quantidade TEXT NOT NULL,
  unidade TEXT,
  condicoes JSONB DEFAULT '[]',
  ativo BOOLEAN DEFAULT TRUE,
  ordem INTEGER DEFAULT 0
);

-- ══════════════════════════════════
-- REGISTROS DE CAMPO
-- ══════════════════════════════════

CREATE TABLE field_records (
  id TEXT PRIMARY KEY,
  contrato_id TEXT NOT NULL REFERENCES contratos(id),
  service_id TEXT NOT NULL REFERENCES field_services(id),
  medicao_id TEXT,
  competencia TEXT NOT NULL,
  usuario_id TEXT NOT NULL,
  data TEXT NOT NULL,
  hora TEXT NOT NULL DEFAULT '',
  latitude NUMERIC,
  longitude NUMERIC,
  km_interpolado NUMERIC,
  estaca_str TEXT,
  valores JSONB NOT NULL DEFAULT '{}',
  calculados JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'registrado',
  observacao TEXT,
  version INTEGER DEFAULT 1,
  sync_status TEXT DEFAULT 'pendente',
  device_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_field_records_contrato ON field_records(contrato_id);
CREATE INDEX idx_field_records_service ON field_records(service_id);
CREATE INDEX idx_field_records_competencia ON field_records(contrato_id, competencia);
CREATE INDEX idx_field_records_status ON field_records(status);

CREATE TABLE record_photos (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES field_records(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  km_interpolado NUMERIC,
  estaca_str TEXT,
  legenda_texto TEXT DEFAULT '',
  data_captura TEXT NOT NULL,
  sync_status TEXT DEFAULT 'pendente'
);

-- ══════════════════════════════════
-- MEDIÇÕES
-- ══════════════════════════════════

CREATE TABLE medicoes (
  id TEXT PRIMARY KEY,
  contrato_id TEXT NOT NULL REFERENCES contratos(id),
  numero INTEGER NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'parcial',
  periodo_inicio TEXT NOT NULL,
  periodo_fim TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho',
  valor_total NUMERIC DEFAULT 0,
  criado_por TEXT NOT NULL,
  fechado_por TEXT,
  fechado_em TIMESTAMPTZ,
  versao INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════════════════════════════
-- RODOVIAS (SNV — COMPARTILHADO COM KMCHECK)
-- ══════════════════════════════════

CREATE TABLE rodovias (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  br TEXT NOT NULL,
  uf TEXT NOT NULL,
  fonte TEXT NOT NULL DEFAULT 'SNV/DNIT',
  km_min NUMERIC NOT NULL,
  km_max NUMERIC NOT NULL,
  -- Arrays de coordenadas (geometria do eixo)
  lat NUMERIC[] NOT NULL,
  lon NUMERIC[] NOT NULL,
  km NUMERIC[] NOT NULL,
  -- Metadados
  versao_snv TEXT,
  data_atualizacao TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_rodovias_br_uf ON rodovias(br, uf);
CREATE INDEX idx_rodovias_br ON rodovias(br);

-- ══════════════════════════════════
-- AUDITORIA
-- ══════════════════════════════════

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  tabela TEXT NOT NULL,
  registro_id TEXT NOT NULL,
  acao TEXT NOT NULL,
  usuario_id TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  dados_anteriores JSONB,
  dados_novos JSONB,
  ip TEXT,
  device_id TEXT
);

CREATE INDEX idx_audit_tabela ON audit_log(tabela, registro_id);

-- ══════════════════════════════════
-- SYNC TRACKING (controle de sync por dispositivo)
-- ══════════════════════════════════

CREATE TABLE sync_log (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tabela TEXT NOT NULL,
  ultimo_sync TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registros_enviados INTEGER DEFAULT 0,
  registros_recebidos INTEGER DEFAULT 0,
  ip TEXT,
  UNIQUE(device_id, tabela)
);
