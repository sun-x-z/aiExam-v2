import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

let pool: Pool | null = null;
let bootstrapPromise: Promise<void> | null = null;

function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.NEON_POSTGRES_URL ||
    ""
  ).trim();
}

function getPool() {
  if (pool) return pool;

  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    const error = new Error("Database connection string is not configured.");
    (error as Error & { code?: string }).code = "DB_CONFIG_MISSING";
    throw error;
  }

  pool = new Pool({
    connectionString,
    max: 1,
    ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
  });

  return pool;
}

export async function bootstrapDatabase() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const client = getPool();
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;

        CREATE TABLE IF NOT EXISTS public.template_rules (
          id BIGSERIAL PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE,
          sheet_name TEXT NOT NULL,
          header_row_index INTEGER NOT NULL,
          column_mapping JSONB NOT NULL,
          header_names JSONB NOT NULL,
          confidence INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS public.parse_rules (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          description TEXT,
          file_kind TEXT NOT NULL,
          rule JSONB NOT NULL,
          ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
          confidence INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_parse_rules_file_kind
          ON public.parse_rules (file_kind);

        CREATE TABLE IF NOT EXISTS public.import_batches (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          file_name TEXT NOT NULL,
          sheet_name TEXT NOT NULL,
          template_fingerprint TEXT NOT NULL,
          total_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS public.shipments (
          id BIGSERIAL PRIMARY KEY,
          batch_id UUID REFERENCES public.import_batches(id) ON DELETE SET NULL,
          external_code TEXT,
          store_name TEXT,
          recipient_name TEXT,
          recipient_phone TEXT,
          recipient_address TEXT,
          sku_code TEXT NOT NULL DEFAULT '',
          sku_name TEXT NOT NULL DEFAULT '',
          sku_quantity NUMERIC(12, 3) NOT NULL DEFAULT 0,
          sku_spec TEXT,
          note TEXT,
          source_row_number INTEGER NOT NULL DEFAULT 0,
          source_sheet_name TEXT,
          sender_name TEXT NOT NULL DEFAULT '',
          sender_phone TEXT NOT NULL DEFAULT '',
          sender_address TEXT NOT NULL DEFAULT '',
          weight_kg NUMERIC(12, 3) NOT NULL DEFAULT 1,
          package_count INTEGER NOT NULL DEFAULT 1,
          temperature_zone TEXT NOT NULL DEFAULT '常温',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS store_name TEXT;
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS sku_code TEXT;
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS sku_name TEXT;
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS sku_quantity NUMERIC(12, 3);
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS sku_spec TEXT;
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS source_sheet_name TEXT;
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS sender_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS sender_phone TEXT NOT NULL DEFAULT '';
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS sender_address TEXT NOT NULL DEFAULT '';
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(12, 3) NOT NULL DEFAULT 1;
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS package_count INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS temperature_zone TEXT NOT NULL DEFAULT '常温';

        UPDATE public.shipments SET sku_code = COALESCE(sku_code, external_code, CONCAT('legacy-', id));
        UPDATE public.shipments SET sku_name = COALESCE(sku_name, note, '历史数据');
        UPDATE public.shipments SET sku_quantity = COALESCE(sku_quantity, package_count, 1);

        ALTER TABLE public.shipments ALTER COLUMN recipient_name DROP NOT NULL;
        ALTER TABLE public.shipments ALTER COLUMN recipient_phone DROP NOT NULL;
        ALTER TABLE public.shipments ALTER COLUMN recipient_address DROP NOT NULL;
        ALTER TABLE public.shipments ALTER COLUMN sku_code SET DEFAULT '';
        ALTER TABLE public.shipments ALTER COLUMN sku_name SET DEFAULT '';
        ALTER TABLE public.shipments ALTER COLUMN sku_quantity SET DEFAULT 0;

        DROP INDEX IF EXISTS idx_shipments_external_code_unique;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_external_code_sku_unique
          ON public.shipments (external_code, sku_code)
          WHERE external_code IS NOT NULL AND external_code <> '' AND sku_code IS NOT NULL AND sku_code <> '';

        CREATE INDEX IF NOT EXISTS idx_shipments_recipient_name
          ON public.shipments (recipient_name);

        CREATE INDEX IF NOT EXISTS idx_shipments_store_name
          ON public.shipments (store_name);

        CREATE INDEX IF NOT EXISTS idx_shipments_created_at
          ON public.shipments (created_at DESC);
      `);

    })().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }

  return bootstrapPromise;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  await bootstrapDatabase();
  return getPool().query<T>(text, params) as Promise<QueryResult<T>>;
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>) {
  await bootstrapDatabase();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
