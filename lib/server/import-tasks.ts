import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import type { ImportField, ImportRow, ParseRule, ValidationIssue } from "@/lib/types";
import { EMPTY_IMPORT_VALUES } from "@/lib/import/constants";
import { validateRows } from "@/lib/import/validation";
import { query, withClient } from "@/lib/server/db";

export type ImportTaskStatus = "pending" | "processing" | "completed" | "partial_success" | "failed";
export type ImportBatchStatus = "pending" | "queued" | "processing" | "completed" | "failed";

type TaskRowPayload = {
  rowNumber: number;
  sourceSheetName: string;
  values: Record<ImportField, string>;
};

type BatchPayload = {
  task_id: string;
  unit_id: string;
  batch_index: number;
  start_row: number;
  end_row: number;
  row_count: number;
  trace_id: string;
};

type ImportTaskRow = {
  id: string;
  file_name: string;
  sheet_name: string;
  rule_id: string | null;
  rule_snapshot: ParseRule | null;
  status: ImportTaskStatus;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  trace_id: string;
  degraded: boolean;
  duplicate_policy: string;
  queued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type ImportBatchRow = {
  id: string;
  task_id: string;
  unit_id: string;
  batch_index: number;
  start_row: number;
  end_row: number;
  status: ImportBatchStatus;
  retry_count: number;
  locked_at: string | null;
  completed_at: string | null;
  processed_count: number;
  success_count: number;
  failure_count: number;
  error_message: string | null;
  trace_id: string;
  created_at: string;
  updated_at: string;
};

type ErrorPayload = {
  rowNumber: number;
  fieldName: string;
  rawValue: string;
  errorCode: string;
  errorReason: string;
  severity: "error" | "warning";
};

const DEFAULT_BATCH_SIZE = 1000;
const MAX_WORKER_RETRIES = 3;
const STALE_LOCK_MINUTES = 5;

function getBatchSize(value?: number) {
  const configured = Number(value || process.env.IMPORT_BATCH_SIZE || DEFAULT_BATCH_SIZE);
  if (!Number.isFinite(configured)) return DEFAULT_BATCH_SIZE;
  return Math.min(2000, Math.max(100, Math.floor(configured)));
}

function getWorkerLimit(value?: number) {
  const configured = Number(value || process.env.IMPORT_WORKER_BATCH_LIMIT || 2);
  if (!Number.isFinite(configured)) return 2;
  return Math.min(10, Math.max(1, Math.floor(configured)));
}

function makeTraceId() {
  return `trace_${randomUUID().replaceAll("-", "")}`;
}

function makeUnitId(batchIndex: number) {
  return `unit_${String(batchIndex).padStart(4, "0")}`;
}

function normalizeTaskRow(row: ImportRow, index: number): TaskRowPayload {
  const values = { ...EMPTY_IMPORT_VALUES, ...(row.values || {}) };
  return {
    rowNumber: Number(row.sourceRowNumber || index + 1),
    sourceSheetName: row.sourceSheetName || "",
    values,
  };
}

function toTask(row: ImportTaskRow) {
  return {
    id: row.id,
    taskId: row.id,
    fileName: row.file_name,
    sheetName: row.sheet_name,
    ruleId: row.rule_id,
    ruleSnapshot: row.rule_snapshot,
    status: row.status,
    totalRows: Number(row.total_rows),
    processedRows: Number(row.processed_rows),
    successRows: Number(row.success_rows),
    failedRows: Number(row.failed_rows),
    totalBatches: Number(row.total_batches),
    completedBatches: Number(row.completed_batches),
    traceId: row.trace_id,
    degraded: Boolean(row.degraded),
    duplicatePolicy: row.duplicate_policy,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBatch(row: ImportBatchRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    unitId: row.unit_id,
    batchIndex: Number(row.batch_index),
    startRow: Number(row.start_row),
    endRow: Number(row.end_row),
    status: row.status,
    retryCount: Number(row.retry_count),
    lockedAt: row.locked_at,
    completedAt: row.completed_at,
    processedCount: Number(row.processed_count),
    successCount: Number(row.success_count),
    failureCount: Number(row.failure_count),
    errorMessage: row.error_message,
    traceId: row.trace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function issueCodeToImportError(code: string) {
  if (code === "required" || code === "receiver_required") return "E002";
  if (code === "phone_format") return "E003";
  if (code === "sku_quantity_positive") return "E004";
  if (code === "external_sku_duplicate_batch") return "E005";
  return "E006";
}

function maskRawValue(fieldName: string, value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (fieldName === "recipientPhone") {
    if (text.length <= 7) return `${text.slice(0, 2)}***`;
    return `${text.slice(0, 3)}****${text.slice(-4)}`;
  }
  if (fieldName === "recipientAddress") {
    return text.length > 8 ? `${text.slice(0, 8)}...` : text;
  }
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function errorFromIssue(row: ImportRow, issue: ValidationIssue): ErrorPayload {
  const fieldName = issue.field;
  const rawValue = fieldName === "global" ? "" : maskRawValue(fieldName, row.values[fieldName]);
  return {
    rowNumber: row.sourceRowNumber,
    fieldName,
    rawValue,
    errorCode: issueCodeToImportError(issue.code),
    errorReason: issue.message,
    severity: "error",
  };
}

async function insertTraceEvent(
  client: PoolClient,
  input: {
    traceId: string;
    taskId?: string;
    unitId?: string;
    eventName: string;
    eventStatus: string;
    message?: string;
    metadata?: Record<string, unknown>;
  }
) {
  await client.query(
    `INSERT INTO public.trace_events (trace_id, task_id, unit_id, event_name, event_status, message, metadata)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.traceId,
      input.taskId || null,
      input.unitId || null,
      input.eventName,
      input.eventStatus,
      input.message || "",
      JSON.stringify(input.metadata || {}),
    ]
  );
}

export async function createImportTask(input: {
  fileName: string;
  sheetName?: string;
  ruleId?: string;
  rule?: ParseRule;
  rows: ImportRow[];
  batchSize?: number;
  duplicatePolicy?: string;
}) {
  const fileName = input.fileName.trim();
  const sheetName = String(input.sheetName || "").trim();
  const rows = input.rows.map(normalizeTaskRow);
  const totalRows = rows.length;
  if (!fileName || totalRows <= 0) {
    throw new Error("fileName and rows are required");
  }

  const batchSize = getBatchSize(input.batchSize);
  const totalBatches = Math.ceil(totalRows / batchSize);
  const traceId = makeTraceId();
  const duplicatePolicy = input.duplicatePolicy || "allow_new_task";

  return withClient(async (client) => {
    const taskResult = await client.query<ImportTaskRow>(
      `INSERT INTO public.import_tasks (
        file_name, sheet_name, rule_id, rule_snapshot, status, total_rows, total_batches,
        trace_id, duplicate_policy, queued_at
      ) VALUES ($1, $2, $3::uuid, $4::jsonb, 'pending', $5, $6, $7, $8, NOW())
      RETURNING id, file_name, sheet_name, rule_id, rule_snapshot, status, total_rows, processed_rows,
        success_rows, failed_rows, total_batches, completed_batches, trace_id, degraded,
        duplicate_policy, queued_at, started_at, completed_at, created_at, updated_at`,
      [
        fileName,
        sheetName,
        input.ruleId || null,
        input.rule ? JSON.stringify(input.rule) : null,
        totalRows,
        totalBatches,
        traceId,
        duplicatePolicy,
      ]
    );

    const task = taskResult.rows[0];
    const taskId = task.id;
    const rowPayload = rows.map((row, index) => ({
      batchIndex: Math.floor(index / batchSize) + 1,
      rowNumber: row.rowNumber,
      sourceSheetName: row.sourceSheetName,
      values: row.values,
    }));
    const batches: BatchPayload[] = Array.from({ length: totalBatches }, (_, index) => {
      const startIndex = index * batchSize;
      const endIndex = Math.min(totalRows, startIndex + batchSize) - 1;
      return {
        task_id: taskId,
        unit_id: makeUnitId(index + 1),
        batch_index: index + 1,
        start_row: rows[startIndex]?.rowNumber ?? startIndex + 1,
        end_row: rows[endIndex]?.rowNumber ?? endIndex + 1,
        row_count: endIndex - startIndex + 1,
        trace_id: traceId,
      };
    });

    await client.query(
      `INSERT INTO public.import_batches (id, file_name, sheet_name, template_fingerprint, total_count, status)
       VALUES ($1::uuid, $2, $3, $4, $5, 'processing')
       ON CONFLICT (id) DO UPDATE SET
         file_name = EXCLUDED.file_name,
         sheet_name = EXCLUDED.sheet_name,
         template_fingerprint = EXCLUDED.template_fingerprint,
         total_count = EXCLUDED.total_count,
         status = 'processing',
         updated_at = NOW()`,
      [taskId, fileName, sheetName || "-", input.ruleId || input.rule?.name || "async-import", totalRows]
    );

    await client.query(
      `INSERT INTO public.import_task_rows (task_id, batch_index, row_number, source_sheet_name, values)
       SELECT $1::uuid,
              (row_data->>'batchIndex')::int,
              (row_data->>'rowNumber')::int,
              NULLIF(row_data->>'sourceSheetName', ''),
              row_data->'values'
       FROM jsonb_array_elements($2::jsonb) AS source(row_data)
       ON CONFLICT (task_id, row_number) DO UPDATE SET
         batch_index = EXCLUDED.batch_index,
         source_sheet_name = EXCLUDED.source_sheet_name,
         values = EXCLUDED.values`,
      [taskId, JSON.stringify(rowPayload)]
    );

    await client.query(
      `INSERT INTO public.import_task_batches (
        task_id, unit_id, batch_index, start_row, end_row, status, trace_id
      )
       SELECT $1::uuid,
              batch_data->>'unit_id',
              (batch_data->>'batch_index')::int,
              (batch_data->>'start_row')::int,
              (batch_data->>'end_row')::int,
              'pending',
              batch_data->>'trace_id'
       FROM jsonb_array_elements($2::jsonb) AS source(batch_data)
       ON CONFLICT (task_id, unit_id) DO NOTHING`,
      [taskId, JSON.stringify(batches)]
    );

    await client.query(
      `INSERT INTO public.event_outbox (aggregate_id, event_type, schema_version, payload, status)
       SELECT $1::uuid, 'ImportBatchCreated', 1, batch_data, 'pending'
       FROM jsonb_array_elements($2::jsonb) AS source(batch_data)`,
      [taskId, JSON.stringify(batches)]
    );

    await insertTraceEvent(client, {
      traceId,
      taskId,
      eventName: "ImportTaskCreated",
      eventStatus: "success",
      message: "用户确认提交，创建异步导入任务和 Outbox 批次事件",
      metadata: { totalRows, totalBatches, batchSize, duplicatePolicy },
    });

    return toTask(task);
  });
}

export async function listImportTasks(limit = 20) {
  const result = await query<ImportTaskRow>(
    `SELECT id, file_name, sheet_name, rule_id, rule_snapshot, status, total_rows, processed_rows,
            success_rows, failed_rows, total_batches, completed_batches, trace_id, degraded,
            duplicate_policy, queued_at, started_at, completed_at, created_at, updated_at
     FROM public.import_tasks
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(100, Math.max(1, limit))]
  );
  return result.rows.map(toTask);
}

export async function getImportTask(taskId: string) {
  const result = await query<ImportTaskRow>(
    `SELECT id, file_name, sheet_name, rule_id, rule_snapshot, status, total_rows, processed_rows,
            success_rows, failed_rows, total_batches, completed_batches, trace_id, degraded,
            duplicate_policy, queued_at, started_at, completed_at, created_at, updated_at
     FROM public.import_tasks
     WHERE id = $1::uuid
     LIMIT 1`,
    [taskId]
  );
  return result.rows[0] ? toTask(result.rows[0]) : null;
}

export async function dispatchOutbox(limit = 20) {
  return withClient(async (client) => {
    const result = await client.query<{
      id: string;
      aggregate_id: string;
      event_type: string;
      payload: BatchPayload;
    }>(
      `SELECT id, aggregate_id, event_type, payload
       FROM public.event_outbox
       WHERE status IN ('pending', 'failed')
         AND event_type = 'ImportBatchCreated'
         AND next_retry_at <= NOW()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [Math.min(100, Math.max(1, limit))]
    );

    for (const event of result.rows) {
      const payload = event.payload;
      await client.query(
        `UPDATE public.import_task_batches
         SET status = 'queued', updated_at = NOW()
         WHERE task_id = $1::uuid
           AND unit_id = $2
           AND status IN ('pending', 'failed', 'queued')`,
        [payload.task_id, payload.unit_id]
      );
      await client.query(
        `UPDATE public.event_outbox
         SET status = 'sent', sent_at = NOW(), last_error = NULL
         WHERE id = $1::uuid`,
        [event.id]
      );
      await client.query(
        `UPDATE public.import_tasks
         SET status = CASE WHEN status = 'pending' THEN 'processing' ELSE status END,
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         WHERE id = $1::uuid`,
        [payload.task_id]
      );
      await insertTraceEvent(client, {
        traceId: payload.trace_id,
        taskId: payload.task_id,
        unitId: payload.unit_id,
        eventName: "ImportBatchEnqueued",
        eventStatus: "success",
        message: "Outbox Dispatcher 将处理单元置为可消费状态",
        metadata: payload,
      });
    }

    return { dispatched: result.rowCount, events: result.rows.map((row) => row.id) };
  });
}

async function recoverStaleBatches() {
  await query(
    `UPDATE public.import_task_batches
     SET status = CASE WHEN retry_count + 1 >= $1 THEN 'failed' ELSE 'queued' END,
         retry_count = retry_count + 1,
         error_message = 'Worker lock timeout, recovered by scanner',
         locked_at = NULL,
         updated_at = NOW()
     WHERE status = 'processing'
       AND locked_at < NOW() - ($2::text)::interval`,
    [MAX_WORKER_RETRIES, `${STALE_LOCK_MINUTES} minutes`]
  );
}

async function claimQueuedBatches(limit: number) {
  return withClient(async (client) => {
    const result = await client.query<ImportBatchRow>(
      `SELECT id, task_id, unit_id, batch_index, start_row, end_row, status, retry_count,
              locked_at, completed_at, processed_count, success_count, failure_count,
              error_message, trace_id, created_at, updated_at
       FROM public.import_task_batches
       WHERE status = 'queued'
       ORDER BY batch_index ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    for (const batch of result.rows) {
      await client.query(
        `UPDATE public.import_task_batches
         SET status = 'processing', locked_at = NOW(), updated_at = NOW()
         WHERE id = $1::uuid`,
        [batch.id]
      );
      await insertTraceEvent(client, {
        traceId: batch.trace_id,
        taskId: batch.task_id,
        unitId: batch.unit_id,
        eventName: "ImportBatchStarted",
        eventStatus: "processing",
        message: "Worker 开始处理批次",
        metadata: { batchIndex: batch.batch_index, startRow: batch.start_row, endRow: batch.end_row },
      });
    }

    return result.rows.map((row) => ({ ...toBatch(row), status: "processing" as ImportBatchStatus }));
  });
}

async function loadDuplicateKeys(taskId: string) {
  const result = await query<{
    external_code: string;
    sku_code: string;
    first_row: number;
    count: number;
  }>(
    `WITH normalized AS (
       SELECT row_number,
              NULLIF(TRIM(values->>'externalCode'), '') AS external_code,
              NULLIF(TRIM(values->>'skuCode'), '') AS sku_code
       FROM public.import_task_rows
       WHERE task_id = $1::uuid
     )
     SELECT external_code, sku_code, MIN(row_number)::int AS first_row, COUNT(*)::int AS count
     FROM normalized
     WHERE external_code IS NOT NULL AND sku_code IS NOT NULL
     GROUP BY external_code, sku_code
     HAVING COUNT(*) > 1`,
    [taskId]
  );

  return new Map(result.rows.map((row) => [`${row.external_code}::${row.sku_code}`, Number(row.first_row)]));
}

async function loadSkuMasterMap(skuCodes: string[]) {
  const uniqueCodes = Array.from(new Set(skuCodes.map((code) => code.trim()).filter(Boolean)));
  if (!uniqueCodes.length) return { degraded: false, skuMap: new Map<string, { name: string; spec: string; unit: string }>() };
  if (process.env.IMPORT_FORCE_SKU_DEGRADED === "1") {
    return { degraded: true, skuMap: new Map<string, { name: string; spec: string; unit: string }>() };
  }

  try {
    const result = await Promise.race([
      query<{ sku_code: string; name: string; spec: string; unit: string }>(
        `SELECT sku_code, name, spec, unit
         FROM public.sku_master
         WHERE active = TRUE AND sku_code = ANY($1::text[])`,
        [uniqueCodes]
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("SKU master query timeout")), 3000);
      }),
    ]);

    return {
      degraded: false,
      skuMap: new Map(result.rows.map((row) => [row.sku_code, { name: row.name, spec: row.spec, unit: row.unit }])),
    };
  } catch {
    return { degraded: true, skuMap: new Map<string, { name: string; spec: string; unit: string }>() };
  }
}

async function insertErrors(client: PoolClient, taskId: string, batch: { unitId: string; batchIndex: number; traceId: string }, errors: ErrorPayload[]) {
  if (!errors.length) return;

  const payload = errors.map((error) => ({
    rowNumber: error.rowNumber,
    fieldName: error.fieldName,
    rawValue: error.rawValue,
    errorCode: error.errorCode,
    errorReason: error.errorReason,
    severity: error.severity,
  }));

  await client.query(
    `INSERT INTO public.import_task_errors (
       task_id, unit_id, batch_index, row_number, field_name, raw_value,
       error_code, error_reason, severity, trace_id
     )
     SELECT $1::uuid,
            $2,
            $3,
            (error_data->>'rowNumber')::int,
            error_data->>'fieldName',
            NULLIF(error_data->>'rawValue', ''),
            error_data->>'errorCode',
            error_data->>'errorReason',
            error_data->>'severity',
            $4
     FROM jsonb_array_elements($5::jsonb) AS source(error_data)`,
    [taskId, batch.unitId, batch.batchIndex, batch.traceId, JSON.stringify(payload)]
  );
}

async function upsertShipments(client: PoolClient, taskId: string, rows: ImportRow[]) {
  if (!rows.length) return 0;

  const payload = rows.map((row) => ({
    rowNumber: row.sourceRowNumber,
    sourceSheetName: row.sourceSheetName || "",
    values: row.values,
  }));

  const result = await client.query<{ id: number }>(
    `INSERT INTO public.shipments (
       batch_id, external_code, store_name, recipient_name, recipient_phone, recipient_address,
       sku_code, sku_name, sku_quantity, sku_spec, note, source_row_number, source_sheet_name,
       sender_name, sender_phone, sender_address, weight_kg, package_count, temperature_zone
     )
     SELECT $1::uuid,
            NULLIF(TRIM(row_data->'values'->>'externalCode'), ''),
            NULLIF(TRIM(row_data->'values'->>'storeName'), ''),
            TRIM(row_data->'values'->>'recipientName'),
            TRIM(row_data->'values'->>'recipientPhone'),
            TRIM(row_data->'values'->>'recipientAddress'),
            TRIM(row_data->'values'->>'skuCode'),
            TRIM(row_data->'values'->>'skuName'),
            (row_data->'values'->>'skuQuantity')::numeric,
            NULLIF(TRIM(row_data->'values'->>'skuSpec'), ''),
            NULLIF(TRIM(row_data->'values'->>'note'), ''),
            (row_data->>'rowNumber')::int,
            NULLIF(row_data->>'sourceSheetName', ''),
            '',
            '',
            '',
            1,
            1,
            '常温'
     FROM jsonb_array_elements($2::jsonb) AS source(row_data)
     ON CONFLICT (external_code, sku_code)
       WHERE external_code IS NOT NULL AND external_code <> '' AND sku_code IS NOT NULL AND sku_code <> ''
     DO UPDATE SET
       batch_id = EXCLUDED.batch_id,
       store_name = EXCLUDED.store_name,
       recipient_name = EXCLUDED.recipient_name,
       recipient_phone = EXCLUDED.recipient_phone,
       recipient_address = EXCLUDED.recipient_address,
       sku_name = EXCLUDED.sku_name,
       sku_quantity = EXCLUDED.sku_quantity,
       sku_spec = EXCLUDED.sku_spec,
       note = EXCLUDED.note,
       source_row_number = EXCLUDED.source_row_number,
       source_sheet_name = EXCLUDED.source_sheet_name
     RETURNING id`,
    [taskId, JSON.stringify(payload)]
  );

  return result.rowCount ?? 0;
}

async function refreshTaskAggregate(client: PoolClient, taskId: string) {
  const aggregate = await client.query<{
    total_batches: number;
    completed_batches: number;
    failed_batches: number;
    processed_rows: number;
    success_rows: number;
    failed_rows: number;
  }>(
    `SELECT
       COUNT(*)::int AS total_batches,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_batches,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_batches,
       COALESCE(SUM(processed_count), 0)::int AS processed_rows,
       COALESCE(SUM(success_count), 0)::int AS success_rows,
       COALESCE(SUM(failure_count), 0)::int AS failed_rows
     FROM public.import_task_batches
     WHERE task_id = $1::uuid`,
    [taskId]
  );
  const row = aggregate.rows[0];
  const final = row.completed_batches + row.failed_batches >= row.total_batches;
  const status: ImportTaskStatus = final
    ? row.failed_batches > 0
      ? row.success_rows > 0
        ? "partial_success"
        : "failed"
      : row.failed_rows > 0
        ? "partial_success"
        : "completed"
    : "processing";

  await client.query(
    `UPDATE public.import_tasks
     SET processed_rows = $2,
         success_rows = $3,
         failed_rows = $4,
         completed_batches = $5,
         status = $6,
         completed_at = CASE WHEN $7 THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
         updated_at = NOW()
     WHERE id = $1::uuid`,
    [taskId, row.processed_rows, row.success_rows, row.failed_rows, row.completed_batches, status, final]
  );

  await client.query(
    `UPDATE public.import_batches
     SET success_count = $2,
         failure_count = $3,
         status = $4,
         updated_at = NOW()
     WHERE id = $1::uuid`,
    [taskId, row.success_rows, row.failed_rows, final ? (status === "failed" ? "failed" : "done") : "processing"]
  );

  if (final) {
    await insertTraceEvent(client, {
      traceId: (await getTraceIdForTask(client, taskId)) || "",
      taskId,
      eventName: status === "completed" ? "ImportTaskCompleted" : status === "partial_success" ? "ImportTaskPartialSuccess" : "ImportTaskFailed",
      eventStatus: status,
      message: "任务批次已全部聚合完成",
      metadata: row,
    });
  }
}

async function getTraceIdForTask(client: PoolClient, taskId: string) {
  const result = await client.query<{ trace_id: string }>(
    `SELECT trace_id FROM public.import_tasks WHERE id = $1::uuid LIMIT 1`,
    [taskId]
  );
  return result.rows[0]?.trace_id || null;
}

async function markBatchFailed(batch: ReturnType<typeof toBatch>, error: unknown) {
  const message = error instanceof Error ? error.message : "Worker failed";
  await withClient(async (client) => {
    const nextFailed = batch.retryCount + 1 >= MAX_WORKER_RETRIES;
    const rowCount = Math.max(0, batch.endRow - batch.startRow + 1);
    await client.query(
      `UPDATE public.import_task_batches
       SET status = $2,
           retry_count = retry_count + 1,
           locked_at = NULL,
           completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE completed_at END,
           processed_count = CASE WHEN $2 = 'failed' THEN $3 ELSE processed_count END,
           success_count = CASE WHEN $2 = 'failed' THEN 0 ELSE success_count END,
           failure_count = CASE WHEN $2 = 'failed' THEN $3 ELSE failure_count END,
           error_message = $4,
           updated_at = NOW()
       WHERE id = $1::uuid`,
      [batch.id, nextFailed ? "failed" : "queued", rowCount, message]
    );
    await insertTraceEvent(client, {
      traceId: batch.traceId,
      taskId: batch.taskId,
      unitId: batch.unitId,
      eventName: "ImportBatchFailed",
      eventStatus: nextFailed ? "failed" : "retrying",
      message,
      metadata: { retryCount: batch.retryCount + 1, maxRetries: MAX_WORKER_RETRIES },
    });
    await refreshTaskAggregate(client, batch.taskId);
  });
}

export async function processImportBatch(batch: ReturnType<typeof toBatch>) {
  const totalStarted = Date.now();
  const parseStarted = Date.now();
  const rowsResult = await query<{
    row_number: number;
    source_sheet_name: string | null;
    values: Record<ImportField, string>;
  }>(
    `SELECT row_number, source_sheet_name, values
     FROM public.import_task_rows
     WHERE task_id = $1::uuid AND batch_index = $2
     ORDER BY row_number ASC`,
    [batch.taskId, batch.batchIndex]
  );
  const parseDuration = Date.now() - parseStarted;

  const ruleStarted = Date.now();
  const importRows: ImportRow[] = rowsResult.rows.map((row, index) => ({
    id: `${batch.unitId}:${index + 1}`,
    sourceRowNumber: Number(row.row_number),
    sourceSheetName: row.source_sheet_name || undefined,
    values: { ...EMPTY_IMPORT_VALUES, ...(row.values || {}) },
    issues: [],
  }));
  const ruleDuration = Date.now() - ruleStarted;

  const validateStarted = Date.now();
  const locallyValidated = validateRows(importRows);
  const duplicateKeys = await loadDuplicateKeys(batch.taskId);
  const skuCodes = locallyValidated.map((row) => String(row.values.skuCode || "").trim());
  const skuResult = await loadSkuMasterMap(skuCodes);

  const errors: ErrorPayload[] = [];
  const validRows: ImportRow[] = [];

  for (const row of locallyValidated) {
    const rowErrors = row.issues.map((issue) => errorFromIssue(row, issue));
    const externalCode = String(row.values.externalCode || "").trim();
    const skuCode = String(row.values.skuCode || "").trim();
    const duplicateFirstRow = duplicateKeys.get(`${externalCode}::${skuCode}`);

    if (duplicateFirstRow && duplicateFirstRow !== row.sourceRowNumber) {
      rowErrors.push({
        rowNumber: row.sourceRowNumber,
        fieldName: "externalCode",
        rawValue: maskRawValue("externalCode", externalCode),
        errorCode: "E005",
        errorReason: `同任务中与第 ${duplicateFirstRow} 行外部编码 + SKU 重复`,
        severity: "error",
      });
    }

    if (!skuResult.degraded && skuCode && !skuResult.skuMap.has(skuCode)) {
      rowErrors.push({
        rowNumber: row.sourceRowNumber,
        fieldName: "skuCode",
        rawValue: maskRawValue("skuCode", skuCode),
        errorCode: "E001",
        errorReason: "SKU 不存在于主数据",
        severity: "error",
      });
    }

    if (skuResult.degraded && skuCode) {
      rowErrors.push({
        rowNumber: row.sourceRowNumber,
        fieldName: "skuCode",
        rawValue: maskRawValue("skuCode", skuCode),
        errorCode: "W001",
        errorReason: "SKU 校验已降级，本行未经过商品主数据完整校验",
        severity: "warning",
      });
    }

    errors.push(...rowErrors);
    if (!rowErrors.some((error) => error.severity === "error")) {
      validRows.push(row);
    }
  }
  const validateDuration = Date.now() - validateStarted;

  const insertStarted = Date.now();
  await withClient(async (client) => {
    await client.query(
      `DELETE FROM public.import_task_errors
       WHERE task_id = $1::uuid AND unit_id = $2`,
      [batch.taskId, batch.unitId]
    );
    await insertErrors(client, batch.taskId, batch, errors);

    const insertedCount = await upsertShipments(client, batch.taskId, validRows);
    const insertDuration = Date.now() - insertStarted;
    const errorRowNumbers = new Set(errors.filter((error) => error.severity === "error").map((error) => error.rowNumber));
    const warningCount = errors.filter((error) => error.severity === "warning").length;
    const failureCount = errorRowNumbers.size;
    const successCount = insertedCount;
    const processedCount = locallyValidated.length;

    if (skuResult.degraded) {
      await client.query(
        `UPDATE public.import_tasks
         SET degraded = TRUE, updated_at = NOW()
         WHERE id = $1::uuid`,
        [batch.taskId]
      );
      await insertTraceEvent(client, {
        traceId: batch.traceId,
        taskId: batch.taskId,
        unitId: batch.unitId,
        eventName: "ImportTaskDegraded",
        eventStatus: "warning",
        message: "SKU 主数据查询超时或不可用，当前批次进入降级校验",
        metadata: { batchIndex: batch.batchIndex, warningCount },
      });
    }

    await client.query(
      `INSERT INTO public.batch_performance_log (
         task_id, unit_id, batch_index, parse_duration_ms, rule_duration_ms,
         validate_duration_ms, insert_duration_ms, total_duration_ms, status, trace_id
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'completed', $9)`,
      [
        batch.taskId,
        batch.unitId,
        batch.batchIndex,
        parseDuration,
        ruleDuration,
        validateDuration,
        insertDuration,
        Date.now() - totalStarted,
        batch.traceId,
      ]
    );

    await client.query(
      `UPDATE public.import_task_batches
       SET status = 'completed',
           locked_at = NULL,
           completed_at = NOW(),
           processed_count = $2,
           success_count = $3,
           failure_count = $4,
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $1::uuid`,
      [batch.id, processedCount, successCount, failureCount]
    );

    await insertTraceEvent(client, {
      traceId: batch.traceId,
      taskId: batch.taskId,
      unitId: batch.unitId,
      eventName: "ImportBatchSucceeded",
      eventStatus: failureCount ? "partial_success" : "success",
      message: "Worker 完成批量校验和批量写入",
      metadata: {
        batchIndex: batch.batchIndex,
        processedCount,
        successCount,
        failureCount,
        warningCount,
        parseDuration,
        ruleDuration,
        validateDuration,
        insertDuration,
      },
    });

    await refreshTaskAggregate(client, batch.taskId);
  });

  return { unitId: batch.unitId, batchIndex: batch.batchIndex, processed: locallyValidated.length };
}

export async function processQueuedBatches(limit?: number) {
  await recoverStaleBatches();
  const batches = await claimQueuedBatches(getWorkerLimit(limit));
  const completed: Array<{ unitId: string; batchIndex: number; processed: number }> = [];
  const failed: Array<{ unitId: string; error: string }> = [];

  for (const batch of batches) {
    try {
      const result = await processImportBatch(batch);
      completed.push(result);
    } catch (error) {
      await markBatchFailed(batch, error);
      failed.push({ unitId: batch.unitId, error: error instanceof Error ? error.message : "Worker failed" });
    }
  }

  return { claimed: batches.length, completed, failed };
}

export async function listTaskErrors(input: {
  taskId: string;
  batch?: number;
  errorCode?: string;
  page: number;
  pageSize: number;
}) {
  const where = ["task_id = $1::uuid"];
  const values: unknown[] = [input.taskId];
  if (input.batch) {
    values.push(input.batch);
    where.push(`batch_index = $${values.length}`);
  }
  if (input.errorCode) {
    values.push(input.errorCode);
    where.push(`error_code = $${values.length}`);
  }

  const pageSize = Math.min(200, Math.max(1, input.pageSize));
  const page = Math.max(1, input.page);
  const limitIndex = values.push(pageSize);
  const offsetIndex = values.push((page - 1) * pageSize);
  const whereSql = where.join(" AND ");

  const [items, total] = await Promise.all([
    query<{
      id: number;
      task_id: string;
      unit_id: string;
      batch_index: number;
      row_number: number;
      field_name: string;
      raw_value: string | null;
      error_code: string;
      error_reason: string;
      severity: "error" | "warning";
      trace_id: string;
      created_at: string;
    }>(
      `SELECT id, task_id, unit_id, batch_index, row_number, field_name, raw_value,
              error_code, error_reason, severity, trace_id, created_at
       FROM public.import_task_errors
       WHERE ${whereSql}
       ORDER BY batch_index ASC, row_number ASC, id ASC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      values
    ),
    query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM public.import_task_errors
       WHERE ${whereSql}`,
      values.slice(0, values.length - 2)
    ),
  ]);

  return {
    items: items.rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      unitId: row.unit_id,
      batchIndex: Number(row.batch_index),
      rowNumber: Number(row.row_number),
      fieldName: row.field_name,
      rawValue: row.raw_value || "",
      errorCode: row.error_code,
      errorReason: row.error_reason,
      severity: row.severity,
      traceId: row.trace_id,
      createdAt: row.created_at,
    })),
    total: total.rows[0]?.total ?? 0,
    page,
    pageSize,
  };
}

