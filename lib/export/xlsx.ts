import type { ImportRow } from "@/lib/types";

export async function exportRowsToWorkbook(rows: ImportRow[], fileName = "import-preview.xlsx") {
  const XLSX = await import("xlsx");
  const data = rows.map((row) => ({
    外部编码: row.values.externalCode,
    收货门店: row.values.storeName,
    收件人姓名: row.values.recipientName,
    收件人电话: row.values.recipientPhone,
    收件人地址: row.values.recipientAddress,
    SKU物品编码: row.values.skuCode,
    SKU物品名称: row.values.skuName,
    SKU发货数量: row.values.skuQuantity,
    SKU规格型号: row.values.skuSpec,
    备注: row.values.note,
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "预览数据");
  XLSX.writeFile(workbook, fileName);
}
