import type { ParsedWorkbookSource } from "@/lib/types";
import { generateParseRule } from "@/lib/server/ai-rules";
import { jsonError, jsonOk } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { source?: ParsedWorkbookSource };
    if (!body.source?.fileName || !body.source.fileKind) {
      return jsonError("source is required");
    }

    const result = await generateParseRule(body.source);
    return jsonOk(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to generate parse rule", 500);
  }
}
