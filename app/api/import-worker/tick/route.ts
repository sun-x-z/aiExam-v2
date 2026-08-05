import { dispatchOutbox, processQueuedBatches } from "@/lib/server/import-tasks";
import { jsonError, jsonOk } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { dispatchLimit?: number; workerLimit?: number };
    const dispatched = await dispatchOutbox(Number(body.dispatchLimit || 20));
    const processed = await processQueuedBatches(Number(body.workerLimit || 2));
    return jsonOk({ dispatched, processed });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to run import worker", 500);
  }
}
