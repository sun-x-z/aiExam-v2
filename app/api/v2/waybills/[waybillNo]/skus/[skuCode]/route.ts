import { jsonError, jsonOk } from "@/lib/server/http";
import { getLocalV2Waybill, isAuthorizedV2Request } from "@/lib/server/local-v2-adapter";

export async function GET(request: Request, context: { params: Promise<{ waybillNo: string; skuCode: string }> }) {
  if (!isAuthorizedV2Request(request)) return jsonError("Unauthorized", 401);
  const { waybillNo, skuCode } = await context.params;
  const waybill = await getLocalV2Waybill(decodeURIComponent(waybillNo));
  if (!waybill) return jsonError("运单不存在", 404);
  const sku = waybill.skus.find((item) => item.skuCode === decodeURIComponent(skuCode));
  if (!sku) return jsonError("SKU 不属于该运单", 404);
  return jsonOk({ exists: true, sku, waybill });
}
