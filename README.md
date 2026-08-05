# AI Exam V2 - 运单导入与主数据服务

`E:\work\aiExam-v2` 是独立 V2 系统项目。它负责文件读取、解析规则、异步导入、运单主数据沉淀、导入监控和对 V3 暴露 HTTP 运单合同。

V3 异常审批和品控联动系统位于 `E:\work\aiExam`。V2 不包含 V3 工单、审批、赔付或库存联动业务；V3 通过 `V2_API_BASE_URL` 调用本项目的 `/api/v1`。

## 项目边界

- V2 首页：`/`
- 导入工作台：上传、规则选择/生成、试解析、预览、提交
- 异步任务：`import_tasks`、`import_task_rows`、`import_task_batches`
- 可靠事件：`event_outbox`
- Worker：批量校验、批量 SKU 查询、批量 UPSERT
- 观测：行级错误、批次性能日志、Trace 时间线、监控聚合
- V3 HTTP 合同：`/api/v1/waybills/*`，兼容保留 `/api/v2/waybills/*`

不属于本项目：

- V3 异常工单状态机；
- V3 品控暂扣、分级审批、赔付、库存联动；
- V3 `v3_*` 表和 `/api/v3/*`。

## 本地启动

```powershell
npm install
npm run dev
```

打开 `http://127.0.0.1:3001`。

V3 本地联调时配置：

```env
V2_API_BASE_URL=http://127.0.0.1:3001/api/v1
V2_API_KEY=local-dev-v2-key
```

## 环境变量

至少配置一个 PostgreSQL 连接变量：

- `DATABASE_URL`
- `POSTGRES_URL_NON_POOLING`
- `POSTGRES_URL`
- `NEON_DATABASE_URL`
- `NEON_POSTGRES_URL`

可选 AI 规则生成：

- `AI_API_KEY`
- `AI_API_BASE_URL=https://api.openai.com/v1`
- `AI_MODEL=gpt-4.1-mini`

异步导入：

- `IMPORT_BATCH_SIZE=1000`
- `IMPORT_WORKER_BATCH_LIMIT=2`
- `IMPORT_FORCE_SKU_DEGRADED=0`

V3 合同鉴权：

- `V2_API_KEY=local-dev-v2-key`

## 交互流程

1. 用户在 V2 上传 Excel、Word、PDF 或文本文件。
2. 用户选择已有解析规则，或生成/编辑规则草稿。
3. 前端试解析并展示行级校验结果，用户确认后提交。
4. `POST /api/import-tasks` 在一个事务内创建任务、行、批次和 Outbox。
5. Dispatcher 将 Outbox 事件转为可消费批次。
6. Worker 抢占批次，批量本地校验、批量查询 `sku_master`、批量 UPSERT `shipments`。
7. 前端每 2 秒轮询任务进度、错误明细、批次状态、监控和 Trace。
8. V3 通过 `/api/v1/waybills/*` 实时读取 V2 运单和 SKU 主数据。

## 主要 API

- `POST /api/import-tasks`
- `GET /api/import-tasks/:taskId`
- `GET /api/import-tasks/:taskId/errors`
- `GET /api/import-tasks/:taskId/batches`
- `POST /api/import-dispatcher/tick`
- `POST /api/import-worker/tick`
- `GET /api/import-monitor/summary`
- `GET /api/traces/:traceId`
- `GET /api/v1/waybills`
- `GET /api/v1/waybills/:waybillNo`
- `GET /api/v1/waybills/:waybillNo/skus/:skuCode`

## 压测与验收

```powershell
npm run seed:perf
npm run loadtest:import
```

`seed:perf` 生成 `test-data/10000-orders.xlsx`，并在配置数据库时写入 20,000 条 `sku_master`。

`loadtest:import` 上传 10,000 行压测文件，触发 Worker tick，轮询任务完成并输出上传耗时、总耗时、成功/失败行数和 60 秒目标是否达成。

## 验证

```powershell
npm run typecheck
npm run build
```
