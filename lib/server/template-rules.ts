import type { ParseRule, TemplateMapping } from "@/lib/types";
import { query } from "@/lib/server/db";

export async function listParseRules() {
  const result = await query<{
    id: string;
    name: string;
    description: string | null;
    file_kind: ParseRule["fileKind"];
    rule: ParseRule;
    ai_generated: boolean;
    confidence: number | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, name, description, file_kind, rule, ai_generated, confidence, created_at, updated_at
     FROM public.parse_rules
     ORDER BY updated_at DESC, id DESC`
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description || "",
    fileKind: row.file_kind,
    rule: row.rule,
    aiGenerated: row.ai_generated,
    confidence: row.confidence ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function saveParseRule(rule: ParseRule, id?: string) {
  const result = await query<{
    id: string;
    name: string;
    description: string | null;
    file_kind: ParseRule["fileKind"];
    rule: ParseRule;
    ai_generated: boolean;
    confidence: number | null;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO public.parse_rules (id, name, description, file_kind, rule, ai_generated, confidence, updated_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5::jsonb, $6, $7, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       file_kind = EXCLUDED.file_kind,
       rule = EXCLUDED.rule,
       ai_generated = EXCLUDED.ai_generated,
       confidence = EXCLUDED.confidence,
       updated_at = NOW()
     RETURNING id, name, description, file_kind, rule, ai_generated, confidence, created_at, updated_at`,
    [
      id || rule.id || null,
      rule.name,
      rule.description || "",
      rule.fileKind,
      JSON.stringify(rule),
      Boolean(rule.aiGenerated),
      Number(rule.confidence ?? 0),
    ]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    fileKind: row.file_kind,
    rule: row.rule,
    aiGenerated: row.ai_generated,
    confidence: row.confidence ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function deleteParseRule(id: string) {
  await query(`DELETE FROM public.parse_rules WHERE id = $1`, [id]);
}

export async function getTemplateRule(fingerprint: string) {
  const result = await query<{
    id: number;
    fingerprint: string;
    sheet_name: string;
    header_row_index: number;
    column_mapping: Record<string, number[]>;
    header_names: string[];
    confidence: number;
  }>(
    `SELECT id, fingerprint, sheet_name, header_row_index, column_mapping, header_names, confidence
     FROM public.template_rules
     WHERE fingerprint = $1
     LIMIT 1`,
    [fingerprint]
  );

  const row = result.rows[0];
  if (!row) return null;

  const mapping: TemplateMapping = {
    fingerprint: row.fingerprint,
    sheetName: row.sheet_name,
    headerRowIndex: row.header_row_index,
    columnMapping: row.column_mapping as TemplateMapping["columnMapping"],
    headerNames: row.header_names,
  };

  return {
    ...mapping,
    confidence: row.confidence,
  };
}

export async function saveTemplateRule(rule: TemplateMapping, confidence = 0) {
  await query(
    `INSERT INTO public.template_rules (fingerprint, sheet_name, header_row_index, column_mapping, header_names, confidence, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, NOW())
     ON CONFLICT (fingerprint) DO UPDATE SET
       sheet_name = EXCLUDED.sheet_name,
       header_row_index = EXCLUDED.header_row_index,
       column_mapping = EXCLUDED.column_mapping,
       header_names = EXCLUDED.header_names,
       confidence = EXCLUDED.confidence,
       updated_at = NOW()`,
    [rule.fingerprint, rule.sheetName, rule.headerRowIndex, JSON.stringify(rule.columnMapping), JSON.stringify(rule.headerNames), confidence]
  );
}
