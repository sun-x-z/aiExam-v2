import { dispatchOutbox } from "@/lib/server/import-tasks";
import { jsonError, jsonOk } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { limit?: number };
    const result = await dispatchOutbox(Number(body.limit || 20));
    return jsonOk(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to dispatch outbox", 500);
  }
}
