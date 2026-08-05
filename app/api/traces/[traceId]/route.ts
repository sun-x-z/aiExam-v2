import { getTraceEvents } from "@/lib/server/import-tasks";
import { jsonError, jsonOk } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ traceId: string }> }
) {
  try {
    const { traceId } = await context.params;
    if (!traceId) return jsonError("traceId is required");

    const events = await getTraceEvents(traceId);
    return jsonOk({ events });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to load trace events", 500);
  }
}
