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
  sku_code TEXT NOT NULL,
  sku_name TEXT NOT NULL,
  sku_quantity NUMERIC(12, 3) NOT NULL,
  sku_spec TEXT,
  note TEXT,
  source_row_number INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS public.sku_master (
  id BIGSERIAL PRIMARY KEY,
  sku_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '件',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.import_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT NOT NULL,
  sheet_name TEXT NOT NULL DEFAULT '',
  rule_id UUID,
  rule_snapshot JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  success_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows INTEGER NOT NULL DEFAULT 0,
  total_batches INTEGER NOT NULL DEFAULT 0,
  completed_batches INTEGER NOT NULL DEFAULT 0,
  trace_id TEXT NOT NULL UNIQUE,
  degraded BOOLEAN NOT NULL DEFAULT FALSE,
  duplicate_policy TEXT NOT NULL DEFAULT 'allow_new_task',
  queued_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.import_task_rows (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES public.import_tasks(id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL,
  row_number INTEGER NOT NULL,
  source_sheet_name TEXT,
  values JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, row_number)
);

CREATE TABLE IF NOT EXISTS public.import_task_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.import_tasks(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  start_row INTEGER NOT NULL,
  end_row INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  processed_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  trace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, unit_id),
  UNIQUE (task_id, batch_index)
);

CREATE TABLE IF NOT EXISTS public.import_task_errors (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES public.import_tasks(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  row_number INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  raw_value TEXT,
  error_code TEXT NOT NULL,
  error_reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  trace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.import_task_errors ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'error';

CREATE TABLE IF NOT EXISTS public.event_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.batch_performance_log (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES public.import_tasks(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  parse_duration_ms INTEGER NOT NULL DEFAULT 0,
  rule_duration_ms INTEGER NOT NULL DEFAULT 0,
  validate_duration_ms INTEGER NOT NULL DEFAULT 0,
  insert_duration_ms INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.trace_events (
  id BIGSERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  task_id UUID,
  unit_id TEXT,
  event_name TEXT NOT NULL,
  event_status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sku_master_sku_code
  ON public.sku_master (sku_code);

CREATE INDEX IF NOT EXISTS idx_import_tasks_status_created
  ON public.import_tasks (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_task_rows_task_batch
  ON public.import_task_rows (task_id, batch_index);

CREATE INDEX IF NOT EXISTS idx_import_task_batches_task_unit
  ON public.import_task_batches (task_id, unit_id);

CREATE INDEX IF NOT EXISTS idx_import_task_batches_status_locked
  ON public.import_task_batches (status, locked_at);

CREATE INDEX IF NOT EXISTS idx_import_task_errors_task_unit
  ON public.import_task_errors (task_id, unit_id);

CREATE INDEX IF NOT EXISTS idx_import_task_errors_code
  ON public.import_task_errors (error_code);

CREATE INDEX IF NOT EXISTS idx_event_outbox_status_retry
  ON public.event_outbox (status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_batch_performance_task_unit
  ON public.batch_performance_log (task_id, unit_id);

CREATE INDEX IF NOT EXISTS idx_trace_events_trace_time
  ON public.trace_events (trace_id, occurred_at);
