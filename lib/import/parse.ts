import type {
  CellSelector,
  FileKind,
  ImportField,
  ImportRow,
  MatrixExcelRule,
  ParsedWorkbookSource,
  ParseRule,
  TabularExcelRule,
  TextParseRule,
  WorkbookTemplateMatch,
} from "@/lib/types";
import { EMPTY_IMPORT_VALUES, IMPORT_FIELDS } from "@/lib/import/constants";
import { detectTemplateFromSheet } from "@/lib/import/detection";
import { normalizeText } from "@/lib/import/normalize";
import { validateRows } from "@/lib/import/validation";

export interface ParsedWorkbookResult {
  sheets: string[];
  match: WorkbookTemplateMatch | null;
  rawHeaders: string[];
  sourceRows: string[][];
  dataRows: string[][];
}

function cellToString(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function makeRowId(prefix: string, index: number) {
  return `${prefix}:${index}:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function getExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

function getFileKind(fileName: string): FileKind {
  const extension = getExtension(fileName);
  if (extension === "xlsx" || extension === "xls") return "excel";
  if (extension === "docx") return "word";
  if (extension === "pdf") return "pdf";
  return "text";
}

function rowHasText(row: string[]) {
  return row.some((cell) => normalizeText(cell).length > 0);
}

function rowContains(row: string[], patterns: string[] = []) {
  if (!patterns.length) return false;
  const text = normalizeText(row.join(" "));
  return patterns.some((pattern) => text.includes(normalizeText(pattern)));
}

function normalizeRows(rows: unknown[][]) {
  return rows.map((row) => row.map((cell) => cellToString(cell)));
}

function buildSampleText(source: ParsedWorkbookSource) {
  return source.sheets
    .map((sheet) => {
      const lines = sheet.rows.slice(0, 20).map((row, index) => `${index + 1}: ${row.join(" | ")}`);
      return `Sheet: ${sheet.name}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

export async function readImportFile(file: File): Promise<ParsedWorkbookSource> {
  const fileKind = getFileKind(file.name);

  if (fileKind !== "excel") {
    return {
      fileName: file.name,
      fileKind,
      sheets: [],
      textContent: "",
      sampleText: `${file.name} 是 ${fileKind.toUpperCase()} 文件。请通过服务端文本提取适配器读取内容。`,
    };
  }

  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheets = workbook.SheetNames.map((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: "", raw: false }) as unknown[][];
    return {
      name: sheetName,
      rows: normalizeRows(rows).filter(rowHasText),
    };
  });

  const source: ParsedWorkbookSource = {
    fileName: file.name,
    fileKind,
    sheets,
    sampleText: "",
  };
  source.sampleText = buildSampleText(source);
  return source;
}

function selectSheets(source: ParsedWorkbookSource, rule: TabularExcelRule | MatrixExcelRule) {
  if (source.fileKind !== "excel") {
    throw new Error("当前规则只支持 Excel 文件");
  }

  if (rule.sheetMode.type === "all") return source.sheets;
  if (rule.sheetMode.type === "named") {
    const names = new Set(rule.sheetMode.names);
    return source.sheets.filter((sheet) => names.has(sheet.name));
  }
  return source.sheets.slice(0, 1);
}

function buildFooterMap(rows: string[][], pairs: TabularExcelRule["footerPairs"] = []) {
  const footerMap = new Map<ImportField, string>();
  if (!pairs.length) return footerMap;

  for (const pair of pairs) {
    const normalizedLabel = normalizeText(pair.label);
    const valueOffset = pair.valueOffset ?? 1;
    for (const row of rows) {
      const labelIndex = row.findIndex((cell) => normalizeText(cell) === normalizedLabel);
      if (labelIndex >= 0) {
        footerMap.set(pair.field, cellToString(row[labelIndex + valueOffset]));
        break;
      }
    }
  }

  return footerMap;
}

function readSelector(
  selector: CellSelector | undefined,
  context: {
    row: string[];
    sheetName: string;
    footerMap: Map<ImportField, string>;
    matrixColumnHeader?: string;
  }
) {
  if (!selector) return "";
  if (selector.type === "column") return cellToString(context.row[selector.index]);
  if (selector.type === "columns") {
    return selector.indices
      .map((index) => cellToString(context.row[index]))
      .filter(Boolean)
      .join(selector.separator ?? " ")
      .trim();
  }
  if (selector.type === "static") return selector.value;
  if (selector.type === "sheetName") return context.sheetName;
  if (selector.type === "matrixColumnHeader") return context.matrixColumnHeader ?? "";
  if (selector.type === "footerPair") {
    const pair = Array.from(context.footerMap.entries()).find(([, value]) => value && selector.label);
    return pair?.[1] ?? "";
  }
  return "";
}

function applyExternalCodeTemplate(template: string | undefined, values: Record<ImportField, string>, context: { sheetName: string; matrixColumnHeader: string; rowNumber: number }) {
  if (!template) return values.externalCode;
  return template
    .replaceAll("${sheetName}", context.sheetName)
    .replaceAll("${columnHeader}", context.matrixColumnHeader)
    .replaceAll("${rowNumber}", String(context.rowNumber))
    .replaceAll("${storeName}", values.storeName)
    .replaceAll("${skuCode}", values.skuCode);
}

