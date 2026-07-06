import { createImportBatch } from "@/lib/server/shipments";
import { jsonError, jsonOk } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      fileName?: string;
      sheetName?: string;
      templateFingerprint?: string;
      totalCount?: number;
    };

    const fileName = String(body.fileName || "").trim();
    const sheetName = String(body.sheetName || "").trim();
    const templateFingerprint = String(body.templateFingerprint || "").trim();
    const totalCount = Number(body.totalCount ?? 0);

    if (!fileName || !sheetName || !templateFingerprint || totalCount < 0) {
      return jsonError("Invalid batch payload");
    }

    const batch = await createImportBatch(fileName, sheetName, templateFingerprint, totalCount);
    return jsonOk({ batch }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to create import batch", 500);
  }
}

