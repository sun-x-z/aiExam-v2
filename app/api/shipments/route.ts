import { listShipments } from "@/lib/server/shipments";
import { jsonError, jsonOk } from "@/lib/server/http";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get("page") || "1"));
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize") || "20")));

    const result = await listShipments({
      q: searchParams.get("q") || "",
      externalCode: searchParams.get("externalCode") || "",
      recipientName: searchParams.get("recipientName") || "",
      from: searchParams.get("from") || "",
      to: searchParams.get("to") || "",
      page,
      pageSize,
    });

    return jsonOk({
      items: result.items,
      total: result.total,
      page,
      pageSize,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to load shipments", 500);
  }
}