function shouldStopAtRow(row: string[], rule: TabularExcelRule) {
  const firstCell = normalizeText(row[0] || "");
  return Boolean(rule.stopWhenFirstColumnMatches?.some((pattern) => firstCell === normalizeText(pattern)));
}

function parseTabularRule(source: ParsedWorkbookSource, rule: TabularExcelRule, onProgress?: (current: number, total: number) => void) {
  const sheets = selectSheets(source, rule);
  const rows: ImportRow[] = [];
  const total = sheets.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - rule.dataStartRowIndex), 0);
  let current = 0;

  for (const sheet of sheets) {
    const footerMap = buildFooterMap(sheet.rows, rule.footerPairs);
    for (let rowIndex = rule.dataStartRowIndex; rowIndex < sheet.rows.length; rowIndex += 1) {
      const sourceRow = sheet.rows[rowIndex];
      current += 1;
      if (!rowHasText(sourceRow)) continue;
      if (shouldStopAtRow(sourceRow, rule)) break;
      if (rowContains(sourceRow, rule.skipRowsContaining)) continue;

      const values = { ...EMPTY_IMPORT_VALUES };
      for (const field of IMPORT_FIELDS) {
        values[field] = readSelector(rule.fieldMapping[field], {
          row: sourceRow,
          sheetName: sheet.name,
          footerMap,
        });
      }
      for (const [field, value] of footerMap.entries()) {
        if (!values[field] && value) values[field] = value;
      }

      rows.push({
        id: makeRowId(rule.name, rows.length + 1),
        sourceRowNumber: rowIndex + 1,
        sourceSheetName: sheet.name,
        values,
        issues: [],
      });

      if (onProgress && (rows.length % 40 === 0 || current === total)) {
        onProgress(current, total);
      }
    }
  }

  return validateRows(rows);
}

function parseMatrixRule(source: ParsedWorkbookSource, rule: MatrixExcelRule, onProgress?: (current: number, total: number) => void) {
  const sheets = selectSheets(source, rule);
  const rows: ImportRow[] = [];
  const total = sheets.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - rule.dataStartRowIndex), 0);
  let current = 0;

  for (const sheet of sheets) {
    const header = sheet.rows[rule.headerRowIndex] ?? [];
    const lastColumnIndex = rule.matrix.lastColumnIndex ?? header.length - 1;
    const footerMap = new Map<ImportField, string>();

    for (let rowIndex = rule.dataStartRowIndex; rowIndex < sheet.rows.length; rowIndex += 1) {
      const sourceRow = sheet.rows[rowIndex];
      current += 1;
      if (!rowHasText(sourceRow) || rowContains(sourceRow, rule.skipRowsContaining)) continue;

      for (let columnIndex = rule.matrix.firstColumnIndex; columnIndex <= lastColumnIndex; columnIndex += 1) {
        const quantity = cellToString(sourceRow[columnIndex]);
        if (!quantity || Number(quantity) <= 0) continue;

        const matrixColumnHeader = cellToString(header[columnIndex]);
        const values = { ...EMPTY_IMPORT_VALUES, skuQuantity: quantity };
        for (const field of IMPORT_FIELDS) {
          const mappedValue = readSelector(rule.itemMapping[field], {
            row: sourceRow,
            sheetName: sheet.name,
            footerMap,
            matrixColumnHeader,
          });
          if (mappedValue) values[field] = mappedValue;
        }

        values[rule.matrix.quantityField] = quantity;
        values[rule.matrix.columnHeaderField] = matrixColumnHeader;
        values.externalCode = applyExternalCodeTemplate(rule.matrix.externalCodeTemplate, values, {
          sheetName: sheet.name,
          matrixColumnHeader,
          rowNumber: rowIndex + 1,
        });

        rows.push({
          id: makeRowId(rule.name, rows.length + 1),
          sourceRowNumber: rowIndex + 1,
          sourceSheetName: sheet.name,
          values,
          issues: [],
        });
      }

      if (onProgress && (rows.length % 40 === 0 || current === total)) {
        onProgress(current, total);
      }
    }
  }

  return validateRows(rows);
}

function compilePattern(pattern: string, flags = "ims") {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`规则正则无效：${pattern}`);
  }
}

function extractPatternValue(text: string, pattern: string | undefined) {
  if (!pattern) return "";
  const match = text.match(compilePattern(pattern));
  return String(match?.[1] ?? match?.[0] ?? "").trim();
}

function splitTextBlocks(text: string, separatorPattern: string) {
  const separator = compilePattern(separatorPattern, "gim");
  const starts = Array.from(text.matchAll(separator), (match) => match.index ?? 0).filter((index, order, all) => order === 0 || index !== all[order - 1]);

  if (!starts.length) return [text].filter((block) => block.trim());
  const blocks: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? text.length;
    const block = text.slice(start, end).trim();
    if (block) blocks.push(block);
  }
  return blocks.length ? blocks : [text].filter((block) => block.trim());
}

