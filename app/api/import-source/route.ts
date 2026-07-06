import { extractDocumentSource } from "@/lib/server/document-extract";
import { jsonError, jsonOk } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return jsonError("file is required");
    }

    const source = await extractDocumentSource(file);
    return jsonOk({ source });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to extract import source", 500);
  }
}
