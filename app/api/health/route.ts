import { bootstrapDatabase } from "@/lib/server/db";
import { jsonError, jsonOk } from "@/lib/server/http";

export async function GET() {
  try {
    await bootstrapDatabase();
    return jsonOk({ ok: true, timestamp: new Date().toISOString() });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Health check failed", 500);
  }
}

