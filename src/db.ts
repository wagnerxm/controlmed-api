/**
 * Conexão com PostgreSQL via pg Pool
 * Usa DATABASE_URL do .env
 */
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/* Helper: executa query tipada */
export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/* Helper: executa query e retorna uma linha */
export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const result = await pool.query(text, params);
  return (result.rows[0] as T) ?? null;
}

/* Teste de conexão no boot */
export async function testConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT NOW()');
    console.log(`✅ PostgreSQL conectado: ${res.rows[0].now}`);
  } finally {
    client.release();
  }
}
