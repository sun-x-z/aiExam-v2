import type { TemplateMapping } from "@/lib/types";
import { jsonError, jsonOk } from "@/lib/server/http";
import { saveTemplateRule } from "@/lib/server/template-rules";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      fingerprint?: string;
      sheetName?: string;
      headerRowIndex?: number;
      headerNames?: string[];
      columnMapping?: TemplateMapping["columnMapping"];
      confidence?: number;
    };

    const rule: TemplateMapping = {
      fingerprint: String(body.fingerprint || "").trim(),
      sheetName: String(body.sheetName || "").trim(),
      headerRowIndex: Number(body.headerRowIndex ?? 0),
      headerNames: Array.isArray(body.headerNames) ? body.headerNames.map((item) => String(item || "")) : [],
      columnMapping: body.columnMapping || {},
    };

    if (!rule.fingerprint || !rule.sheetName || !rule.headerNames.length) {
      return jsonError("incomplete template rule payload");
    }

    await saveTemplateRule(rule, Number(body.confidence ?? 0));
    return jsonOk({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to save template rule", 500);
  }
}

