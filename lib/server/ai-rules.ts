import type { CellSelector, ImportField, ParsedWorkbookSource, ParseRule, TabularExcelRule } from "@/lib/types";
import { FIELD_ALIASES, IMPORT_FIELDS } from "@/lib/import/constants";
import { normalizeText } from "@/lib/import/normalize";

type GenerateResult = {
  rule: ParseRule;
  source: "llm" | "heuristic";
};

const AI_TIMEOUT_MS = 30000;

function normalizeSource(source: ParsedWorkbookSource): ParsedWorkbookSource {
  return {
    ...source,
    sheets: source.sheets.slice(0, 5).map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.slice(0, 40).map((row) => row.slice(0, 60)),
    })),
  };
}

function scoreCellForField(cell: string, field: ImportField) {
  const normalized = normalizeText(cell);
  if (!normalized) return 0;
  return FIELD_ALIASES[field].reduce((best, alias) => {
    const normalizedAlias = normalizeText(alias);
    if (!normalizedAlias) return best;
    if (normalized === normalizedAlias) return Math.max(best, 10);
    if (normalized.includes(normalizedAlias) || normalizedAlias.includes(normalized)) return Math.max(best, 8);
    return best;
  }, 0);
}

function detectHeader(rows: string[][]) {
  let best = { index: 0, score: 0, mapping: {} as Partial<Record<ImportField, CellSelector>> };

  rows.slice(0, 20).forEach((row, rowIndex) => {
    const mapping: Partial<Record<ImportField, CellSelector>> = {};
    let score = 0;
    row.forEach((cell, columnIndex) => {
      let bestField: ImportField | null = null;
      let bestScore = 0;
      for (const field of IMPORT_FIELDS) {
        const fieldScore = scoreCellForField(cell, field);
        if (fieldScore > bestScore) {
          bestScore = fieldScore;
          bestField = field;
        }
      }
      if (bestField && bestScore > 0 && !mapping[bestField]) {
        mapping[bestField] = { type: "column", index: columnIndex };
        score += bestScore;
      }
    });

    if (score > best.score) {
      best = { index: rowIndex, score, mapping };
    }
  });

  return best;
}

function isPositiveNumber(value: string) {
  const number = Number(String(value || "").trim());
  return Number.isFinite(number) && number > 0;
}

function detectMatrixRule(source: ParsedWorkbookSource, headerIndex: number, mapping: Partial<Record<ImportField, CellSelector>>): ParseRule | null {
  const sheet = source.sheets[0];
  if (!sheet) return null;

  const header = sheet.rows[headerIndex] || [];
  const mappedColumns = new Set(
    Object.values(mapping)
      .filter((selector): selector is Extract<CellSelector, { type: "column" }> => selector?.type === "column")
      .map((selector) => selector.index)
  );
  const lastMapped = Math.max(...Array.from(mappedColumns.values()), -1);
  const candidates: number[] = [];

  for (let column = lastMapped + 1; column < header.length; column += 1) {
    if (!String(header[column] || "").trim()) continue;
    const hitCount = sheet.rows.slice(headerIndex + 1, headerIndex + 30).filter((row) => isPositiveNumber(row[column])).length;
    if (hitCount > 0) candidates.push(column);
  }

  if (candidates.length < 2 || !mapping.skuName || !mapping.skuCode) return null;

  return {
    name: `${source.fileName.replace(/\.[^.]+$/, "")} - 矩阵转置规则`,
    description: "AI/启发式识别：SKU 行 + 门店列矩阵，按有数量的门店列展开为 SKU 明细。",
    kind: "matrix",
    fileKind: "excel",
    sheetMode: { type: "first" },
    headerRowIndex: headerIndex,
    dataStartRowIndex: headerIndex + 1,
    itemMapping: {
      skuCode: mapping.skuCode,
      skuName: mapping.skuName,
      skuSpec: mapping.skuSpec,
    },
    matrix: {
      firstColumnIndex: candidates[0],
      lastColumnIndex: candidates[candidates.length - 1],
      quantityField: "skuQuantity",
      columnHeaderField: "storeName",
      externalCodeTemplate: "${columnHeader}",
    },
    skipRowsContaining: ["合计", "小计"],
    aiGenerated: true,
    confidence: 80,
    aiNotes: ["门店列为启发式判断，请确认第一列和最后一列是否准确。"],
  };
}

