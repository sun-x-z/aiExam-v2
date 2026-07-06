import type { ParseRule } from "@/lib/types";
import { jsonError, jsonOk } from "@/lib/server/http";
import { listParseRules, saveParseRule } from "@/lib/server/template-rules";

export async function GET() {
  try {
    const rules = await listParseRules();
    return jsonOk({ rules });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to load parse rules", 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { id?: string; rule?: ParseRule };
    if (!body.rule?.name || !body.rule.kind || !body.rule.fileKind) {
      return jsonError("Invalid parse rule payload");
    }

    const saved = await saveParseRule(body.rule, body.id);
    return jsonOk({ rule: saved }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to save parse rule", 500);
  }
}
