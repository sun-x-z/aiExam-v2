import { jsonError, jsonOk } from "@/lib/server/http";
import { getLocalV2WaybillList, isAuthorizedV2Request } from "@/lib/server/local-v2-adapter";

export async function GET(request: Request) {
  if (!isAuthorizedV2Request(request)) return jsonError("Unauthorized", 401);
  const { searchParams } = new URL(request.url);
  const items = await getLocalV2WaybillList({
    q: searchParams.get("q") || "",
    limit: Number(searchParams.get("limit") || "20"),
  });
  return jsonOk({ items });
}
