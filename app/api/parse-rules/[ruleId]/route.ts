import { jsonError, jsonOk } from "@/lib/server/http";
import { deleteParseRule } from "@/lib/server/template-rules";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ ruleId: string }> }
) {
  try {
    const { ruleId } = await context.params;
    if (!ruleId) return jsonError("ruleId is required");
    await deleteParseRule(ruleId);
    return jsonOk({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to delete parse rule", 500);
  }
}
