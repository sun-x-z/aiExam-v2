import type { ImportField, WorkbookTemplateMatch } from "@/lib/types";
import { FIELD_ALIASES, REQUIRED_SKU_FIELDS } from "@/lib/import/constants";
import { fingerprintHeaders, normalizeText } from "@/lib/import/normalize";

function scoreCellForField(cell: string, field: ImportField) {
  const normalized = normalizeText(cell);
  if (!normalized) return 0;

  const aliases = FIELD_ALIASES[field];
  for (const alias of aliases) {
    const normalizedAlias = normalizeText(alias);
    if (!normalizedAlias) continue;
    if (normalized === normalizedAlias) return 10;
    if (normalized.includes(normalizedAlias) || normalizedAlias.includes(normalized)) return 8;
  }
  return 0;
}

function scoreHeaderRow(header: string[]) {
  const mapping: Partial<Record<ImportField, number[]>> = {};
  let score = 0;
  const matchedColumns = new Set<number>();

  header.forEach((cell, index) => {
    for (const field of Object.keys(FIELD_ALIASES) as ImportField[]) {
      const cellScore = scoreCellForField(cell, field);
      if (cellScore > 0) {
        mapping[field] = [index];
        score += cellScore;
        matchedColumns.add(index);
        break;
      }
    }
  });

  const requiredHits = REQUIRED_SKU_FIELDS.filter((field) => mapping[field]?.length).length;
  score += requiredHits * 4 + matchedColumns.size * 2;
  return { score, mapping, requiredHits, distinctMatchedColumns: matchedColumns.size };
}

export function detectTemplateFromSheet(sheetName: string, rows: string[][]): WorkbookTemplateMatch | null {
  let best: WorkbookTemplateMatch | null = null;

  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 15); rowIndex += 1) {
    const header = rows[rowIndex] || [];
    const { score, mapping, requiredHits, distinctMatchedColumns } = scoreHeaderRow(header);
    if (requiredHits < 2 || distinctMatchedColumns < 3) continue;

    const candidate: WorkbookTemplateMatch = {
      sheetName,
      headerRowIndex: rowIndex,
      headerNames: header,
      mapping,
      fingerprint: `${sheetName}::${fingerprintHeaders(header)}`,
      confidence: score,
    };

    if (!best || candidate.confidence > best.confidence) {
      best = candidate;
    }
  }

  return best;
}
