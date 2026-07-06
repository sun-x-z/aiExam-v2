import { getDuplicateExternalCodes } from "@/lib/server/shipments";
import { jsonError, jsonOk } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { codes?: string[] };
    const codes = Array.isArray(body.codes) ? body.codes.map((item) => String(item || "")) : [];
    const duplicates = await getDuplicateExternalCodes(codes);

    return jsonOk({
      duplicates: Object.fromEntries(duplicates.entries()),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to check duplicates", 500);
  }
}

