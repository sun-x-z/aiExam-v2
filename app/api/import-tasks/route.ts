import type { ImportRow, ParseRule } from "@/lib/types";
import { executeParseRule, readImportFile } from "@/lib/import/parse";
import { extractDocumentSource } from "@/lib/server/document-extract";
import { createImportTask, listImportTasks } from "@/lib/server/import-tasks";
import { jsonError, jsonOk } from "@/lib/server/http";
import { getParseRuleById } from "@/lib/server/template-rules";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") || 20);
    const tasks = await listImportTasks(limit);
    return jsonOk({ tasks });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to list import tasks", 500);
  }
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    const body = contentType.includes("multipart/form-data")
      ? await readMultipartPayload(request)
      : ((await request.json()) as {
          fileName?: string;
          sheetName?: string;
          ruleId?: string;
          rule?: ParseRule;
          rows?: ImportRow[];
          batchSize?: number;
          duplicatePolicy?: string;
        });

    const fileName = String(body.fileName || "").trim();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!fileName || !rows.length) {
      return jsonError("fileName and rows are required");
    }

    const task = await createImportTask({
      fileName,
      sheetName: body.sheetName,
      ruleId: body.ruleId,
      rule: body.rule,
      rows,
      batchSize: body.batchSize,
      duplicatePolicy: body.duplicatePolicy,
    });

    return jsonOk(
      {
        task,
        task_id: task.taskId,
        trace_id: task.traceId,
        status: task.status.toUpperCase(),
        total_rows: task.totalRows,
        total_batches: task.totalBatches,
      },
      { status: 202 }
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to create import task", 500);
  }
}

async function readMultipartPayload(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("file is required");
  }

  const ruleId = String(formData.get("ruleId") || "").trim();
  const ruleJson = String(formData.get("rule") || "").trim();
  const batchSize = Number(formData.get("batchSize") || 1000);
  const duplicatePolicy = String(formData.get("duplicatePolicy") || "allow_new_task");
  const rule = ruleJson ? (JSON.parse(ruleJson) as ParseRule) : (ruleId ? (await getParseRuleById(ruleId))?.rule : null);
  if (!rule) {
    throw new Error("ruleId or rule is required");
  }

  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const source = extension === "docx" || extension === "pdf" || extension === "txt"
    ? await extractDocumentSource(file)
    : await readImportFile(file);
  const rows = await executeParseRule(source, rule);

  return {
    fileName: file.name,
    sheetName: source.sheets.map((sheet) => sheet.name).join(", ") || source.fileKind,
    ruleId,
    rule,
    rows,
    batchSize,
    duplicatePolicy,
  };
}
