import { query } from "@/lib/server/db";

type WaybillSku = {
  skuCode: string;
  skuName: string;
  quantity: number;
  spec?: string | null;
};

type ShipmentForV2 = {
  external_code: string | null;
  store_name: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  recipient_address: string | null;
  sku_code: string;
  sku_name: string;
  sku_quantity: string;
  sku_spec: string | null;
  created_at: string;
};

export function isAuthorizedV2Request(request: Request) {
  const expectedKey = process.env.V2_API_KEY?.trim() || "local-dev-v2-key";
  return request.headers.get("x-api-key") === expectedKey;
}

function toWaybill(rows: ShipmentForV2[]) {
  const first = rows[0];
  const skus: WaybillSku[] = rows.map((row) => ({
    skuCode: row.sku_code,
    skuName: row.sku_name,
    quantity: Number(row.sku_quantity || 0),
    spec: row.sku_spec,
  }));
  const amount = skus.reduce((sum, sku) => sum + Math.max(1, sku.quantity) * 128.5, 0);
  return {
    waybillNo: first.external_code || "",
    externalCode: first.external_code || "",
    storeName: first.store_name,
    senderName: "V2 导入系统",
    senderPhone: "",
    senderAddress: "",
    recipientName: first.recipient_name,
    recipientPhone: first.recipient_phone,
    recipientAddress: first.recipient_address,
    amount: Math.round(amount * 100) / 100,
    status: "synced_from_v2_adapter",
    tenantId: "default",
    warehouseId: "WH-SH-01",
    skus,
    sourceUpdatedAt: first.created_at,
    etag: `local-${first.external_code}-${rows.length}`,
  };
}

export async function getLocalV2Waybill(waybillNo: string) {
  const result = await query<ShipmentForV2>(
    `SELECT external_code, store_name, recipient_name, recipient_phone, recipient_address,
            sku_code, sku_name, sku_quantity, sku_spec, created_at
     FROM public.shipments
     WHERE external_code = $1
     ORDER BY id ASC`,
    [waybillNo]
  );
  if (!result.rows.length) return null;
  return toWaybill(result.rows);
}

export async function getLocalV2WaybillList(params: { q?: string; limit?: number }) {
  const values: unknown[] = [];
  const where: string[] = [`external_code IS NOT NULL`, `external_code <> ''`];
  if (params.q) {
    values.push(`%${params.q}%`);
    where.push(`(external_code ILIKE $${values.length} OR recipient_name ILIKE $${values.length} OR store_name ILIKE $${values.length})`);
  }
  const limitIndex = values.push(Math.min(100, Math.max(1, params.limit || 20)));
  const result = await query<{ external_code: string }>(
    `SELECT external_code
     FROM public.shipments
     WHERE ${where.join(" AND ")}
     GROUP BY external_code
     ORDER BY MAX(created_at) DESC
     LIMIT $${limitIndex}`,
    values
  );
  const waybills = [];
  for (const row of result.rows) {
    const waybill = await getLocalV2Waybill(row.external_code);
    if (waybill) waybills.push(waybill);
  }
  return waybills;
}