function parseTextBlockRule(source: ParsedWorkbookSource, rule: TextParseRule, onProgress?: (current: number, total: number) => void) {
  const text = source.textContent || source.sampleText || "";
  if (!text.trim()) {
    throw new Error("未提取到可解析的文本内容");
  }

  const blocks = splitTextBlocks(text, rule.blockSeparatorPattern);
  const rows: ImportRow[] = [];
  const itemLineRegex = compilePattern(rule.itemLinePattern, "gim");
  const itemGroups: Partial<Record<ImportField, number>> = rule.itemFieldGroups || {
    skuCode: 1,
    skuName: 2,
    skuSpec: 3,
    skuQuantity: 4,
  };

  blocks.forEach((block, blockIndex) => {
    const baseValues = { ...EMPTY_IMPORT_VALUES, ...(rule.defaultValues || {}) };
    for (const field of IMPORT_FIELDS) {
      const extracted = extractPatternValue(block, rule.fieldPatterns[field]);
      if (extracted) baseValues[field] = extracted;
    }

    const itemMatches = Array.from(block.matchAll(itemLineRegex));
    if (!itemMatches.length) {
      rows.push({
        id: makeRowId(rule.name, rows.length + 1),
        sourceRowNumber: blockIndex + 1,
        sourceSheetName: source.fileKind.toUpperCase(),
        values: baseValues,
        issues: [],
      });
      onProgress?.(blockIndex + 1, blocks.length);
      return;
    }

    for (const match of itemMatches) {
      const values = { ...baseValues };
      for (const [field, groupIndex] of Object.entries(itemGroups) as Array<[ImportField, number]>) {
        const value = String(match[groupIndex] ?? "").trim();
        if (value) values[field] = value;
      }

      rows.push({
        id: makeRowId(rule.name, rows.length + 1),
        sourceRowNumber: blockIndex + 1,
        sourceSheetName: source.fileKind.toUpperCase(),
        values,
        issues: [],
      });
    }
    onProgress?.(blockIndex + 1, blocks.length);
  });

  return validateRows(rows);
}

export async function executeParseRule(
  source: ParsedWorkbookSource,
  rule: ParseRule,
  onProgress?: (current: number, total: number) => void
) {
  if (rule.kind === "tabular") return parseTabularRule(source, rule, onProgress);
  if (rule.kind === "matrix") return parseMatrixRule(source, rule, onProgress);
  if (rule.kind === "textBlocks") return parseTextBlockRule(source, rule, onProgress);
  throw new Error("不支持的解析规则类型");
}

function getFieldValue(row: string[], indices: number[] | undefined) {
  if (!indices?.length) return "";
  return indices
    .map((index) => cellToString(row[index]))
    .filter(Boolean)
    .join(" ")
    .trim();
}

export async function parseWorkbookFile(file: File) {
  const source = await readImportFile(file);
  const sheets = source.sheets.map((sheet) => sheet.name);

  let match: WorkbookTemplateMatch | null = null;
  let sourceRows: string[][] = [];

  for (const sheet of source.sheets) {
    const candidate = detectTemplateFromSheet(sheet.name, sheet.rows);
    if (candidate && (!match || candidate.confidence > match.confidence)) {
      match = candidate;
      sourceRows = sheet.rows;
    }
  }

  if (!match) {
    return { sheets, match: null, rawHeaders: [], sourceRows: [], dataRows: [] };
  }

  const headers = sourceRows[match.headerRowIndex] ?? [];
  const dataRows = sourceRows.slice(match.headerRowIndex + 1);

  return {
    sheets,
    match,
    rawHeaders: headers,
    sourceRows,
    dataRows,
  };
}

export function materializeRows(match: WorkbookTemplateMatch, dataRows: string[][]): ImportRow[] {
  const parsedRows: ImportRow[] = dataRows
    .filter(rowHasText)
    .map((row, idx) => {
      const values = Object.fromEntries(
        IMPORT_FIELDS.map((field) => [field, getFieldValue(row, match.mapping[field])])
      ) as Record<ImportField, string>;

      return {
        id: `${match.fingerprint}:${idx + 1}`,
        sourceRowNumber: match.headerRowIndex + idx + 2,
        values,
        issues: [],
      };
    });

  return validateRows(parsedRows);
}

export async function materializeRowsWithProgress(
  match: WorkbookTemplateMatch,
  dataRows: string[][],
  onProgress?: (current: number, total: number) => void
) {
  const filteredRows = dataRows.filter(rowHasText);
  const partialRows: ImportRow[] = [];
  const total = filteredRows.length;

  for (let index = 0; index < filteredRows.length; index += 1) {
    const row = filteredRows[index];
    const values = Object.fromEntries(
      IMPORT_FIELDS.map((field) => [field, getFieldValue(row, match.mapping[field])])
    ) as Record<ImportField, string>;

    partialRows.push({
      id: `${match.fingerprint}:${index + 1}`,
      sourceRowNumber: match.headerRowIndex + index + 2,
      values,
      issues: [],
    });

    if (onProgress && ((index + 1) % 40 === 0 || index === filteredRows.length - 1)) {
      onProgress(index + 1, total);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
  }

  return validateRows(partialRows);
}
