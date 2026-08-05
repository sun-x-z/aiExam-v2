import path from "path";
import * as XLSX from "xlsx";

const baseUrl = process.env.IMPORT_BASE_URL || "http://127.0.0.1:3001";
const workbookPath = process.env.IMPORT_TEST_FILE || path.join(process.cwd(), "test-data", "10000-orders.xlsx");
const workerLimit = Number(process.env.IMPORT_WORKER_BATCH_LIMIT || 2);
const batchSize = Number(process.env.IMPORT_BATCH_SIZE || 1000);
const timeoutMs = Number(process.env.IMPORT_LOADTEST_TIMEOUT_MS || 180000);

const headers = [
  "externalCode",
  "storeName",
  "recipientName",
  "recipientPhone",
  "recipientAddress",
  "skuCode",
  "skuName",
  "skuQuantity",
  "skuSpec",
  "note",
];

function readRows() {
  const workbook = XLSX.readFile(workbookPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  return matrix.slice(1).filter((row) => row.some(Boolean)).map((row, index) => ({
    id: `loadtest:${index + 1}`,
    sourceRowNumber: index + 2,
    sourceSheetName: sheetName,
    values: Object.fromEntries(headers.map((field, columnIndex) => [field, String(row[columnIndex] || "")])),
    issues: [],
  }));
}

async function requestJson(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

async function main() {
  const rows = readRows();
  const uploadStart = Date.now();
  const created = await requestJson(`${baseUrl}/api/import-tasks`, {
    method: "POST",
    body: JSON.stringify({
      fileName: path.basename(workbookPath),
      sheetName: "orders",
      rows,
      batchSize,
      duplicatePolicy: "allow_new_task",
    }),
  });
  const uploadMs = Date.now() - uploadStart;
  const taskId = created.task_id;
  const startedAt = Date.now();
  let lastTask = null;
  let httpErrors = 0;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await requestJson(`${baseUrl}/api/import-worker/tick`, {
        method: "POST",
        body: JSON.stringify({ workerLimit, dispatchLimit: 50 }),
      });
    } catch (error) {
      httpErrors += 1;
      console.error(`worker tick failed: ${error.message}`);
    }

    lastTask = await requestJson(`${baseUrl}/api/import-tasks/${taskId}`);
    const status = lastTask.status;
    process.stdout.write(`\r${status} ${lastTask.processed_rows}/${lastTask.total_rows} ok=${lastTask.success_rows} fail=${lastTask.failed_rows}`);
    if (["COMPLETED", "PARTIAL_SUCCESS", "FAILED"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const totalMs = Date.now() - startedAt;
  const pass = Boolean(lastTask && ["COMPLETED", "PARTIAL_SUCCESS"].includes(lastTask.status) && totalMs <= 60000 && httpErrors === 0);
  console.log("");
  console.log(JSON.stringify({
    taskId,
    traceId: created.trace_id,
    rows: rows.length,
    uploadMs,
    totalMs,
    workerLimit,
    batchSize,
    successRows: lastTask?.success_rows ?? 0,
    failedRows: lastTask?.failed_rows ?? 0,
    httpErrors,
    pass60s: pass,
  }, null, 2));

  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