export async function listTaskBatches(taskId: string) {
  const result = await query<ImportBatchRow>(
    `SELECT id, task_id, unit_id, batch_index, start_row, end_row, status, retry_count,
            locked_at, completed_at, processed_count, success_count, failure_count,
            error_message, trace_id, created_at, updated_at
     FROM public.import_task_batches
     WHERE task_id = $1::uuid
     ORDER BY batch_index ASC`,
    [taskId]
  );
  return result.rows.map(toBatch);
}

export async function getTraceEvents(traceId: string) {
  const result = await query<{
    id: number;
    trace_id: string;
    task_id: string | null;
    unit_id: string | null;
    event_name: string;
    event_status: string;
    message: string;
    metadata: Record<string, unknown>;
    occurred_at: string;
  }>(
    `SELECT id, trace_id, task_id, unit_id, event_name, event_status, message, metadata, occurred_at
     FROM public.trace_events
     WHERE trace_id = $1
     ORDER BY occurred_at ASC, id ASC`,
    [traceId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    traceId: row.trace_id,
    taskId: row.task_id,
    unitId: row.unit_id,
    eventName: row.event_name,
    eventStatus: row.event_status,
    message: row.message,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
  }));
}

export async function getImportMonitorSummary() {
  const [throughput, queueDepth, latency, errors, slowBatches, taskStatus] = await Promise.all([
    query<{ minute: string; success_rows: number }>(
      `SELECT to_char(date_trunc('minute', completed_at), 'HH24:MI') AS minute,
              COALESCE(SUM(success_count), 0)::int AS success_rows
       FROM public.import_task_batches
       WHERE completed_at >= NOW() - INTERVAL '5 minutes'
       GROUP BY date_trunc('minute', completed_at)
       ORDER BY date_trunc('minute', completed_at) ASC`
    ),
    query<{ batches: number; rows: number }>(
      `SELECT COUNT(*)::int AS batches,
              COALESCE(SUM(GREATEST(end_row - start_row + 1, 0)), 0)::int AS rows
       FROM public.import_task_batches
       WHERE status IN ('pending', 'queued', 'processing')`
    ),
    query<{
      parse_p50: number | null;
      parse_p95: number | null;
      parse_p99: number | null;
      rule_p50: number | null;
      rule_p95: number | null;
      rule_p99: number | null;
      validate_p50: number | null;
      validate_p95: number | null;
      validate_p99: number | null;
      insert_p50: number | null;
      insert_p95: number | null;
      insert_p99: number | null;
    }>(
      `SELECT
         percentile_cont(0.50) WITHIN GROUP (ORDER BY parse_duration_ms)::float AS parse_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY parse_duration_ms)::float AS parse_p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY parse_duration_ms)::float AS parse_p99,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY rule_duration_ms)::float AS rule_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY rule_duration_ms)::float AS rule_p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY rule_duration_ms)::float AS rule_p99,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY validate_duration_ms)::float AS validate_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY validate_duration_ms)::float AS validate_p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY validate_duration_ms)::float AS validate_p99,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY insert_duration_ms)::float AS insert_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY insert_duration_ms)::float AS insert_p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY insert_duration_ms)::float AS insert_p99
       FROM public.batch_performance_log
       WHERE created_at >= NOW() - INTERVAL '24 hours'`
    ),
    query<{ error_code: string; error_reason: string; count: number }>(
      `SELECT error_code, MIN(error_reason) AS error_reason, COUNT(*)::int AS count
       FROM public.import_task_errors
       WHERE severity = 'error' AND created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY error_code
       ORDER BY count DESC`
    ),
    query<{
      task_id: string;
      unit_id: string;
      batch_index: number;
      total_duration_ms: number;
      status: string;
      trace_id: string;
      created_at: string;
    }>(
      `SELECT task_id, unit_id, batch_index, total_duration_ms, status, trace_id, created_at
       FROM public.batch_performance_log
       ORDER BY total_duration_ms DESC, created_at DESC
       LIMIT 10`
    ),
    query<{ status: ImportTaskStatus; count: number }>(
      `SELECT status, COUNT(*)::int AS count
       FROM public.import_tasks
       WHERE created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY status
       ORDER BY status ASC`
    ),
  ]);

  return {
    throughput: throughput.rows.map((row) => ({ minute: row.minute, successRows: Number(row.success_rows) })),
    queueDepth: {
      batches: Number(queueDepth.rows[0]?.batches ?? 0),
      rows: Number(queueDepth.rows[0]?.rows ?? 0),
      level: Number(queueDepth.rows[0]?.rows ?? 0) > 5000 ? "warning" : "normal",
      available: true,
    },
    stageLatency: latency.rows[0] || null,
    errorDistribution: errors.rows.map((row) => ({
      errorCode: row.error_code,
      errorReason: row.error_reason,
      count: Number(row.count),
    })),
    slowBatches: slowBatches.rows.map((row) => ({
      taskId: row.task_id,
      unitId: row.unit_id,
      batchIndex: Number(row.batch_index),
      totalDurationMs: Number(row.total_duration_ms),
      status: row.status,
      traceId: row.trace_id,
      createdAt: row.created_at,
    })),
    taskStatus: taskStatus.rows.map((row) => ({ status: row.status, count: Number(row.count) })),
  };
}
