import type { ImportRow } from "@/lib/types";
import { insertShipmentRows, updateBatchSummary } from "@/lib/server/shipments";
import { jsonError, jsonOk } from "@/lib/server/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string }> }
) {
  try {
    const { batchId } = await context.params;
    const body = (await request.json()) as {
      rows?: ImportRow[];
      successCount?: number;
      failureCount?: number;
      finalize?: boolean;
    };

    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!batchId || !rows.length) {
      return jsonError("batchId and rows are required");
    }

    const result = await insertShipmentRows(batchId, rows);
    const successCount = Number(body.successCount ?? 0) + result.inserted.length;
    const failureCount = Number(body.failureCount ?? 0) + result.failures.length;

    if (body.finalize) {
      await updateBatchSummary(batchId, successCount, failureCount);
    }

    return jsonOk({
      inserted: result.inserted,
      failures: result.failures,
      successCount,
      failureCount,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to submit batch chunk", 500);
  }
}
