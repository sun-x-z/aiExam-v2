import fs from "fs";
import path from "path";
import pg from "pg";
import * as XLSX from "xlsx";

const { Client } = pg;

const root = process.cwd();
const outputDir = path.join(root, "test-data");
const workbookPath = path.join(outputDir, "10000-orders.xlsx");
const skuCount = Number(process.env.SEED_SKU_COUNT || 20000);
const orderCount = Number(process.env.SEED_ORDER_COUNT || 10000);

function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.NEON_POSTGRES_URL ||
    ""
  ).trim();
}

function buildSkuRows() {
  return Array.from({ length: skuCount }, (_, index) => {
    const no = String(index + 1).padStart(5, "0");
    return {
      skuCode: `SKU_${no}`,
      name: `压测商品 ${no}`,
      spec: `${(index % 12) + 1}kg/箱`,
      unit: "箱",
    };
  });
}

function buildOrderRows() {
  const rows = [
    ["外部单号", "门店", "收件人", "电话", "地址", "SKU编码", "SKU名称", "数量", "规格", "备注"],
  ];

  for (let index = 0; index < orderCount; index += 1) {
    const orderNo = String(index + 1).padStart(5, "0");
    const skuIndex = (index % skuCount) + 1;
    const skuCode = index > 0 && index % 197 === 0 ? `BAD_SKU_${orderNo}` : `SKU_${String(skuIndex).padStart(5, "0")}`;
    rows.push([
      `EXT_${orderNo}`,
      `门店${(index % 300) + 1}`,
      `收件人${(index % 500) + 1}`,
      `138${String(10000000 + (index % 89999999)).slice(0, 8)}`,
      `上海市青浦区华新镇压测路${(index % 999) + 1}号`,
      skuCode,
      `压测商品 ${String(skuIndex).padStart(5, "0")}`,
      String((index % 8) + 1),
      `${(index % 12) + 1}kg/箱`,
      index % 197 === 0 && index > 0 ? "故意插入非法 SKU" : "",
    ]);
  }

  return rows;
}

function writeWorkbook() {
  fs.mkdirSync(outputDir, { recursive: true });
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(buildOrderRows());
  XLSX.utils.book_append_sheet(workbook, sheet, "orders");
  XLSX.writeFile(workbook, workbookPath);
  console.log(`generated ${workbookPath}`);
}

async function seedSkuMaster(databaseUrl) {
  const client = new Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const schema = fs.readFileSync(path.join(root, "database", "schema.sql"), "utf8");
    await client.query(schema);
    await client.query("DELETE FROM public.sku_master WHERE sku_code LIKE 'SKU_%'");

    const rows = buildSkuRows();
    const chunkSize = 1000;
    for (let index = 0; index < rows.length; index += chunkSize) {
      const chunk = rows.slice(index, index + chunkSize);
      await client.query(
        `INSERT INTO public.sku_master (sku_code, name, spec, unit, active, updated_at)
         SELECT item->>'skuCode', item->>'name', item->>'spec', item->>'unit', TRUE, NOW()
         FROM jsonb_array_elements($1::jsonb) AS source(item)
         ON CONFLICT (sku_code) DO UPDATE SET
           name = EXCLUDED.name,
           spec = EXCLUDED.spec,
           unit = EXCLUDED.unit,
           active = TRUE,
           updated_at = NOW()`,
        [JSON.stringify(chunk)]
      );
    }
    console.log(`seeded ${rows.length} sku_master rows`);
  } finally {
    await client.end();
  }
}

writeWorkbook();

const databaseUrl = getDatabaseUrl();
if (databaseUrl) {
  await seedSkuMaster(databaseUrl);
} else {
  console.log("database url is not configured, skipped sku_master seeding");
}
