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
    const inserted: Array<Pick<ShipmentRecord, "id" | "sourceRowNumber" | "externalCode">> = [];
    const failures: Array<{ rowNumber: number; message: string; field: string }> = [];

    for (const row of rows) {
      const externalCode = String(row.values.externalCode || "").trim() || null;
      const storeName = String(row.values.storeName || "").trim() || null;
      const recipientName = String(row.values.recipientName || "").trim();
      const recipientPhone = String(row.values.recipientPhone || "").trim();
      const recipientAddress = String(row.values.recipientAddress || "").trim();
      const skuCode = String(row.values.skuCode || "").trim();
      const skuName = String(row.values.skuName || "").trim();
      const skuQuantity = Number(row.values.skuQuantity);
      const skuSpec = String(row.values.skuSpec || "").trim() || null;
      const note = String(row.values.note || "").trim() || null;
      const sourceSheetName = row.sourceSheetName || null;

      if (row.issues.length > 0) {
        failures.push({ rowNumber: row.sourceRowNumber, message: "存在校验错误，已跳过", field: "global" });
        continue;
      }

      try {
        const duplicateCheck = externalCode
          ? await client.query<{ id: number }>(
              `SELECT id FROM public.shipments WHERE external_code = $1 AND sku_code = $2 LIMIT 1`,
              [externalCode, skuCode]
            )
          : { rows: [] as Array<{ id: number }> };

        if (externalCode && duplicateCheck.rows[0]) {
          failures.push({ rowNumber: row.sourceRowNumber, message: "外部编码 + SKU 已存在于历史运单中", field: "externalCode" });
          continue;
        }

        const result = await client.query<{
          id: number;
          batch_id: string;
          external_code: string | null;
          source_row_number: number;
        }>(
          `INSERT INTO public.shipments (
            batch_id, external_code, store_name, recipient_name, recipient_phone, recipient_address,
            sku_code, sku_name, sku_quantity, sku_spec, note, source_row_number, source_sheet_name,
            sender_name, sender_phone, sender_address, weight_kg, package_count, temperature_zone
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'','','',1,1,'常温')
          RETURNING id, batch_id, external_code, source_row_number`,
          [
            batchId,
            externalCode,
            storeName,
            recipientName,
            recipientPhone,
            recipientAddress,
            skuCode,
            skuName,
            skuQuantity,
            skuSpec,
            note,
            row.sourceRowNumber,
            sourceSheetName,
          ]
        );

        inserted.push({
          id: result.rows[0].id,
          sourceRowNumber: result.rows[0].source_row_number,
          externalCode: result.rows[0].external_code,
        });
      } catch (error) {
        failures.push({ rowNumber: row.sourceRowNumber, message: error instanceof Error ? error.message : "插入失败", field: "global" });
      }
    }

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
