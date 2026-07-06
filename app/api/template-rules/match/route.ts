import { getTemplateRule } from "@/lib/server/template-rules";
import { jsonError, jsonOk } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { fingerprint?: string };
    const fingerprint = String(body.fingerprint || "").trim();
    if (!fingerprint) {
      return jsonError("fingerprint is required");
    }

    const rule = await getTemplateRule(fingerprint);
    return jsonOk({ rule });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to load template rule", 500);
  }
}

