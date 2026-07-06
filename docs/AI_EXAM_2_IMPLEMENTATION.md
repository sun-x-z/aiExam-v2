# AI 考试 2.0 改造点与技术实现

## 需求来源

- 需求文件：`E:\ai\exam2\考试要求-文件版本.html`
- 附件目录：`E:\ai\exam2\AI考试附件\demos`
- 本地实际附件：`1.xlsx`、`3.xlsx`、`4.pdf`、`2.json`
- 基础项目：`E:\work\aiExam`

## 核心改造点

1. **领域模型从 V1 运单切到 V2 出库单 SKU 明细**
   - 字段改为：外部编码、收货门店、收件人姓名/电话/地址、SKU 编码、SKU 名称、SKU 发货数量、SKU 规格、备注。
   - 校验规则改为：SKU 编码/名称/数量必填；门店模式或收件人模式二选一；数量必须为正数；电话格式校验；同批次外部编码 + SKU 去重。

2. **导入流程从自动模板匹配改为手动规则驱动**
   - 上传文件后不自动匹配规则。
   - 用户手动选择已保存规则，或点击“新建规则”生成草稿。
   - 规则必须经过用户编辑/确认，可试解析后保存。

3. **新增通用解析规则体系**
   - `tabular`：标准/非标准表格行映射，支持跳过头部、合计行停止、尾部键值提取、多列拼接。
   - `matrix`：SKU 行 + 门店/日期列矩阵转置，将有数量的单元格展开为多条 SKU 明细。
   - `textBlocks`：Word/PDF 文本块解析，支持按分隔符拆单、字段正则提取和 SKU 行正则分组映射。
   - 规则以 JSON 存储在 `parse_rules` 表，代码不依赖文件名判断。

4. **新增 AI 辅助生成规则接口**
   - `POST /api/parse-rules/generate`
   - 有 `AI_API_KEY` 时调用 OpenAI-compatible Chat Completions 生成规则。
   - 无密钥时启用本地启发式规则生成，保证本地开发流程可用。
   - AI 只生成可编辑规则，不直接解析下单数据。

5. **数据库升级**
   - 新增 `parse_rules` 表保存通用规则 JSON。
   - `shipments` 表新增 V2 字段：`store_name`、`sku_code`、`sku_name`、`sku_quantity`、`sku_spec`、`source_sheet_name`。
   - 唯一索引改为 `external_code + sku_code`，允许同一外部编码下多个 SKU。
   - 保留旧字段默认值，兼容旧表升级。

6. **前端工作台重构**
   - 保持 Next.js App Router + TypeScript。
   - 页面主色切为需求指定的 `#0fc6c2`。
   - 新增规则 JSON 编辑区、规则列表、AI 生成、保存、删除、试解析。
   - 预览表格支持横向滚动、分页渲染（每页 100 行）、单元格编辑、全量错误展示、导出 Excel、提交下单。

## 主要文件变更

- `lib/types.ts`：V2 字段、解析规则类型、历史记录类型。
- `lib/import/parse.ts`：文件读取、Excel 规则执行器、矩阵转置解析、文本块规则执行。
- `lib/server/document-extract.ts`：Word/PDF 服务端文本提取适配器。
- `lib/import/validation.ts`：V2 校验逻辑。
- `lib/server/ai-rules.ts`：AI/本地启发式规则生成。
- `lib/server/template-rules.ts`：解析规则 CRUD。
- `lib/server/shipments.ts`：V2 数据提交、查询、重复检测。
- `components/import-workspace.tsx`：规则驱动工作台。
- `database/schema.sql`、`lib/server/db.ts`：数据库结构和启动建表逻辑。

## API 说明

- `GET /api/parse-rules`：查询已保存解析规则。
- `POST /api/parse-rules`：保存或更新解析规则。
- `DELETE /api/parse-rules/:ruleId`：删除解析规则。
- `POST /api/parse-rules/generate`：基于文件样例生成推荐规则。
- `POST /api/import-source`：上传 Word/PDF 并提取文本源。
- `POST /api/import-batches`：创建导入批次。
- `POST /api/import-batches/:batchId/chunks`：分块提交明细。
- `GET /api/shipments`：历史运单分页查询。
- `POST /api/shipments/check-duplicates`：历史外部编码重复检测。

## 环境变量

数据库沿用原有配置：

```env
DATABASE_URL=
POSTGRES_URL_NON_POOLING=
POSTGRES_URL=
NEON_DATABASE_URL=
NEON_POSTGRES_URL=
```

AI 规则生成可选配置：

```env
AI_API_KEY=
AI_API_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
```

未配置 AI Key 时，系统会使用本地启发式生成规则草稿。

## 附件适配说明

- `1.xlsx`：可通过 `tabular` 规则表达，使用第 4 行表头、第 5 行起数据、合计行停止、尾部收货人/电话/地址键值提取。
- `3.xlsx`：可通过 `matrix` 规则表达，SKU 基础列映射，门店列横向转置为收货门店，数量单元格展开为明细。
- `4.pdf`：已接入轻量 PDF 文本流提取适配器，可进入 `textBlocks` 规则试解析；复杂扫描件、图片 PDF 或强表格结构建议后续替换为 `pdfjs-dist`/OCR 表格提取器。
- Word `.docx`：已接入轻量 ZIP/XML 文本提取适配器，可提取段落和表格单元格文本并进入 `textBlocks` 规则试解析。

## 后续增强建议

- 将当前轻量 PDF 适配器升级为 `pdfjs-dist` 或服务端 OCR/表格提取器，以提升复杂 PDF 表格准确率。
- 将当前轻量 DOCX XML 适配器升级为 `mammoth` 或同类库，以覆盖更多 Word 格式边界。
- 为规则 JSON 增加表单化编辑器，减少用户直接编辑 JSON 的成本。
- 对 1000+ 行继续升级为虚拟滚动表格；当前版本采用 100 行分页避免一次性渲染过重。

## 验证记录

- TypeScript：`npx tsc --noEmit --incremental false` 已通过。
- 构建：`npm run build` 已通过。
- 依赖说明：曾尝试安装 `mammoth` / `pdf-parse`，但当前机器因 `ENOSPC` 磁盘空间不足失败；因此本次先采用 Node 内置 `zlib` 的轻量 DOCX/PDF 提取适配器，无新增 npm 依赖。
