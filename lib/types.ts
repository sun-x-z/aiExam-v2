export type ImportField =
  | "externalCode"
  | "storeName"
  | "recipientName"
  | "recipientPhone"
  | "recipientAddress"
  | "skuCode"
  | "skuName"
  | "skuQuantity"
  | "skuSpec"
  | "note";

export const IMPORT_FIELDS: ImportField[] = [
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

export interface ImportRow {
  id: string;
  sourceRowNumber: number;
  sourceSheetName?: string;
  values: Record<ImportField, string>;
  issues: ValidationIssue[];
  duplicateWithRow?: number;
  duplicateInDb?: boolean;
}

export interface ValidationIssue {
  rowNumber: number;
  field: ImportField | "global";
  message: string;
  code: string;
}

export type FileKind = "excel" | "word" | "pdf" | "text";

export type SheetMode =
  | { type: "first" }
  | { type: "all" }
  | { type: "named"; names: string[] };

export type CellSelector =
  | { type: "column"; index: number }
  | { type: "columns"; indices: number[]; separator?: string }
  | { type: "static"; value: string }
  | { type: "sheetName" }
  | { type: "matrixColumnHeader" }
  | { type: "footerPair"; label: string };

export interface BaseParseRule {
  id?: string;
  name: string;
  description?: string;
  fileKind: FileKind;
  confidence?: number;
  aiGenerated?: boolean;
  aiNotes?: string[];
}

export interface TabularExcelRule extends BaseParseRule {
  kind: "tabular";
  fileKind: "excel";
  sheetMode: SheetMode;
  headerRowIndex: number;
  dataStartRowIndex: number;
  stopWhenFirstColumnMatches?: string[];
  skipRowsContaining?: string[];
  fieldMapping: Partial<Record<ImportField, CellSelector>>;
  footerPairs?: Array<{ label: string; valueOffset?: number; field: ImportField }>;
}

export interface MatrixExcelRule extends BaseParseRule {
  kind: "matrix";
  fileKind: "excel";
  sheetMode: SheetMode;
  headerRowIndex: number;
  dataStartRowIndex: number;
  itemMapping: Partial<Record<ImportField, CellSelector>>;
  matrix: {
    firstColumnIndex: number;
    lastColumnIndex?: number;
    quantityField: Extract<ImportField, "skuQuantity">;
    columnHeaderField: Extract<ImportField, "storeName" | "externalCode" | "note">;
    externalCodeTemplate?: string;
  };
  skipRowsContaining?: string[];
}

export interface TextParseRule extends BaseParseRule {
  kind: "textBlocks";
  fileKind: "word" | "pdf" | "text";
  blockSeparatorPattern: string;
  itemLinePattern: string;
  itemFieldGroups?: Partial<Record<ImportField, number>>;
  fieldPatterns: Partial<Record<ImportField, string>>;
  defaultValues?: Partial<Record<ImportField, string>>;
}

export type ParseRule = TabularExcelRule | MatrixExcelRule | TextParseRule;

export interface ParsedWorkbookSource {
  fileName: string;
  fileKind: FileKind;
  sheets: Array<{
    name: string;
    rows: string[][];
  }>;
  textContent?: string;
  sampleText: string;
}

export interface TemplateMapping {
  fingerprint: string;
  sheetName: string;
  headerRowIndex: number;
  columnMapping: Partial<Record<ImportField, number[]>>;
  headerNames: string[];
}

export interface WorkbookTemplateMatch {
  sheetName: string;
  headerRowIndex: number;
  headerNames: string[];
  mapping: Partial<Record<ImportField, number[]>>;
  fingerprint: string;
  confidence: number;
}

export interface ShipmentRecord {
  id: number;
  batchId: string;
  externalCode: string | null;
  storeName: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  recipientAddress: string | null;
  skuCode: string;
  skuName: string;
  skuQuantity: number;
  skuSpec: string | null;
  note: string | null;
  sourceRowNumber: number;
  sourceSheetName: string | null;
  createdAt: string;
}

export interface ImportBatchRecord {
  id: string;
  fileName: string;
  sheetName: string;
  templateFingerprint: string;
  totalCount: number;
  successCount: number;
  failureCount: number;
  status: "draft" | "processing" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
}