function makeHeuristicRule(source: ParsedWorkbookSource): ParseRule {
  if (source.fileKind !== "excel") {
    return {
      name: `${source.fileName} - 文本块规则草稿`,
      description: "基于 Word/PDF 文本提取适配器的文本块规则，按分隔符拆单并用正则提取字段和 SKU 行。",
      kind: "textBlocks",
      fileKind: source.fileKind === "pdf" || source.fileKind === "word" ? source.fileKind : "text",
      blockSeparatorPattern: "(-{3,}|━{3,}|配送单|签收单)",
      itemLinePattern: "(?:\\d+[.、]\\s*)?([A-Za-z0-9_-]{2,})\\s*[|,，\\s]+([^|,，\\n]+?)\\s*[|,，\\s]+([^|,，\\n]*?)\\s*[|,，\\s]+(\\d+(?:\\.\\d+)?)",
      itemFieldGroups: {
        skuCode: 1,
        skuName: 2,
        skuSpec: 3,
        skuQuantity: 4,
      },
      fieldPatterns: {
        externalCode: "(?:单号|外部编码)[:：]\\s*(\\S+)",
        storeName: "(?:门店|收货机构)[:：]\\s*(.+)",
        recipientName: "(?:收货人|收件人)[:：]\\s*(\\S+)",
        recipientPhone: "(?:电话|手机)[:：]\\s*([0-9+\\-() ]+)",
        recipientAddress: "(?:地址)[:：]\\s*(.+)",
      },
      defaultValues: {},
      aiGenerated: true,
      confidence: source.textContent ? 60 : 40,
      aiNotes: ["已接入轻量文本提取适配器；复杂 PDF 表格建议后续替换为 pdfjs/OCR 表格提取。"],
    };
  }

  const sheet = source.sheets[0];
  const detected = detectHeader(sheet?.rows || []);
  const matrixRule = detectMatrixRule(source, detected.index, detected.mapping);
  if (matrixRule) return matrixRule;

  const rule: TabularExcelRule = {
    name: `${source.fileName.replace(/\.[^.]+$/, "")} - 表格映射规则`,
    description: "AI/启发式识别：标准表格行映射，支持头部跳过、合计行跳过和尾部键值提取。",
    kind: "tabular",
    fileKind: "excel",
    sheetMode: { type: "first" },
    headerRowIndex: detected.index,
    dataStartRowIndex: detected.index + 1,
    stopWhenFirstColumnMatches: ["合计", "小计"],
    skipRowsContaining: ["合计", "小计"],
    fieldMapping: detected.mapping,
    footerPairs: [
      { label: "单据号", field: "externalCode" },
      { label: "配送单号", field: "externalCode" },
      { label: "收货机构", field: "storeName" },
      { label: "门店", field: "storeName" },
      { label: "收货人", field: "recipientName" },
      { label: "收件人", field: "recipientName" },
      { label: "收货电话", field: "recipientPhone" },
      { label: "收件人电话", field: "recipientPhone" },
      { label: "收货地址", field: "recipientAddress" },
      { label: "收件人地址", field: "recipientAddress" },
    ],
    aiGenerated: true,
    confidence: Math.min(95, Math.max(50, detected.score)),
    aiNotes: ["字段映射由表头别名推断，尾部收货信息需在试解析中确认。"],
  };

  return rule;
}

async function callLlmForRule(source: ParsedWorkbookSource) {
  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) return null;

  const baseUrl = (process.env.AI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.AI_MODEL || "gpt-4.1-mini";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你是批量出库单导入系统的解析规则生成器。只输出 JSON，字段必须是 {\"rule\": ParseRule}。不要直接解析业务数据，只生成可编辑规则。规则只能使用 tabular、matrix 或 textBlocks。",
          },
          {
            role: "user",
            content: JSON.stringify({
              targetFields: IMPORT_FIELDS,
              source: normalizeSource(source),
              ruleSchemaHint:
                "tabular: Excel 表格行映射; matrix: SKU 行 + 门店/日期列转置; textBlocks: Word/PDF 文本块。字段选择器支持 column/columns/static/sheetName/matrixColumnHeader。",
            }),
          },
        ],
      }),
    });

    if (!response.ok) return null;
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { rule?: ParseRule };
    if (!parsed.rule?.name || !parsed.rule.kind) return null;
    return { ...parsed.rule, aiGenerated: true, confidence: parsed.rule.confidence ?? 80 } satisfies ParseRule;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateParseRule(source: ParsedWorkbookSource): Promise<GenerateResult> {
  const normalized = normalizeSource(source);
  const llmRule = await callLlmForRule(normalized);
  if (llmRule) return { rule: llmRule, source: "llm" };
  return { rule: makeHeuristicRule(normalized), source: "heuristic" };
}
