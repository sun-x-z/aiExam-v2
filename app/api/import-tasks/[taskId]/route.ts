import { getImportTask } from "@/lib/server/import-tasks";
import { jsonError, jsonOk } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await context.params;
    if (!taskId) return jsonError("taskId is required");

    const task = await getImportTask(taskId);
    if (!task) return jsonError("Import task not found", 404);

    return jsonOk({
      task,
      task_id: task.taskId,
      status: task.status.toUpperCase(),
      total_rows: task.totalRows,
      processed_rows: task.processedRows,
      success_rows: task.successRows,
      failed_rows: task.failedRows,
      total_batches: task.totalBatches,
      completed_batches: task.completedBatches,
      trace_id: task.traceId,
      degraded: task.degraded,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to load import task", 500);
  }
}
