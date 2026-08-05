import { getImportMonitorSummary } from "@/lib/server/import-tasks";
import { jsonError, jsonOk } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const summary = await getImportMonitorSummary();
    return jsonOk(summary);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to load import monitor summary", 500);
  }
}
