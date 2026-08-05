import type { ImportBatchRecord, ImportRow, ShipmentRecord } from "@/lib/types";
import { query, withClient } from "@/lib/server/db";

export async function createImportBatch(fileName: string, sheetName: string, templateFingerprint: string, totalCount: number) {
  const result = await query<{
    id: string;
    file_name: string;
    sheet_name: string;
    template_fingerprint: string;
    total_count: number;
    success_count: number;
    failure_count: number;
    status: ImportBatchRecord["status"];
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO public.import_batches (file_name, sheet_name, template_fingerprint, total_count, status)
     VALUES ($1, $2, $3, $4, 'draft')
     RETURNING id, file_name, sheet_name, template_fingerprint, total_count, success_count, failure_count, status, created_at, updated_at`,
    [fileName, sheetName, templateFingerprint, totalCount]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    fileName: row.file_name,
    sheetName: row.sheet_name,
    templateFingerprint: row.template_fingerprint,
    totalCount: row.total_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function updateBatchSummary(batchId: string, successCount: number, failureCount: number, status: ImportBatchRecord["status"] = "done") {
  await query(
    `UPDATE public.import_batches
     SET success_count = $2, failure_count = $3, status = $4, updated_at = NOW()
     WHERE id = $1`,
    [batchId, successCount, failureCount, status]
  );
}

export async function insertShipmentRows(batchId: string, rows: ImportRow[]) {
  return withClient(async (client) => {
    const failures: Array<{ rowNumber: number; message: string; field: string }> = [];
    const candidates = rows.filter((row) => {
      if (row.issues.length > 0) {
        failures.push({ rowNumber: row.sourceRowNumber, message: "存在校验错误，已跳过", field: "global" });
        return false;
      }
      return true;
    });

    if (!candidates.length) {
      return { inserted: [], failures };
    }

    const payload = candidates.map((row) => ({
      rowNumber: row.sourceRowNumber,
      sourceSheetName: row.sourceSheetName || "",
      values: row.values,
    }));

    const duplicates = await client.query<{ row_number: number }>(
      `WITH incoming AS (
         SELECT (row_data->>'rowNumber')::int AS row_number,
                NULLIF(TRIM(row_data->'values'->>'externalCode'), '') AS external_code,
                TRIM(row_data->'values'->>'skuCode') AS sku_code
         FROM jsonb_array_elements($1::jsonb) AS source(row_data)
       )
       SELECT incoming.row_number
       FROM incoming
       JOIN public.shipments shipment
         ON shipment.external_code = incoming.external_code
        AND shipment.sku_code = incoming.sku_code
       WHERE incoming.external_code IS NOT NULL`,
      [JSON.stringify(payload)]
    );
    const duplicateRows = new Set(duplicates.rows.map((row) => Number(row.row_number)));
    for (const rowNumber of duplicateRows) {
      failures.push({ rowNumber, message: "外部编码 + SKU 已存在于历史运单中", field: "externalCode" });
    }

    const insertPayload = payload.filter((row) => !duplicateRows.has(row.rowNumber));
    if (!insertPayload.length) {
      return { inserted: [], failures };
    }

    const result = await client.query<{
      id: number;
      external_code: string | null;
      source_row_number: number;
    }>(
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
       DO NOTHING
       RETURNING id, external_code, source_row_number`,
      [batchId, JSON.stringify(insertPayload)]
    );

    const inserted = result.rows.map((row) => ({
      id: row.id,
      sourceRowNumber: row.source_row_number,
      externalCode: row.external_code,
    }));

    return { inserted, failures };
  });
}

export async function listShipments(params: {
  q?: string;
  externalCode?: string;
  recipientName?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}) {
  const where: string[] = [];
  const values: unknown[] = [];

  if (params.q) {
    values.push(`%${params.q}%`);
    where.push(`(external_code ILIKE $${values.length} OR recipient_name ILIKE $${values.length} OR store_name ILIKE $${values.length} OR sku_name ILIKE $${values.length})`);
  }
  if (params.externalCode) {
    values.push(`%${params.externalCode}%`);
    where.push(`external_code ILIKE $${values.length}`);
  }
  if (params.recipientName) {
    values.push(`%${params.recipientName}%`);
    where.push(`(recipient_name ILIKE $${values.length} OR store_name ILIKE $${values.length})`);
  }
  if (params.from) {
    values.push(params.from);
    where.push(`created_at >= $${values.length}::timestamptz`);
  }
  if (params.to) {
    values.push(params.to);
    where.push(`created_at <= $${values.length}::timestamptz`);
  }

  const offset = (params.page - 1) * params.pageSize;
  const limitIndex = values.push(params.pageSize);
  const offsetIndex = values.push(offset);
  const sql = `
    SELECT id, batch_id, external_code, store_name, recipient_name, recipient_phone, recipient_address,
           sku_code, sku_name, sku_quantity, sku_spec, note, source_row_number, source_sheet_name, created_at
    FROM public.shipments
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC, id DESC
    LIMIT $${limitIndex} OFFSET $${offsetIndex}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM public.shipments
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
  `;

  const [itemsResult, countResult] = await Promise.all([
    query<{
      id: number;
      batch_id: string;
      external_code: string | null;
      store_name: string | null;
      recipient_name: string | null;
      recipient_phone: string | null;
      recipient_address: string | null;
      sku_code: string;
      sku_name: string;
      sku_quantity: number;
      sku_spec: string | null;
      note: string | null;
      source_row_number: number;
      source_sheet_name: string | null;
      created_at: string;
    }>(sql, values),
    query<{ total: number }>(countSql, values.slice(0, values.length - 2)),
  ]);

  return {
    items: itemsResult.rows.map((row: (typeof itemsResult.rows)[number]) => ({
      id: row.id,
      batchId: row.batch_id,
      externalCode: row.external_code,
      storeName: row.store_name,
      recipientName: row.recipient_name,
      recipientPhone: row.recipient_phone,
      recipientAddress: row.recipient_address,
      skuCode: row.sku_code || "",
      skuName: row.sku_name || "",
      skuQuantity: Number(row.sku_quantity),
      skuSpec: row.sku_spec,
      note: row.note,
      sourceRowNumber: row.source_row_number,
      sourceSheetName: row.source_sheet_name,
      createdAt: row.created_at,
    })),
    total: countResult.rows[0]?.total ?? 0,
  };
}

export async function getDuplicateExternalCodes(codes: string[]) {
  const normalized = codes.map((code) => String(code || "").trim()).filter(Boolean);
  if (!normalized.length) return new Map<string, number>();

  const placeholders = normalized.map((_, index) => `$${index + 1}`).join(", ");
  const result = await query<{ external_code: string; count: number }>(
    `SELECT external_code, COUNT(*)::int AS count
     FROM public.shipments
     WHERE external_code IN (${placeholders})
     GROUP BY external_code`,
    normalized
  );

  return new Map(result.rows.map((row: (typeof result.rows)[number]) => [row.external_code, row.count]));
}
