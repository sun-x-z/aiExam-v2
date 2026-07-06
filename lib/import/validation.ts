import type { ImportField, ImportRow, ValidationIssue } from "@/lib/types";
import { REQUIRED_SKU_FIELDS } from "@/lib/import/constants";

const PHONE_PATTERN = /^[0-9+\-()\s]{6,20}$/;

function pushIssue(issues: ValidationIssue[], rowNumber: number, field: ImportField | "global", code: string, message: string) {
  issues.push({ rowNumber, field, code, message });
}

function hasText(value: unknown) {
  return String(value ?? "").trim().length > 0;
}

function lineKey(row: ImportRow) {
  const externalCode = String(row.values.externalCode || "").trim();
  const skuCode = String(row.values.skuCode || "").trim();
  return externalCode && skuCode ? `${externalCode}::${skuCode}` : "";
}

export function validateImportRow(row: ImportRow, rowIndexMap: Map<string, number>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const rowNumber = row.sourceRowNumber;

  for (const field of REQUIRED_SKU_FIELDS) {
    if (!hasText(row.values[field])) {
      pushIssue(issues, rowNumber, field, "required", `${field} 不能为空`);
    }
  }

  const hasStoreMode = hasText(row.values.storeName);
  const hasRecipientMode =
    hasText(row.values.recipientName) &&
    hasText(row.values.recipientPhone) &&
    hasText(row.values.recipientAddress);

  if (!hasStoreMode && !hasRecipientMode) {
    pushIssue(issues, rowNumber, "global", "receiver_required", "收货门店，或收件人姓名/电话/地址，至少填写一组");
  }

  const recipientPhone = String(row.values.recipientPhone || "").trim();
  if (recipientPhone && !PHONE_PATTERN.test(recipientPhone)) {
    pushIssue(issues, rowNumber, "recipientPhone", "phone_format", "收件人电话格式错误");
  }

  const quantity = Number(row.values.skuQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    pushIssue(issues, rowNumber, "skuQuantity", "sku_quantity_positive", "SKU发货数量必须为正数");
  }

  const duplicatedKey = lineKey(row);
  if (duplicatedKey) {
    const duplicatedRow = rowIndexMap.get(duplicatedKey);
    if (duplicatedRow && duplicatedRow !== rowNumber) {
      pushIssue(issues, rowNumber, "global", "external_sku_duplicate_batch", `同批次中与第 ${duplicatedRow} 行外部编码 + SKU 重复`);
    }
  }

  return issues;
}

export function validateRows(rows: ImportRow[]) {
  const batchRows = new Map<string, number>();
  rows.forEach((row) => {
    const key = lineKey(row);
    if (key && !batchRows.has(key)) {
      batchRows.set(key, row.sourceRowNumber);
    }
  });

  return rows.map((row) => {
    const issues = validateImportRow(row, batchRows);
    return { ...row, issues };
  });
}
