import { listTaskBatches } from "@/lib/server/import-tasks";
import { jsonError, jsonOk } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await context.params;
    if (!taskId) return jsonError("taskId is required");

    const batches = await listTaskBatches(taskId);
    return jsonOk({ batches });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to load task batches", 500);
  }
}
