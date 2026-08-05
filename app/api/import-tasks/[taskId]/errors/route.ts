import { listTaskErrors } from "@/lib/server/import-tasks";
import { jsonError, jsonOk } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await context.params;
    if (!taskId) return jsonError("taskId is required");

    const url = new URL(request.url);
    const batch = Number(url.searchParams.get("batch") || 0);
    const errorCode = String(url.searchParams.get("error_code") || "").trim();
    const page = Number(url.searchParams.get("page") || 1);
    const pageSize = Number(url.searchParams.get("page_size") || 50);

    const result = await listTaskErrors({
      taskId,
      batch: batch > 0 ? batch : undefined,
      errorCode: errorCode || undefined,
      page,
      pageSize,
    });

    return jsonOk(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to load task errors", 500);
  }
}
